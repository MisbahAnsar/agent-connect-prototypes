/**
 * Recipe 3 — blocked by a disallowed asset.
 *
 * Prompt: swap into an asset that exists on the network but is NOT in the
 * policy's `assets` allow-list. Expected: HTTP 403 with code
 * `policy_asset_denied`, layer `policy`; the execution never reaches the
 * solver bus; Hermes reports which rule was breached.
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

  console.log("--- Recipe 3: Blocked by Disallowed Asset ---");
  const prompt = `Swap 10 ${assets.fundedSymbol} to ${assets.blockedSymbol}.`;
  console.log(
    `Prompt: ${prompt}   (allowed assets: ${assets.fundedSymbol}, ${assets.secondSymbol})\n`,
  );

  const reply = await queryHermes(prompt);
  console.log("Hermes output:\n", reply.output);

  console.log(`
Expected flow:
  1. Hermes resolves ${assets.blockedSymbol} → ${assets.blocked} via list_tokens
  2. Hermes calls execute_swap targeting that asset
  3. Agent API policy gate blocks: asset not in policy.assets
  4. HTTP 403 — code: policy_asset_denied, layer: policy
  5. Hermes refuses before anything hits the market maker bus.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
