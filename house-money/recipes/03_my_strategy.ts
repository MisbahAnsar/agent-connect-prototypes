/**
 * Recipe 3 — YOUR trading strategy. Copy this file, keep the boilerplate, replace the strategy.
 *
 *   npm run provision   (once, then fund the printed address)
 *   npm run recipe:3
 *
 * The contract is one method:
 *   decide(ctx) → "risk" | "stable"
 *
 * The wrapper does the rest: it prices the portfolio (fail-closed), asks you which side of the
 * stake/risk pair to sit on, then quotes, guards slippage, sizes the swap, respects the policy
 * and never fights the principal exit (recipe 2's `house` option). Pure decision, handled execution.
 */
import { loadDotEnv, networkFromEnv } from "../src/config";
import { LiveAgentApi } from "../src/agent-api/live";
import { EventLog } from "../src/runner/events";
import { ownerFromEnvOrState, loadProvisioned } from "../src/state";
import { runTradingLoop } from "../src/loop";
import type { Strategy, StrategyContext, StrategyTarget } from "../src/strategy/types";

// ─────────────────────────────────────────────────────────────────────────
// YOUR TRADING STRATEGY HERE
//
// Example below: a dip buyer — hold the risk asset after a sharp drop (mean reversion),
// back to the stake asset once price recovers to its recent high. State stays in the class;
// decide() is called once per tick (every 30s here).
// ─────────────────────────────────────────────────────────────────────────
class DipBuyer implements Strategy {
  private high: number | null = null;
  private cooldownUntil = 0;
  constructor(private dropPct = 0.05, private cooldownMs = 10 * 60_000) {}

  decide(ctx: StrategyContext): StrategyTarget {
    const p = ctx.price(ctx.riskAsset);
    this.high = this.high === null ? p : Math.max(this.high, p);

    // a balance-based example: skip entries while a withdrawal (recipe 2) is waiting for cash
    const holdingStake = BigInt(ctx.balances[ctx.stakeAsset] ?? "0") > 0n;

    if (p <= this.high * (1 - this.dropPct) && holdingStake && Date.now() >= this.cooldownUntil) {
      this.cooldownUntil = Date.now() + this.cooldownMs;
      return "risk";
    }
    if (p >= this.high) return "stable"; // recovered: take the gain back into the stake asset
    return "risk"; // keep riding the recovery
  }
}

// ── boilerplate: wire the provisioned agent to the loop ───────────────────
loadDotEnv();
const state = await loadProvisioned();
const net = networkFromEnv();

if (!state.riskAsset) {
  console.error("No risk asset provisioned — set HOUSE_RISK_ASSET (or HOUSE_RISK_ASSET_SYMBOL) and re-run `npm run provision`.");
  process.exit(2);
}
if (net.name === "mainnet" && process.env.HOUSE_CONFIRM !== "spend-real-funds") {
  console.error("Mainnet: this recipe trades real funds. Re-run with HOUSE_CONFIRM=spend-real-funds to proceed.");
  process.exit(2);
}

const live = new LiveAgentApi({ apiKey: state.apiKey, baseUrl: state.baseUrl, owner: ownerFromEnvOrState(), balancesSource: net.balancesSource });
const grant = live.forGrant(state.grantToken);
const log = new EventLog();
log.subscribe((e) => e.type !== "tick" && console.log(new Date().toISOString(), JSON.stringify(e)));

const abort = new AbortController();
process.on("SIGINT", () => {
  console.log("\nStopping. The policy stays in force; the grant expires on its own.");
  abort.abort();
});

console.log(`Trading ${state.stakeSymbol} ↔ ${state.riskSymbol} on ${state.agentId} (${net.name}). Strategy: DipBuyer.`);

await runTradingLoop({
  client: live,
  grant,
  agentId: state.agentId,
  stakeAsset: state.stakeAsset,
  riskAsset: state.riskAsset,
  strategy: new DipBuyer(),
  intervalMs: 30_000,
  log,
  signal: abort.signal,
  // want principal protection too? add:  house: { principalAtomic: ..., principalMicroUsd: ..., chain, safeAddress, multipleBps }
});
