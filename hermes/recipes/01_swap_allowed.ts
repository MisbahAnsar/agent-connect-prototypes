/**
 * Recipe 1 — within-limits swap succeeds.
 *
 * Prompt: swap a small amount of the faucet-funded asset for the second
 * allowed asset. Expected: the Agent API accepts it (202), settles SUCCESS,
 * and Hermes reports the execution with an amount_out / tx hash.
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
  const amount = 5; // 5 USDC — well under the 20 USDC per-transaction policy cap

  console.log("--- Recipe 1: Valid Swap (within policy) ---");
  const prompt = `Swap ${amount} ${assets.fundedSymbol} to ${assets.secondSymbol}.`;
  console.log(`Prompt: ${prompt}\n`);

  const reply = await queryHermes(prompt);
  console.log("Hermes output:\n", reply.output);

  console.log(`
Expected flow:
  1. Hermes lists tokens and resolves ${assets.fundedSymbol} / ${assets.secondSymbol} asset ids
  2. Hermes quotes via get_quote (dry) — no policy refusal for quotes, warnings only
  3. Hermes calls execute_swap with the grant token
  4. Agent API verifies: ${amount} ${assets.fundedSymbol} ≤ per-transaction cap && asset allowed → PASS
  5. Intent submitted to the solver bus and settled (SUCCESS + amount_out/tx_hash)`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
