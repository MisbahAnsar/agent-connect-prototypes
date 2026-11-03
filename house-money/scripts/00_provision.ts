/**
 * Provisions everything the recipes need, then tells you how to fund the agent. Moves no funds itself:
 * on tidepool the "stake" is valueless, on mainnet you send it yourself to the printed deposit address.
 *
 *   npm run provision
 *
 * - Mints a free API key on tidepool (cached in .state/) or uses AGENT_API_KEY
 * - Owner: a throwaway implicit key on tidepool (cached in .state/), your env credentials on mainnet
 * - Creates the agent (no withdrawals, $10/day budget on mainnet), applies the house-money policy,
 *   issues a 24h grant to the runner, and prints a deposit address for the stake asset
 * - Re-running on the same network keeps the agent and just refreshes the grant + deposit address
 */
import { createAgentApi } from "@near-intents-agent-api/sdk";
import { loadDotEnv, networkFromEnv } from "../src/config";
import { LiveAgentApi } from "../src/agent-api/live";
import { NearOwnerSigner } from "../src/agent-api/near-signer";
import { buildHouseMoneyPolicy } from "../src/policy/policy";
import { portfolioValueMicroUsd } from "../src/risk/pricing";
import { loadApiKeyEntry, loadOwnerKeyEntry, generateThrowawayOwner, provisionedState, resolveAsset, saveApiKeySync, saveOwnerKeySync, saveProvisioned, toAtomic, type ProvisionState } from "../src/state";
import type { TokenInfo } from "../src/policy/types";

loadDotEnv();
const net = networkFromEnv();
console.log(`Network     ${net.label}`);
console.log(`Base URL    ${net.baseUrl}`);
if (Number(process.versions.node.split(".")[0]) < 24) {
  console.log(`Node        ${process.version} — the SDK declares 24+; if owner signing fails, upgrade before blaming the script.`);
}

// ── API key ───────────────────────────────────────────────────────────────
let apiKey = process.env.AGENT_API_KEY?.trim() || "";
if (!apiKey && net.name !== "tidepool") {
  console.error("Missing AGENT_API_KEY — mainnet needs a real naa_... key from the partner dashboard.");
  process.exit(2);
}
if (!apiKey && net.name === "tidepool") {
  const cached = loadApiKeyEntry();
  if (cached) {
    apiKey = cached;
  } else {
    apiKey = await mintTidepoolKey(net.baseUrl);
    saveApiKeySync(apiKey);
  }
}
console.log(`API key     ${apiKey.slice(0, 8)}…${apiKey.slice(-4)}`);

// ── Owner ─────────────────────────────────────────────────────────────────
let owner: NearOwnerSigner;
if (net.name === "mainnet") {
  const id = process.env.OWNER_ACCOUNT_ID?.trim();
  const pk = process.env.OWNER_PRIVATE_KEY?.trim();
  if (!id || !pk) {
    console.error("Missing OWNER_ACCOUNT_ID / OWNER_PRIVATE_KEY — use a dedicated, low-value NEAR account on mainnet.");
    process.exit(2);
  }
  owner = new NearOwnerSigner({ accountId: id, privateKey: pk, rpcUrl: process.env.NEAR_RPC_URL });
} else {
  // reuse the throwaway owner across provisions so the agent keeps its owner
  const cached = loadOwnerKeyEntry();
  const entry = cached ?? generateThrowawayOwner();
  if (!cached) saveOwnerKeySync(entry);
  owner = new NearOwnerSigner({ accountId: entry.accountId, privateKey: entry.privateKey, rpcUrl: process.env.NEAR_RPC_URL });
}
const ownerAccountId = owner.owner.account_id;

const live = new LiveAgentApi({ apiKey, baseUrl: net.baseUrl, owner });
const sdk = createAgentApi({ apiKey, baseUrl: net.baseUrl });

