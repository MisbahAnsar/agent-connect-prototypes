/**
 * Provision the demo: owner policy → agent wallet → scoped grant token (ngt_…).
 *
 * Owner authority lives here (and in .state/, gitignored). Hermes never sees
 * the owner key — it only receives the scoped grant token via profile/.env.
 *
 *   npm run provision            # testnet (Tidepool, free, faucet-funded)
 *   npm run provision -- --force # ignore cached agent/grant and provision fresh
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureProvisioned } from "./lib/provision.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const force = process.argv.includes("--force");

const result = await ensureProvisioned({ root, force, log: (m) => console.log(m) });
const s = result.state;

console.log(`
────────────────────────────────────────────────────────────
Provisioning complete ${result.reused ? "(reused existing agent)" : ""}
  Network:      ${result.config.baseUrl}
  Agent:        ${s.agent_id}
  Agent wallet: ${s.agent_wallet}
  Grant:        expires ${s.grant_expires_at}
  Funded asset: ${s.assets?.fundedSymbol} (${s.assets?.funded})
  Allowed:      ${s.assets?.fundedSymbol}, ${s.assets?.secondSymbol}
  Blocked:      ${s.assets?.blockedSymbol} (${s.assets?.blocked})
  Per-tx limit: ${Number(s.per_transaction_limit_raw) / 1e6} ${s.assets?.fundedSymbol}

Hermes only receives HERMES_GRANT_TOKEN (written to profile/.env).
The owner key stays in .state/ and never reaches the agent.
────────────────────────────────────────────────────────────
Next: npm run recipe:1
`);
