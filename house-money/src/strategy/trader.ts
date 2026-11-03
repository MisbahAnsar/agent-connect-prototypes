import type { AgentClient, GrantClient, SwapRequest } from "../agent-api/types";
import { AgentApiError, PriceUnavailableError } from "../errors";
import { MICRO, portfolioValueMicroUsd, usdToMicro } from "../risk/pricing";
import { shouldBankPrincipal } from "../risk/trigger";
import type { EventLog } from "../runner/events";
import type { StateStore } from "../runner/store";
import { makePriceFn } from "./types";
import type { Strategy } from "./types";

export type TraderConfig = {
  client: Pick<AgentClient, "getTokens" | "getStatus">;
  grant: GrantClient;
  agentId: string;
  /** The stake asset (what the principal is denominated and banked in). */
  stableAsset: string;
  riskAsset: string;
  principalAtomic: bigint;
  principalMicroUsd: bigint;
  strategy: Strategy;
  store: StateStore;
  log: EventLog;
  now?: () => Date;
  /** Equity/principal ratio at which the runner banks. Matches the runner's `multiple`. */
  multiple?: bigint;
  multipleBps?: bigint;
  /** Largest stake-asset amount per swap (the policy's per-transaction cap). */
  maxStableSwap?: bigint;
  /**
   * Worst fill accepted versus the quote, in basis points. Default 100 (1%). The swap runs after the
   * policy timelock and is priced then, so size this to the market's move over that delay or every swap
   * fails with the min-output check.
   */
  slippageBps?: bigint;
};

const DUST_MICRO_USD = 1_000_000n; // do not trade amounts under $1

/**
 * The trading half of the agent. It decides, quotes, and swaps through the grant; it never touches the
 * safe account. Two rules keep it from fighting the principal exit:
 *  1. When equity reaches the trigger it stops trading for the market and converts the position into the
 *     stake asset, so the principal can be withdrawn (the exit needs that balance when the withdrawal is
 *     requested and again when the timelock releases it).
 *  2. While the exit is queued, the stake-asset balance it needs is reserved and never swapped away.
 */
export class Trader {
  private pending: { id: string } | null = null;
  private seq = 0;
  private readonly now: () => Date;

  constructor(private cfg: TraderConfig) {
    this.now = cfg.now ?? (() => new Date());
  }

  private at() {
    return this.now().toISOString();
  }

  async step(): Promise<void> {
    const { cfg } = this;
    if (this.pending && !(await this.settlePending())) return; // one swap in flight at a time

    let balances: Record<string, string>;
    let tokens;
    let equity: bigint;
    try {
      [{ balances }, tokens] = await Promise.all([cfg.grant.getBalances(cfg.agentId), cfg.client.getTokens()]);
      equity = portfolioValueMicroUsd(balances, tokens, this.now());
    } catch (e) {
      if (e instanceof PriceUnavailableError) {
        cfg.log.emit({ type: "price_unavailable", at: this.at(), assetId: e.assetId, reason: e.message });
        return;
      }
      throw e;
    }
    const risk = tokens.find((t) => t.asset_id === cfg.riskAsset);
    const stable = tokens.find((t) => t.asset_id === cfg.stableAsset);
    if (!risk || risk.price === null || !stable || stable.price === null) return;

    const target = await cfg.strategy.decide({
      agentId: cfg.agentId,
      stakeAsset: cfg.stableAsset,
      riskAsset: cfg.riskAsset,
      balances,
      tokens,
      price: makePriceFn(tokens, this.now()),
      equityMicroUsd: equity,
    });
    const state = await cfg.store.load();
    const stableBal = BigInt(balances[cfg.stableAsset] ?? "0");
    const riskBal = BigInt(balances[cfg.riskAsset] ?? "0");
    const riskPriceMicro = usdToMicro(risk.price);
    const riskToMicro = (a: bigint) => (a * riskPriceMicro) / 10n ** BigInt(risk.decimals);
    const stableToMicro = (a: bigint) => (a * usdToMicro(stable.price!)) / 10n ** BigInt(stable.decimals);

    const exitPending = state.banked && !state.exitSettled && !state.settledReported;
    const reserve = exitPending ? cfg.principalAtomic : 0n;
    const triggered = !state.banked && (state.triggered === true || shouldBankPrincipal({ equity, principal: cfg.principalMicroUsd, banked: false, multiple: cfg.multiple, multipleBps: cfg.multipleBps }));

    let req: SwapRequest | null = null;
    let reason: "trend" | "raise_cash" = "trend";

    if (triggered) {
      // The swap is priced when its timelock releases, so a market that is moving can shortchange any
      // partial sale. Sell the whole position: the stake must be whole in the stake asset, and the
      // trend logic buys the rest back once the exit is queued and its reserve is held.
      if (stableBal < cfg.principalAtomic && riskBal > 0n) {
        reason = "raise_cash";
        req = { origin_asset: cfg.riskAsset, destination_asset: cfg.stableAsset, amount: riskBal.toString() };
      }
    } else if (target === "risk") {
      let buy = stableBal - reserve;
      if (cfg.maxStableSwap !== undefined && buy > cfg.maxStableSwap) buy = cfg.maxStableSwap;
      if (buy > 0n && stableToMicro(buy) >= DUST_MICRO_USD) req = { origin_asset: cfg.stableAsset, destination_asset: cfg.riskAsset, amount: buy.toString() };
    } else if (riskBal > 0n && riskToMicro(riskBal) >= DUST_MICRO_USD) {
      req = { origin_asset: cfg.riskAsset, destination_asset: cfg.stableAsset, amount: riskBal.toString() };
    }
    if (!req) return;

    try {
      const { amountOut } = await cfg.grant.quote(cfg.agentId, req);
      const minOut = (BigInt(amountOut) * (10_000n - (cfg.slippageBps ?? 100n))) / 10_000n;
      const op = await cfg.grant.swap(cfg.agentId, { ...req, min_amount_out: minOut.toString() }, { idempotencyKey: `swap:${cfg.agentId}:${++this.seq}` });
      cfg.log.emit({ type: "swap_queued", at: this.at(), correlationId: op.correlation_id, from: req.origin_asset, to: req.destination_asset, amountIn: req.amount, executeAfter: op.execute_after, reason });
      if (op.status === "QUEUED" || op.status === "PROCESSING") this.pending = { id: op.correlation_id };
      else this.report(op.correlation_id, op.status, op.swap?.amountOut, op.failure_code);
    } catch (e) {
      if (e instanceof AgentApiError) {
        cfg.log.emit({ type: "refused", at: this.at(), code: e.code });
        return;
      }
      throw e;
    }
  }

  /** True once the in-flight swap has reached a final state. */
  private async settlePending(): Promise<boolean> {
    const op = await this.cfg.client.getStatus(this.pending!.id);
    if (op.status === "QUEUED" || op.status === "PROCESSING") return false;
    this.report(op.correlation_id, op.status, op.swap?.amountOut, op.failure_code);
    this.pending = null;
    return true;
  }

  private report(correlationId: string, status: string, amountOut?: string, failureCode?: string) {
    if (status === "SUCCESS") this.cfg.log.emit({ type: "swap_settled", at: this.at(), correlationId, amountOut });
    else this.cfg.log.emit({ type: "swap_failed", at: this.at(), correlationId, failureCode: failureCode ?? status });
  }
}

export { MICRO };
