/**
 * Recipe 2 — the whole House Money story: deposit → trade → the principal exits itself → repeat on
 * house money. The worst case is banked the moment gains cover it; nothing after that can reach it.
 *
 *   npm run provision   (once, then fund the printed address)
 *   npm run recipe:2
 *
 * Same loop as recipe 1, plus the runner: once equity ≥ HOUSE_MULTIPLE_BPS of the principal it
 * withdraws exactly the principal to the safe address under a fixed idempotency key — exactly once,
 * through the policy's one allowed destination and veto window.
 */
import { loadDotEnv, networkFromEnv } from "../src/config";
import { LiveAgentApi } from "../src/agent-api/live";
import { EventLog } from "../src/runner/events";
import { TrendStrategy } from "../src/strategy/trend";
import { loadProvisioned, ownerFromEnvOrState } from "../src/state";
import { runTradingLoop } from "../src/loop";

loadDotEnv();
const state = await loadProvisioned();
const net = networkFromEnv();

if (!state.riskAsset) {
  console.error("No risk asset provisioned — set HOUSE_RISK_ASSET (or HOUSE_RISK_ASSET_SYMBOL) and re-run `npm run provision`.");
  process.exit(2);
}
if (net.name === "mainnet" && process.env.HOUSE_CONFIRM !== "spend-real-funds") {
  console.error("Mainnet: this recipe moves real funds (trading + the principal exit).");
  console.error("Re-run with HOUSE_CONFIRM=spend-real-funds to proceed.");
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

const principalAtomic = BigInt(state.principalAtomic);
console.log(`Agent ${state.agentId} on ${net.name}.`);
console.log(`Stake ${state.principalWhole} ${state.stakeSymbol}; exit at ${Number(state.multipleBps) / 10_000}x to ${state.safeAddress} on ${state.safeChain} (timelock ${state.timelockMs / 1000}s).`);
console.log("Ctrl-C to stop.\n");

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
  house: {
    principalAtomic,
    principalMicroUsd: BigInt(state.principalMicroUsd),
    chain: state.safeChain,
    safeAddress: state.safeAddress,
    multipleBps: BigInt(state.multipleBps),
    sealAfterSettlement: process.env.HOUSE_SEAL === "1",
  },
});
