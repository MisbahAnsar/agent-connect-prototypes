import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureProvisioned, type ProvisionResult } from "../../scripts/lib/provision.js";

export const DEMO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let cached: Promise<ProvisionResult> | null = null;

/**
 * Provision once per test run (owner key → agent → grant → faucet funds).
 * Reuses .state/agent-api.json across runs so we don't burn Tidepool's
 * 25-agents-per-key quota; a fresh run mints a key + agent automatically.
 */
export function fixture(): Promise<ProvisionResult> {
  cached ??= ensureProvisioned({ root: DEMO_ROOT, log: (m) => console.log(`[fixture] ${m}`) });
  return cached;
}
