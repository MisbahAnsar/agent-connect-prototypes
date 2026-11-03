import type { AgentClient, GrantClient } from "./agent-api/types";
import { FileStateStore } from "./runner/file-store";
import { EventLog } from "./runner/events";
import { HouseMoneyRunner } from "./runner/runner";
import { MemoryStateStore, type StateStore } from "./runner/store";
import { Trader } from "./strategy/trader";
import type { Strategy } from "./strategy/types";

/** The house-money principal exit, optionally layered onto the trading loop. */
export type HouseConfig = {
  /** Exactly the owner's stake, atomic units. */
  principalAtomic: bigint;
  /** The stake valued in micro-USD (fixed when the agent was funded). */
  principalMicroUsd: bigint;
  /** Destination chain + address the principal may ever be withdrawn to. */
  chain: string;
  safeAddress: string;
  /** Exit trigger in basis points: 20_000 = equity 2x principal (gains == principal). */
  multipleBps?: bigint;
  /** After settlement, drop `withdraw` from the policy so no grant can withdraw again. */
  sealAfterSettlement?: boolean;
  /** Defaults to `.state/<agentId>.runner.json` (crash-safe). */
  store?: StateStore;
};

export type TradingLoopConfig = {
  client: Pick<AgentClient, "getTokens" | "getStatus" | "getPolicy" | "updatePolicy">;
  grant: GrantClient;
  agentId: string;
  /** The stake asset (deposits arrive here; the principal is banked in it). */
  stakeAsset: string;
  /** The asset the strategy may trade into. */
  riskAsset: string;
  strategy: Strategy;
  /** Tick cadence. Default 30s. */
  intervalMs?: number;
  log?: EventLog;
  signal?: AbortSignal;
  now?: () => Date;
  /** Omit for a pure trading loop; include to bank the principal once gains cover it. */
  house?: HouseConfig;
};

/**
 * The use case in one call: every tick, price the portfolio, ask the strategy which side of the
 * pair to hold, quote and swap through the grant — and, with `house`, withdraw the principal to
 * the safe address exactly once equity covers it. After that everything is house money.
 */
export async function runTradingLoop(cfg: TradingLoopConfig): Promise<void> {
  const log = cfg.log ?? new EventLog();
  const interval = cfg.intervalMs ?? 30_000;
  const store = cfg.house
    ? (cfg.house.store ?? new FileStateStore(`.state/${cfg.agentId}.runner.json`))
    : new MemoryStateStore();

  const runner = cfg.house
    ? new HouseMoneyRunner({
        client: cfg.client,
        grant: cfg.grant,
        agentId: cfg.agentId,
        asset: cfg.stakeAsset,
        principalAtomic: cfg.house.principalAtomic,
        principalMicroUsd: cfg.house.principalMicroUsd,
        chain: cfg.house.chain,
        safeAddress: cfg.house.safeAddress,
        store,
        log,
        now: cfg.now,
        multipleBps: cfg.house.multipleBps,
        sealAfterSettlement: cfg.house.sealAfterSettlement,
      })
    : null;

  const trader = new Trader({
    client: cfg.client,
    grant: cfg.grant,
    agentId: cfg.agentId,
    stableAsset: cfg.stakeAsset,
    riskAsset: cfg.riskAsset,
    principalAtomic: cfg.house?.principalAtomic ?? 0n,
    principalMicroUsd: cfg.house?.principalMicroUsd ?? 0n,
    strategy: cfg.strategy,
    store,
    log,
    now: cfg.now,
    multipleBps: cfg.house?.multipleBps,
    // keep every swap within the principal's size; the policy caps it further
    maxStableSwap: cfg.house?.principalAtomic,
    // the policy timelock re-prices the swap at release; 10% is the demo default
    slippageBps: 1_000n,
  });

  let failures = 0;
  while (!cfg.signal?.aborted) {
    try {
      await trader.step();
      await runner?.tick();
      failures = 0;
    } catch (e) {
      failures++;
      log.emit({ type: "error", at: new Date().toISOString(), message: e instanceof Error ? e.message : String(e) });
    }
    const wait = Math.min(interval * 2 ** Math.min(failures, 5), 60_000);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, wait);
      cfg.signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });
  }
}
