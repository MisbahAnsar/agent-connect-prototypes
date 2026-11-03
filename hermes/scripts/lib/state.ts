import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { OwnerJwk } from "./crypto.js";

export interface DemoState {
  api_key?: string;
  owner_jwk?: OwnerJwk;
  owner_account_id?: string;
  owner_public_key?: string;
  agent_id?: string;
  agent_wallet?: string;
  grant_token?: string;
  grant_expires_at?: string;
  assets?: {
    funded: string;
    fundedSymbol: string;
    second: string;
    secondSymbol: string;
    blocked: string;
    blockedSymbol: string;
  };
  policy?: Record<string, unknown>;
  per_transaction_limit_raw?: string;
  provisioned_at?: string;
}

export function stateFile(root: string): string {
  return path.join(root, ".state", "agent-api.json");
}

export function loadState(root: string): DemoState {
  try {
    return JSON.parse(readFileSync(stateFile(root), "utf8")) as DemoState;
  } catch {
    return {};
  }
}

export function saveState(root: string, state: DemoState): void {
  mkdirSync(path.dirname(stateFile(root)), { recursive: true });
  writeFileSync(stateFile(root), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}
