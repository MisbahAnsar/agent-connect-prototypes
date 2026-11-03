import { readFileSync } from "node:fs";
import path from "node:path";

export const NETWORKS = {
  testnet: "https://www.usetidepool.tech",
  mainnet: "https://api.agentsonintents.com",
} as const;

/** Minimal .env loader — does not override variables already in the process env. */
export function loadEnvFile(file: string): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export interface DemoConfig {
  baseUrl: string;
  network: keyof typeof NETWORKS;
  apiKey?: string;
  agentId?: string;
  grantToken?: string;
  ownerAccountId?: string;
  ownerPrivateKey?: string;
  nearAiApiKey?: string;
  /** Comma-separated extra asset ids to allow in the policy (rarely needed). */
  extraAllowedAssets?: string[];
}

export function loadDemoConfig(root: string): DemoConfig {
  loadEnvFile(path.join(root, ".env"));
  const rawUrl = process.env.AGENT_API_URL?.trim();
  const network: keyof typeof NETWORKS =
    rawUrl === NETWORKS.mainnet ? "mainnet" : "testnet";
  const baseUrl = rawUrl || NETWORKS.testnet;
  return {
    baseUrl,
    network,
    apiKey: process.env.AGENT_API_KEY?.trim() || undefined,
    agentId: process.env.AGENT_ID?.trim() || undefined,
    grantToken: process.env.HERMES_GRANT_TOKEN?.trim() || undefined,
    ownerAccountId: process.env.OWNER_ACCOUNT_ID?.trim() || undefined,
    ownerPrivateKey: process.env.OWNER_PRIVATE_KEY?.trim() || undefined,
    nearAiApiKey: process.env.NEAR_AI_API_KEY?.trim() || undefined,
    extraAllowedAssets: process.env.EXTRA_ALLOWED_ASSETS?.split(",").map((s) => s.trim()).filter(Boolean),
  };
}

export function writeEnvFile(file: string, vars: Record<string, string>): void {
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  writeFileSyncIfChanged(file, lines.join("\n") + "\n");
}

import { readFileSync as rfs, writeFileSync } from "node:fs";
function writeFileSyncIfChanged(file: string, content: string): void {
  let current: string | undefined;
  try {
    current = rfs(file, "utf8");
  } catch {
    /* new file */
  }
  if (current !== content) writeFileSync(file, content);
}
