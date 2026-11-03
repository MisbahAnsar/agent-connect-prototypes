import type { AgentClient, GrantClient } from "../agent-api/types";
import { AgentApiError, PriceUnavailableError } from "../errors";
import { buildSealedPolicy } from "../policy/policy";
import { portfolioValueMicroUsd } from "../risk/pricing";
import { principalKey, shouldBankPrincipal } from "../risk/trigger";
import { EventLog } from "./events";
import type { StateStore } from "./store";

export type RunnerConfig = {
  client: Pick<AgentClient, "getTokens" | "getStatus" | "getPolicy" | "updatePolicy">;
  grant: GrantClient;
  agentId: string;
  asset: string;
  /** The stake in the asset's atomic units; the exact amount that gets banked. */
  principalAtomic: bigint;
  /** The stake valued in micro-USD (fixed when the owner funded the agent). */
  principalMicroUsd: bigint;
  chain: string;
  safeAddress: string;
  store: StateStore;
  log?: EventLog;
  now?: () => Date;
  /** Equity/principal ratio that triggers banking. 2 = gains equal principal. */
  multiple?: bigint;
  /** Basis-point form of `multiple` (20_000 = 2x); wins when both are set. */
  multipleBps?: bigint;
  /**
   * After the exit settles, update the policy to drop `withdraw` so no grant can withdraw again.
   * Off by default: it is an owner-signed policy change and departs from the original spec.
   */
  sealAfterSettlement?: boolean;
};

export class HouseMoneyRunner {
  readonly log: EventLog;
  private now: () => Date;

  constructor(private cfg: RunnerConfig) {
    this.log = cfg.log ?? new EventLog();
    this.now = cfg.now ?? (() => new Date());
  }

  private at() {
    return this.now().toISOString();
  }

  /** One pass: bank the principal if covered, otherwise report on a queued exit. */
  async tick(): Promise<void> {
    const state = await this.cfg.store.load();
    if (state.banked) return this.reportSettlement(state);

    let equity: bigint;
    let held: bigint;
    try {
      const [{ balances }, tokens] = await Promise.all([
        this.cfg.grant.getBalances(this.cfg.agentId),
        this.cfg.client.getTokens(),
      ]);
      equity = portfolioValueMicroUsd(balances, tokens, this.now());
      held = BigInt(balances[this.cfg.asset] ?? "0");
    } catch (e) {
      if (e instanceof PriceUnavailableError) {
        this.log.emit({ type: "price_unavailable", at: this.at(), assetId: e.assetId, reason: e.message });
        return; // fail closed: never act on unpriced equity
      }
      throw e;
    }

    const principal = this.cfg.principalMicroUsd;
    this.log.emit({ type: "tick", at: this.at(), equityMicroUsd: equity.toString(), principalMicroUsd: principal.toString() });
    if (!state.triggered) {
      if (!shouldBankPrincipal({ equity, principal, banked: false, multiple: this.cfg.multiple, multipleBps: this.cfg.multipleBps })) return;
      this.log.emit({ type: "trigger", at: this.at(), equityMicroUsd: equity.toString(), principalMicroUsd: principal.toString() });
      await this.cfg.store.save({ ...state, triggered: true });
    }

    // Gains held in another asset cannot be withdrawn as the stake: wait until the trader has raised the cash.
    if (held < this.cfg.principalAtomic) {
      this.log.emit({ type: "awaiting_cash", at: this.at(), heldAtomic: held.toString(), neededAtomic: this.cfg.principalAtomic.toString() });
      return;
    }
    try {
      // Withdraw first, persist second: a crash in between retries under the same key and replays.
      const op = await this.cfg.grant.withdraw(
        this.cfg.agentId,
        { asset: this.cfg.asset, amount: this.cfg.principalAtomic.toString(), chain: this.cfg.chain, recipient: this.cfg.safeAddress },
        { idempotencyKey: principalKey(this.cfg.agentId) },
      );
      await this.cfg.store.save({ ...state, triggered: true, banked: true, withdrawalId: op.correlation_id, bankedAt: this.at() });
      this.log.emit({ type: "withdraw_queued", at: this.at(), correlationId: op.correlation_id, executeAfter: op.execute_after });
    } catch (e) {
      if (e instanceof AgentApiError) {
        this.log.emit({ type: "refused", at: this.at(), code: e.code });
        return; // not banked; next tick re-evaluates
      }
      throw e;
    }
  }

  private async reportSettlement(state: Awaited<ReturnType<StateStore["load"]>>) {
    if (!state.settledReported && state.withdrawalId) {
      const op = await this.cfg.client.getStatus(state.withdrawalId);
      if (op.status === "SUCCESS") {
        this.log.emit({ type: "withdraw_settled", at: this.at(), correlationId: op.correlation_id });
        state = { ...state, settledReported: true, exitSettled: true };
      } else if (op.status === "FAILED" || op.status === "CANCELLED") {
        this.log.emit({ type: "withdraw_failed", at: this.at(), correlationId: op.correlation_id, failureCode: op.failure_code ?? op.status });
        state = { ...state, settledReported: true };
      } else {
        return;
      }
      await this.cfg.store.save(state);
    }
    if (this.cfg.sealAfterSettlement && state.exitSettled && !state.sealed) await this.seal(state);
  }

  /** Retried on later ticks when the API's 10-minute policy-change cooldown refuses it. */
  private async seal(state: Awaited<ReturnType<StateStore["load"]>>) {
    try {
      const { policy, revision } = await this.cfg.client.getPolicy(this.cfg.agentId);
      if (policy && revision !== null && policy.actions.includes("withdraw")) {
        const next = await this.cfg.client.updatePolicy(this.cfg.agentId, buildSealedPolicy(policy), revision);
        this.log.emit({ type: "policy_sealed", at: this.at(), revision: next.revision });
      }
      await this.cfg.store.save({ ...state, sealed: true });
    } catch (e) {
      if (e instanceof AgentApiError) {
        this.log.emit({ type: "seal_deferred", at: this.at(), code: e.code });
        return;
      }
      throw e;
    }
  }

  /** Poll until aborted. Errors are logged and retried with capped exponential backoff. */
  async run(intervalMs: number, signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        await this.tick();
        failures = 0;
      } catch (e) {
        failures++;
        this.log.emit({ type: "error", at: this.at(), message: e instanceof Error ? e.message : String(e) });
      }
      const wait = Math.min(intervalMs * 2 ** Math.min(failures, 5), 60_000);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, wait);
        signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });
    }
  }
}
