/**
 * Buy one item from nearmerch with Agent Connect funds, settled by Ping Agent Pay.
 *
 *   npm run pay -- --confirm
 *
 * ⚠  MAINNET, REAL MONEY. This signs in, creates a real order (a real Printful order once paid,
 *    shipped to SHIP_*), and withdraws real USDC from your Agent Connect account to a Base deposit
 *    address. There is no testnet for NEAR Intents. Capped by MAX_USDC; refuses without --confirm.
 *
 * Point NEARMERCH_URL at a nearmerch you run (default http://localhost:3000) with X402_ENABLED +
 * X402_INTENTS_ENABLED and a PING_API_KEY whose org has Agent Pay on.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { AgentConnectMcp } from "../src/agent-connect";
import { buyWithAgentConnect } from "../src/buy";
import { configFromEnv, loadDotEnv } from "../src/config";
import { NearmerchClient } from "../src/nearmerch";

loadDotEnv();
const cfg = configFromEnv();
const confirm = process.argv.includes("--confirm");

console.log(
  "\n⚠  pay moves REAL USDC on mainnet (Agent Connect → Base → NEAR Intents) and creates a REAL order.\n" +
    `   store ${cfg.nearmerchUrl} · cap MAX_USDC=${cfg.maxUsdc} · refund to ${cfg.refundAddress || "(REFUND_ADDRESS unset)"}\n`,
);
if (!confirm) {
  console.log("Dry stop: nothing was done. Run `npm run check` first, then `npm run pay -- --confirm`.");
  process.exit(1);
}
if (!cfg.agentConnectKey) {
  console.error("AGENT_CONNECT_KEY is not set (Agent Connect dashboard → API key, 30 days).");
  process.exit(2);
}

// Journal of irreversible steps (order id, deposit address, operation id, tx hash) for manual recovery.
mkdirSync(".state", { recursive: true });
const journal: Array<Record<string, unknown>> = [];
const checkpoint = (stage: string, data: Record<string, unknown>) => {
  journal.push({ at: new Date().toISOString(), stage, ...data });
  writeFileSync(".state/last-run.json", JSON.stringify(journal, null, 2));
};

const mcp = new AgentConnectMcp({ url: cfg.mcpUrl, bearer: cfg.agentConnectKey });
await mcp.connect();
try {
  const result = await buyWithAgentConnect(
    { merchant: new NearmerchClient({ baseUrl: cfg.nearmerchUrl }), mcp, log: (m) => console.log(m), checkpoint },
    cfg,
    { confirm },
  );
  console.log(`\n${JSON.stringify(result, null, 2)}`);
} catch (e) {
  console.error(`\nERROR: ${(e as Error).message}`);
  if (journal.length) console.error("Progress so far is in .state/last-run.json. If a withdraw was submitted, do NOT re-pay a new order.");
  process.exitCode = 1;
} finally {
  await mcp.disconnect();
}
