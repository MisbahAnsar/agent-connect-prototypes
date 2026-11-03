import { readFileSync } from "node:fs";

/** The two deployments this prototype targets; switch with NETWORK in .env. */
export const NETWORKS = {
  tidepool: {
    baseUrl: "https://www.usetidepool.tech",
    label: "Tidepool testnet (free, tokens have no value)",
    /** Tidepool reports balances only from the intents source. */
    balancesSource: "intents",
  },
  mainnet: {
    baseUrl: "https://api.agentsonintents.com",
    label: "mainnet (real funds)",
    balancesSource: "public",
  },
} as const;

export type NetworkName = keyof typeof NETWORKS;

/** Best-effort .env loader (KEY=VALUE lines; existing process env wins). */
export function loadDotEnv(path = ".env"): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = value;
  }
}

export type Network = { name: NetworkName; baseUrl: string; label: string; balancesSource: "public" | "intents" };

/** NETWORK=tidepool|mainnet, or an explicit AGENT_API_URL (its host picks the network). */
export function networkFromEnv(env: NodeJS.ProcessEnv = process.env): Network {
  const explicit = env.AGENT_API_URL?.trim();
  if (explicit) {
    const name: NetworkName = explicit.includes("tidepool") ? "tidepool" : "mainnet";
    return { name, baseUrl: explicit, label: `${NETWORKS[name].label} (via AGENT_API_URL)`, balancesSource: NETWORKS[name].balancesSource };
  }
  const name: NetworkName = env.NETWORK?.trim().toLowerCase() === "mainnet" ? "mainnet" : "tidepool";
  return { name, baseUrl: NETWORKS[name].baseUrl, label: NETWORKS[name].label, balancesSource: NETWORKS[name].balancesSource };
}

/** Reads a required variable or exits the CLI with a hint. */
export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name]?.trim();
  if (!v) {
    console.error(`Missing ${name} — copy .env.example to .env and fill it in.`);
    process.exit(2);
  }
  return v;
}

export const isMainnet = (net: Network = networkFromEnv()): boolean => net.name === "mainnet";
