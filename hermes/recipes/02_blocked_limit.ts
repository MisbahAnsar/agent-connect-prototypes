/**
 * Recipe 2 — blocked by the per-transaction limit.
 *
 * Prompt: swap an amount that strictly exceeds the owner-signed
 * `limits.per_transaction` cap. Expected: HTTP 403 with
 * code `policy_transaction_limit_exceeded`, layer `policy`; nothing settles,
 * no budget charged; Hermes explains the breached rule instead of retrying.
 */
import { loadEnvFile } from "../scripts/lib/config.js";
import { ensureProvisioned } from "../scripts/lib/provision.js";
import { queryHermes, requireProvisioned } from "./hermes_client.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function run() {
  loadEnvFile(path.join(root, ".env"));
  requireProvisioned();
  const { state } = await ensureProvisioned({ root, log: () => {} });
  const assets = state.assets!;
  const limit = Number(state.per_transaction_limit_raw ?? "0") / 1e6;
  const amount = Math.ceil(limit * 1.5); // 30 when the cap is 20

  console.log("--- Recipe 2: Blocked by Per-Transaction Limit ---");
  const prompt = `Swap ${amount} ${assets.fundedSymbol} to ${assets.secondSymbol}.`;
  console.log(`Prompt: ${prompt}   (policy cap: ${limit} ${assets.fundedSymbol})\n`);

  const reply = await queryHermes(prompt);
  console.log("Hermes output:\n", reply.output);

  console.log(`
Expected flow:
  1. Hermes calls execute_swap with amount = ${amount} ${assets.fundedSymbol}
  2. Agent API policy gate blocks: exceeds limits.per_transaction (${limit})
  3. HTTP 403 — code: policy_transaction_limit_exceeded, layer: policy
  4. Hermes refuses to retry and explains the breached rule.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