// ── Stake + policy inputs ─────────────────────────────────────────────────
const tokens: TokenInfo[] = await live.getTokens();
const stake = resolveAsset(tokens, "HOUSE_STAKE_ASSET", {
  assetId: process.env.HOUSE_STAKE_ASSET?.trim() || undefined,
  symbol: process.env.HOUSE_STAKE_ASSET_SYMBOL?.trim() || undefined,
  blockchain: process.env.HOUSE_STAKE_ASSET_CHAIN?.trim() || undefined,
});
if (stake.price === null) throw new Error(`${stake.symbol} is not priced in the catalog; pick another stake asset`);
const principalWhole = process.env.HOUSE_PRINCIPAL?.trim() || "5";
const principalAtomic = toAtomic(principalWhole, stake.decimals);
const principalMicroUsd = portfolioValueMicroUsd({ [stake.asset_id]: principalAtomic.toString() }, tokens);

const riskSel = {
  assetId: process.env.HOUSE_RISK_ASSET?.trim() || undefined,
  symbol: process.env.HOUSE_RISK_ASSET_SYMBOL?.trim() || undefined,
  blockchain: process.env.HOUSE_RISK_ASSET_CHAIN?.trim() || undefined,
};
const risk = riskSel.assetId || riskSel.symbol ? resolveAsset(tokens, "HOUSE_RISK_ASSET", riskSel) : null;

const safeChain = process.env.HOUSE_SAFE_CHAIN?.trim() || "base";
const rawSafe = process.env.HOUSE_SAFE_ADDRESS?.trim() || "";
const safeAddress = /^0x[0-9a-fA-F]{40}$/.test(rawSafe) ? rawSafe.toLowerCase() : rawSafe; // canonical lowercase EVM addresses
if (!safeAddress) {
  console.error("Missing HOUSE_SAFE_ADDRESS — where the principal exits to (use a throwaway address on tidepool).");
  process.exit(2);
}
const multipleBps = BigInt(process.env.HOUSE_MULTIPLE_BPS?.trim() || "20000");
// tidepool has no timelocks: the veto window is a mainnet feature
const timelockMs = net.name === "tidepool" ? 0 : Number(process.env.HOUSE_TIMELOCK_MS?.trim() || "30000");
if (net.name === "tidepool" && process.env.HOUSE_TIMELOCK_MS?.trim() && process.env.HOUSE_TIMELOCK_MS.trim() !== "0") {
  console.log("Note        tidepool does not support timelock_ms — the veto window applies on mainnet only.");
}

const policy = buildHouseMoneyPolicy({
  asset: stake.asset_id,
  principalAtomic,
  chain: safeChain,
  safeAddress,
  timelockMs,
  ...(risk ? { trading: { assets: { [risk.asset_id]: (principalAtomic * 1000n).toString() } } } : {}),
});

// ── Agent (re-used when already provisioned on this network) ──────────────
const prior = provisionedState();
const reuse = prior?.network === net.name;
let agentId: string;
if (reuse) {
  agentId = prior!.agentId;
  console.log(`Agent       ${agentId} (already provisioned on this network; re-using)`);
} else {
  const generated = await sdk.generateIntent({
    type: "agent_create",
    name: process.env.HOUSE_AGENT_NAME?.trim() || "house-money",
    owner: owner.owner,
    // starting policy: no withdrawals, no destinations; replaced by the house-money policy below
    policy: {
      frozen: false,
      actions: ["swap"],
      confidential: false,
      owner_approval: false,
      assets: "any",
      limits: {},
      max_actions_per_hour: 5,
      destinations: { mode: "only", list: [] },
      budget: { daily_usd: net.name === "mainnet" ? "10" : null, weekly_usd: null, monthly_usd: null },
      timelock_ms: 0,
    },
  });
  console.log(`Creating agent — signing with the owner key (${ownerAccountId})…`);
  const signed = await owner.sign(generated);
  await sdk.submitIntent({ type: generated.type, correlation_id: generated.correlation_id, signed_data: signed });
  for (;;) {
    const status = await sdk.getStatus(generated.correlation_id, { waitMs: 30_000 });
    if (status.status === "SUCCESS") break;
    if (["FAILED", "NEEDS_REVIEW", "REFUNDED"].includes(status.status)) {
      console.error(`agent_create failed: ${status.failure_code ?? status.status}`);
      process.exit(1);
    }
  }
  agentId = generated.agent_id!;
  console.log(`Agent       ${agentId}`);
}

