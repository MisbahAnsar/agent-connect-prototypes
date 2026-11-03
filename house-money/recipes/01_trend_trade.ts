/**
 * Recipe 1 — the trading loop: deposit → your strategy → repeat.
 *
 *   npm run provision   (once, then fund the printed address)
 *   npm run recipe:1
 *
 * Runs the reference TrendStrategy (EMA + dead band) until you Ctrl-C. This is the
 * "simple wrapper": you hand runTradingLoop a Strategy, it handles pricing, quoting,
 * slippage, the policy and one-swap-in-flight for you.
 */
import { loadDotEnv, networkFromEnv } from "../src/config";
import { LiveAgentApi } from "../src/agent-api/live";
import { EventLog } from "../src/runner/events";
import { TrendStrategy } from "../src/strategy/trend";
import { ownerFromEnvOrState, loadProvisioned } from "../src/state";
import { runTradingLoop } from "../src/loop";

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

console.log(`Trading ${state.stakeSymbol} ↔ ${state.riskSymbol} on ${state.agentId} (${net.name}). Strategy: TrendStrategy.`);
console.log("Swap the strategy for your own — see recipes/03_my_strategy.ts.\n");

await runTradingLoop({
  client: live,
  grant,
  agentId: state.agentId,
  stakeAsset: state.stakeAsset,
  riskAsset: state.riskAsset,
  strategy: new TrendStrategy(),
  intervalMs: 30_000,
  log,
  signal: abort.signal,
});
