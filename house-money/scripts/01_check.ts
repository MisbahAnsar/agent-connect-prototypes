/**
 * Read-only check of whichever network .env points at. Moves no funds and signs nothing.
 *
 *   npm run check
 *
 * Uses AGENT_API_KEY (or the key `provision` cached on tidepool); without any key it still
 * lists the public token catalog. Use it to pick HOUSE_* asset ids.
 */
import { createAgentApi } from "@near-intents-agent-api/sdk";
import { loadDotEnv, networkFromEnv } from "../src/config";
import { LiveAgentApi } from "../src/agent-api/live";
import { portfolioValueMicroUsd } from "../src/risk/pricing";
import { loadApiKeyEntry } from "../src/state";

loadDotEnv();
const net = networkFromEnv();
const key = process.env.AGENT_API_KEY?.trim() || loadApiKeyEntry() || "";
const apiKey = key || `naa_${"0".repeat(43)}`; // well-formed placeholder for the public endpoints

console.log(`Network     ${net.label}\nBase URL    ${net.baseUrl}`);

const sdk = createAgentApi({ apiKey, baseUrl: net.baseUrl });
const live = new LiveAgentApi({ apiKey, baseUrl: net.baseUrl, owner: { sign: async () => { throw new Error("read-only check: no signing"); } } });

const tokens = await live.getTokens();
console.log(`\ntoken catalog: ${tokens.length} assets, ${tokens.filter((t) => t.symbol === "USDC").length} USDC variants`);
const priced = tokens.filter((t) => t.price !== null);
for (const t of priced.slice(0, 12)) {
  console.log(`  ${t.blockchain.padEnd(8)} ${t.symbol.padEnd(8)} ${t.asset_id.slice(0, 64)}  $${t.price}`);
}
if (priced.length > 12) console.log(`  … and ${priced.length - 12} more`);

const stake = priced.find((t) => t.symbol === "USDC" && t.blockchain === "near");
if (stake) {
  const value = portfolioValueMicroUsd({ [stake.asset_id]: "1000000" }, tokens);
  console.log(`\n1 ${stake.symbol} priced by the runner's own pricing: $${Number(value) / 1e6}`);
}

if (key) {
  const network = await sdk.getNetwork();
  console.log(`\nnetwork: ${network.network}, overall status: ${network.status.overall}`);
  for (const c of network.status.components) console.log(`  ${c.id ?? "(component)"}: ${c.status}`);
  const who = await sdk.whoami();
  console.log("\nAPI key accepted:", JSON.stringify(who).slice(0, 200));
} else {
  console.log("\nNo API key: skipped network status and whoami. Run `npm run provision` (mints one for free on tidepool).");
}