console.log("Applying the house-money policy…");
const current = await live.getPolicy(agentId);
await live.updatePolicy(agentId, policy, current.revision ?? 0);

console.log("Issuing a 24h grant to the runner…");
const grantExpiresAt = new Date(Date.now() + 86_400_000);
const { token } = await live.issueGrant(agentId, "house-money:runner", grantExpiresAt);

// ── Deposit address ───────────────────────────────────────────────────────
console.log("Requesting a deposit address…");
const deposit = await sdk.deposit(agentId, { origin_asset: stake.asset_id });
const d = (deposit as { details?: { deposit_address?: string | null; min_amount?: string | null; memo?: string | null; expires_at?: string | null } }).details ?? {};

// ── Persist + report ──────────────────────────────────────────────────────
const state: ProvisionState = {
  network: net.name,
  baseUrl: net.baseUrl,
  apiKey,
  agentId,
  ownerAccountId,
  grantToken: token,
  grantExpiresAt: grantExpiresAt.toISOString(),
  stakeAsset: stake.asset_id,
  stakeSymbol: stake.symbol,
  stakeDecimals: stake.decimals,
  principalWhole,
  principalAtomic: principalAtomic.toString(),
  principalMicroUsd: principalMicroUsd.toString(),
  ...(risk ? { riskAsset: risk.asset_id, riskSymbol: risk.symbol } : {}),
  safeChain,
  safeAddress,
  multipleBps: multipleBps.toString(),
  timelockMs,
  provisionedAt: new Date().toISOString(),
};
await saveProvisioned(state);

console.log(`
Provisioned. State cached in .state/provision.json.

Fund the agent (this is the only step that moves anything):
  send ≥ ${d.min_amount ?? "(see catalog minimum)"} ${stake.symbol} to  ${d.deposit_address ?? "(unavailable — check the API response)"}
${d.memo ? `  memo: ${d.memo}\n` : ""}${d.expires_at ? `  address expires: ${d.expires_at}\n` : ""}
  target stake: ${principalWhole} ${stake.symbol} ≈ $${Number(principalMicroUsd) / 1e6}
  balance polls: GET status ${deposit.correlation_id}

Policy: withdraw only to ${safeAddress} on ${safeChain}, per-tx cap = the principal,${risk ? ` swap ${risk.symbol} allowed,` : ""} timelock ${timelockMs / 1000}s, exit at ${Number(multipleBps) / 10_000}x.
${risk ? `Next: npm run recipe:1   (trend trading loop)\n      npm run recipe:2   (+ principal exit)\n      npm run recipe:3   (your own strategy)\n      npm run recipe:4   (live chaos probes)` : `Next: set HOUSE_RISK_ASSET / HOUSE_RISK_ASSET_SYMBOL and re-run provision, or npm run recipe:2 for the exit-only story.`}
`);

// ── helpers ───────────────────────────────────────────────────────────────

/** Mints a free key on tidepool; finds the `naa_…` string wherever the response puts it. */
async function mintTidepoolKey(baseUrl: string): Promise<string> {
  console.log("Minting a free tidepool API key (POST /v1/keys)…");
  const res = await fetch(`${baseUrl}/v1/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "house-money" }),
  });
  if (!res.ok) throw new Error(`POST /v1/keys failed: ${res.status} ${await res.text().then((t) => t.slice(0, 300))}`);
  const json: unknown = await res.json();
  const found = findNaaKey(json);
  if (!found) throw new Error(`POST /v1/keys returned no naa_... key: ${JSON.stringify(json).slice(0, 300)}`);
  return found;
}

function findNaaKey(value: unknown, depth = 0): string | null {
  if (typeof value === "string") return /^naa_[A-Za-z0-9_-]{20,}$/.test(value) ? value : null;
  if (!value || typeof value !== "object" || depth > 4) return null;
  for (const v of Object.values(value as Record<string, unknown>)) {
    const hit = findNaaKey(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}
