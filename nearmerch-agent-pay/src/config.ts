import { readFileSync } from "node:fs";

/** Local nearmerch dev server. x402 is switched off on https://nearmerch.com until the store enables it. */
export const DEFAULT_NEARMERCH_URL = "http://localhost:3000";
/** NEP-413 recipient nearmerch's Sign in with NEAR expects (better-near-auth `siwn`). */
export const NEARMERCH_SIGN_IN_RECIPIENT = "near-merch-store.near";
export const NEARMERCH_SIGN_IN_MESSAGE = "Sign in to NEAR Merch Store";

/** Hosted Agent Connect MCP endpoint (Streamable HTTP). */
export const DEFAULT_AGENT_CONNECT_MCP_URL = "https://agent-connect-app-production.up.railway.app/mcp";
/** Ping production host; used only for the public `/agentpay/x402/supported` discovery call. */
export const DEFAULT_PING_URL = "https://pay.pingpay.io";

/** Origin the agent pays on: USDC on Base mainnet. Agent Connect delivers it with `withdraw` chain=base. */
export const BASE_NETWORK = "eip155:8453";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const USDC_DECIMALS = 6;
/** NEAR Intents USDC (native USDC on NEAR) — the Agent Connect balance that funds the Base withdraw. */
export const NEAR_USDC_TOKEN = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

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

export type ShippingAddress = {
  firstName: string;
  lastName: string;
  email: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state?: string;
  postCode: string;
  country: string;
  phone?: string;
};

export type Config = {
  nearmerchUrl: string;
  pingUrl: string;
  mcpUrl: string;
  agentConnectKey: string;
  agentConnectAccount: string;
  /** "key" signs in with NEAR_ACCOUNT_ID + NEAR_PRIVATE_KEY; "agent-connect" uses the MCP near_sign_message tool. */
  signer: "key" | "agent-connect";
  nearAccountId: string;
  nearPrivateKey: string;
  refundAddress: string;
  withdrawToken: string;
  productId: string;
  variantId: string;
  productQuery: string;
  quantity: number;
  /** Hard cap on what the agent may send, in whole USDC. */
  maxUsdc: number;
  maxPreviews: number;
  shipping: ShippingAddress;
};

const v = (env: NodeJS.ProcessEnv, name: string, fallback = ""): string => env[name]?.trim() || fallback;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const signer = v(env, "NEARMERCH_SIGNER", "key").toLowerCase();
  if (signer !== "key" && signer !== "agent-connect") {
    throw new Error(`NEARMERCH_SIGNER must be "key" or "agent-connect", got "${signer}"`);
  }
  const maxUsdc = Number(v(env, "MAX_USDC", "40"));
  if (!Number.isFinite(maxUsdc) || maxUsdc <= 0) throw new Error("MAX_USDC must be a positive number");
  const quantity = Number(v(env, "QUANTITY", "1"));
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error("QUANTITY must be a positive integer");
  return {
    nearmerchUrl: v(env, "NEARMERCH_URL", DEFAULT_NEARMERCH_URL).replace(/\/$/, ""),
    pingUrl: v(env, "PING_URL", DEFAULT_PING_URL).replace(/\/$/, ""),
    mcpUrl: v(env, "AGENT_CONNECT_MCP_URL", DEFAULT_AGENT_CONNECT_MCP_URL),
    agentConnectKey: v(env, "AGENT_CONNECT_KEY"),
    agentConnectAccount: v(env, "AGENT_CONNECT_ACCOUNT"),
    signer,
    nearAccountId: v(env, "NEAR_ACCOUNT_ID"),
    nearPrivateKey: v(env, "NEAR_PRIVATE_KEY"),
    refundAddress: v(env, "REFUND_ADDRESS"),
    withdrawToken: v(env, "NEAR_USDC_WITHDRAW_TOKEN", NEAR_USDC_TOKEN),
    productId: v(env, "PRODUCT_ID"),
    variantId: v(env, "VARIANT_ID"),
    productQuery: v(env, "PRODUCT_QUERY"),
    quantity,
    maxUsdc,
    maxPreviews: Number(v(env, "MAX_PREVIEWS", "3")),
    shipping: {
      firstName: v(env, "SHIP_FIRST_NAME"),
      lastName: v(env, "SHIP_LAST_NAME"),
      email: v(env, "SHIP_EMAIL"),
      addressLine1: v(env, "SHIP_LINE1"),
      ...(v(env, "SHIP_LINE2") ? { addressLine2: v(env, "SHIP_LINE2") } : {}),
      city: v(env, "SHIP_CITY"),
      ...(v(env, "SHIP_STATE") ? { state: v(env, "SHIP_STATE") } : {}),
      postCode: v(env, "SHIP_POSTCODE"),
      country: v(env, "SHIP_COUNTRY"),
      ...(v(env, "SHIP_PHONE") ? { phone: v(env, "SHIP_PHONE") } : {}),
    },
  };
}

/** Throws with the names of every unset field, so the CLI can print one actionable hint. */
export function missingShipping(address: ShippingAddress): string[] {
  const required: Array<[keyof ShippingAddress, string]> = [
    ["firstName", "SHIP_FIRST_NAME"],
    ["lastName", "SHIP_LAST_NAME"],
    ["email", "SHIP_EMAIL"],
    ["addressLine1", "SHIP_LINE1"],
    ["city", "SHIP_CITY"],
    ["postCode", "SHIP_POSTCODE"],
    ["country", "SHIP_COUNTRY"],
  ];
  return required.filter(([k]) => !address[k]).map(([, name]) => name);
}

/** USD dollars (as nearmerch returns them) → USDC atomic units, without float drift: round(usd*100)*10^4. */
export function usdToUsdcAtomic(usd: number): bigint {
  return BigInt(Math.round(usd * 100)) * 10_000n;
}

export function formatUsdc(atomic: bigint | string): string {
  const n = BigInt(atomic);
  const unit = 10n ** BigInt(USDC_DECIMALS);
  const frac = (n % unit).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${n / unit}.${frac}` : `${n / unit}`;
}
