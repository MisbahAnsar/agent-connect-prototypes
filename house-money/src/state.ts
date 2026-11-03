import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { KeyPair, type KeyPairEd25519 } from "near-api-js";
import { NearOwnerSigner } from "./agent-api/near-signer";
import type { TokenInfo } from "./policy/types";

const STATE_DIR = ".state";
const STATE_PATH = `${STATE_DIR}/provision.json`;
const OWNER_KEY_PATH = `${STATE_DIR}/owner-key.json`;
const API_KEY_PATH = `${STATE_DIR}/api-key.json`;

/** Everything provision writes and every recipe needs. */
export type ProvisionState = {
  network: string;
  baseUrl: string;
  apiKey: string;
  agentId: string;
  ownerAccountId: string;
  grantToken: string;
  grantExpiresAt: string;
  stakeAsset: string;
  stakeSymbol: string;
  stakeDecimals: number;
  /** Whole units, as entered. */
  principalWhole: string;
  /** Atomic units, derived from `principalWhole` and the asset's decimals. */
  principalAtomic: string;
  /** The stake in micro-USD, fixed at provision time. */
  principalMicroUsd: string;
  riskAsset?: string;
  riskSymbol?: string;
  safeChain: string;
  safeAddress: string;
  multipleBps: string;
  timelockMs: number;
  provisionedAt: string;
};

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

export async function saveProvisioned(state: ProvisionState): Promise<void> {
  await writeAtomic(STATE_PATH, JSON.stringify(state, null, 2));
}

export async function loadProvisioned(): Promise<ProvisionState> {
  if (!existsSync(STATE_PATH)) {
    console.error("Nothing provisioned yet. Run `npm run provision` first.");
    process.exit(2);
  }
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as ProvisionState;
}

export function provisionedState(): ProvisionState | null {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as ProvisionState;
  } catch {
    return null;
  }
}

export function saveOwnerKeySync(entry: { accountId: string; privateKey: string; publicKey: string }): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(OWNER_KEY_PATH, JSON.stringify(entry, null, 2));
}

export function loadOwnerKeyEntry(): { accountId: string; privateKey: string; publicKey: string } | null {
  try {
    return JSON.parse(readFileSync(OWNER_KEY_PATH, "utf8")) as { accountId: string; privateKey: string; publicKey: string };
  } catch {
    return null;
  }
}

/** Minted keys are tenant-scoped: cache them so re-provisioning keeps the same agent + tenant. */
export function saveApiKeySync(apiKey: string): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(API_KEY_PATH, JSON.stringify({ apiKey }, null, 2));
}

export function loadApiKeyEntry(): string | null {
  try {
    return (JSON.parse(readFileSync(API_KEY_PATH, "utf8")) as { apiKey: string }).apiKey;
  } catch {
    // fall back to the full provision state (older provisions)
    try {
      return (JSON.parse(readFileSync(STATE_PATH, "utf8")) as ProvisionState).apiKey;
    } catch {
      return null;
    }
  }
}

/**
 * The owner for owner-signed intents: env credentials win; otherwise the throwaway key
 * `provision` generated on tidepool. Never invoked by the recipes themselves (they act
 * under the grant) — LiveAgentApi just needs it wired in.
 */
export function ownerFromEnvOrState(env: NodeJS.ProcessEnv = process.env): NearOwnerSigner {
  if (env.OWNER_ACCOUNT_ID?.trim() && env.OWNER_PRIVATE_KEY?.trim()) {
    return new NearOwnerSigner({ accountId: env.OWNER_ACCOUNT_ID.trim(), privateKey: env.OWNER_PRIVATE_KEY.trim(), rpcUrl: env.NEAR_RPC_URL });
  }
  if (existsSync(OWNER_KEY_PATH)) {
    const cached = JSON.parse(readFileSync(OWNER_KEY_PATH, "utf8")) as { accountId: string; privateKey: string };
    return new NearOwnerSigner({ accountId: cached.accountId, privateKey: cached.privateKey, rpcUrl: env.NEAR_RPC_URL });
  }
  console.error("No owner credentials: run `npm run provision` (tidepool) or set OWNER_ACCOUNT_ID and OWNER_PRIVATE_KEY (mainnet).");
  process.exit(2);
}

/** A fresh implicit NEAR account id + key. On tidepool this needs no on-chain account and nothing to fund. */
export function generateThrowawayOwner(): { accountId: string; privateKey: string; publicKey: string } {
  const kp = KeyPair.fromRandom("ed25519") as KeyPairEd25519;
  return {
    accountId: Buffer.from(kp.getPublicKey().data).toString("hex"),
    privateKey: kp.toString(),
    publicKey: kp.getPublicKey().toString(),
  };
}

export type AssetSelector = { assetId?: string; symbol?: string; blockchain?: string };

/** Pick a token by explicit asset id, or by symbol+chain from the catalog. */
export function resolveAsset(tokens: TokenInfo[], what: string, sel: AssetSelector): TokenInfo {
  if (sel.assetId) {
    const t = tokens.find((x) => x.asset_id === sel.assetId);
    if (!t) throw new Error(`${what}: ${sel.assetId} is not in the token catalog (run \`npm run check\` to list assets)`);
    return t;
  }
  const symbol = sel.symbol ?? "USDC";
  const blockchain = sel.blockchain ?? "near";
  const t = tokens.find((x) => x.symbol === symbol && x.blockchain === blockchain);
  if (!t) throw new Error(`${what}: no ${symbol} on ${blockchain} in this network's catalog (${tokens.length} assets). Run \`npm run check\` and set the asset id explicitly.`);
  return t;
}

/** Whole units -> atomic units, using the asset's decimals. */
export function toAtomic(whole: string, decimals: number): bigint {
  const [w = "0", frac = ""] = whole.split(".");
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals));
}
