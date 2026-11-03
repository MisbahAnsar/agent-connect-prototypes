import path from "node:path";
import crypto from "node:crypto";
import { AgentApiClient } from "./api.js";
import { NETWORKS, loadDemoConfig, loadEnvFile, writeEnvFile, type DemoConfig } from "./config.js";
import { generateOwner, ownerFromJwk, ownerFromSeed, ownerToJwk, signNep413, type OwnerKey } from "./crypto.js";
import { demoPolicy } from "./policy.js";
import { loadState, saveState, type DemoState } from "./state.js";

export interface ProvisionResult {
  config: DemoConfig;
  state: DemoState;
  client: AgentApiClient;
  reused: boolean;
}

const FUND_TARGET_RAW = 20_000_000n; // 20 USDC (6 decimals)
const FUND_TOPUP_THRESHOLD_RAW = 15_000_000n; // top up when below 15 USDC
const GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PER_TX_LIMIT = "20000000"; // 20 USDC per single transaction
const DAILY_USD_BUDGET = "50";

export async function ensureProvisioned(opts: {
  root: string;
  force?: boolean;
  log?: (msg: string) => void;
}): Promise<ProvisionResult> {
  const { root, force = false, log = () => {} } = opts;
  const config = loadDemoConfig(root);
  const client = new AgentApiClient(config.baseUrl, config.apiKey);
  let state: DemoState = loadState(root);

  // 1. Partner API key (testnet: mint one for free and cache it)
  if (!config.apiKey && !state.api_key) {
    if (config.network === "mainnet") {
      throw new Error("Mainnet requires AGENT_API_KEY in .env (a real partner key).");
    }
    log("Minting free testnet partner key (POST /v1/keys)…");
    state.api_key = await new AgentApiClient(config.baseUrl).createKey("hermes-demo");
    saveState(root, state);
  }
  const apiKey = config.apiKey ?? state.api_key!;
  client.setApiKey(apiKey);

  // 2. Owner key
  let owner: OwnerKey;
  if (config.ownerPrivateKey) {
    if (!config.ownerAccountId) throw new Error("OWNER_PRIVATE_KEY requires OWNER_ACCOUNT_ID in .env.");
    owner = ownerFromSeed(config.ownerPrivateKey, config.ownerAccountId);
    log(`Using owner key from env for ${config.ownerAccountId}`);
  } else if (state.owner_jwk) {
    owner = ownerFromJwk(state.owner_jwk);
  } else {
    if (config.network === "mainnet") {
      throw new Error(
        "Mainnet requires OWNER_ACCOUNT_ID + OWNER_PRIVATE_KEY in .env (full-access key of your NEAR account).",
      );
    }
    owner = generateOwner();
    log(`Generated throwaway owner key (implicit testnet account ${owner.account_id.slice(0, 12)}…)`);
  }
  state.owner_jwk = ownerToJwk(owner);
  state.owner_account_id = owner.account_id;
  state.owner_public_key = owner.public_key;
  saveState(root, state);

  // 3. Asset selection from the live token list
  const tokens = await client.tokens();
  const nearTokens = tokens.filter((t) => t.blockchain === "near");
  const funded = nearTokens.find((t) => t.symbol === "USDC");
  if (!funded) throw new Error("No NEAR-chain USDC in GET /v1/tokens — cannot run the demo.");
  const second =
    nearTokens.find((t) => t.asset_id !== funded.asset_id && (t.symbol === "WNEAR" || t.symbol === "wNEAR")) ??
    nearTokens.find((t) => t.asset_id !== funded.asset_id && t.price);
  if (!second) throw new Error("No second NEAR-chain token found for the allowed-assets list.");
  const allowedIds = new Set([funded.asset_id, second.asset_id, ...(config.extraAllowedAssets ?? [])]);
  const blocked =
    tokens.find((t) => !allowedIds.has(t.asset_id) && t.blockchain !== "near" && t.symbol === "USDC") ??
    tokens.find((t) => !allowedIds.has(t.asset_id));
  if (!blocked) throw new Error("Could not find a disallowed asset for recipe 3 — token list too small?");
  const assets: DemoState["assets"] = {
    funded: funded.asset_id,
    fundedSymbol: funded.symbol ?? "USDC",
    second: second.asset_id,
    secondSymbol: second.symbol ?? "WNEAR",
    blocked: blocked.asset_id,
    blockedSymbol: blocked.symbol ?? blocked.asset_id,
  };
  state.assets = assets;
  state.per_transaction_limit_raw = PER_TX_LIMIT;
  saveState(root, state);

  // 4. Reuse the provisioned agent + grant when still valid
  const grantFresh =
    state.grant_token &&
    state.grant_expires_at &&
    new Date(state.grant_expires_at).getTime() > Date.now() + 60 * 60 * 1000;
  if (!force && config.network === "testnet" && state.agent_id && grantFresh) {
    let alive = false;
    try {
      const agent = await client.getAgent(state.agent_id);
      alive = agent.status === "ACTIVE";
      if (!alive) log(`Agent ${state.agent_id} is ${agent.status}; provisioning a fresh one.`);
    } catch {
      log("Previous agent no longer readable; provisioning a fresh one.");
    }
    if (alive) {
      log(`Reusing provisioned agent ${state.agent_id}`);
      await fundIfNeeded(client, config, state, assets, log);
      await writeArtifacts(root, config, state, log);
      return { config, state, client, reused: true };
    }
  }

  // 5. agent_create — owner intent #1
  const policy = demoPolicy({
    ownerAccountId: owner.account_id,
    allowedAssets: [...allowedIds],
    fundedAsset: funded.asset_id,
    perTransactionLimit: PER_TX_LIMIT,
    dailyUsd: DAILY_USD_BUDGET,
  });
  state.policy = policy;
  saveState(root, state);

  log("Creating agent (agent_create intent, owner NEP-413 signature)…");
  const created = await ownedIntent(client, owner, "agent_create", {
    name: "Hermes demo agent",
    owner: { type: "near", account_id: owner.account_id, public_key: owner.public_key },
    policy,
  });
  state.agent_id = created.status.agent_id ?? created.generated.agent_id;
  const agentInfo = await client.getAgent(state.agent_id!);
  state.agent_wallet = agentInfo.wallet?.near_account_id;
  log(`Agent ${state.agent_id} is ACTIVE (wallet ${state.agent_wallet})`);
  saveState(root, state);

  // 6. grant_issue — owner intent #2
  const grantToken = "ngt_" + crypto.randomBytes(32).toString("base64url");
  const commitment = crypto.createHash("sha256").update(grantToken, "utf8").digest("hex");
  log("Issuing grant (grant_issue intent, owner NEP-413 signature)…");
  const granted = await ownedIntent(client, owner, "grant_issue", {
    agent_id: state.agent_id,
    label: "Hermes demo grant",
    credential: commitment,
    expires_at: new Date(Date.now() + GRANT_TTL_MS).toISOString(),
  });
  state.grant_token = grantToken;
  state.grant_expires_at =
    (granted.status.details?.grant as { expires_at?: string } | undefined)?.expires_at ??
    new Date(Date.now() + GRANT_TTL_MS).toISOString();
  log(`Grant issued (token ${grantToken.slice(0, 8)}…, expires ${state.grant_expires_at})`);
  saveState(root, state);

  // 7. Fund from the testnet faucet (mainnet: manual deposit — see README)
  await fundIfNeeded(client, config, state, assets, log);

  await writeArtifacts(root, config, state, log);
  return { config, state, client, reused: false };
}

/** Top up the funded asset from the testnet faucet when it runs low. */
async function fundIfNeeded(
  client: AgentApiClient,
  config: DemoConfig,
  state: DemoState,
  assets: NonNullable<DemoState["assets"]>,
  log: (msg: string) => void,
): Promise<void> {
  const fundedAssetId = assets.funded;
  const balances = await client.getBalances(state.agent_id!);
  const fundedBalance = BigInt(balances.balances.find((b) => b.asset_id === fundedAssetId)?.balance_raw ?? "0");
  if (fundedBalance < FUND_TOPUP_THRESHOLD_RAW) {
    if (config.network === "mainnet") {
      log(`Fund the agent manually: send ${assets.fundedSymbol} to ${state.agent_wallet}, then re-run.`);
      throw new Error("Mainnet agent is unfunded; deposit first (see README) and re-run provision.");
    }
    log(`Funding ${assets.fundedSymbol} from the testnet faucet…`);
    const deposit = await client.action("deposit", state.agent_id!, {
      origin_asset: fundedAssetId,
      testnet_faucet: true,
    });
    const st = await client.settle(deposit.correlation_id, 180000);
    if (st.status !== "SUCCESS") throw new Error(`Faucet deposit failed: ${st.status}`);
    log("Faucet deposit settled.");
  } else {
    log("Sufficient balance already; skipping faucet.");
  }
}

/** generate-intent → owner signs intent.payload (NEP-413) → submit-intent → settle. */
async function ownedIntent(
  client: AgentApiClient,
  owner: OwnerKey,
  type: string,
  body: Record<string, unknown>,
): Promise<{ generated: Awaited<ReturnType<AgentApiClient["generateIntent"]>>; status: Awaited<ReturnType<AgentApiClient["settle"]>> }> {
  const generated = await client.generateIntent({ type, ...body }, `hermes-demo-${crypto.randomUUID()}`);
  if (generated.intent.standard !== "nep413") {
    throw new Error(
      `This demo signs NEP-413 owner intents, but the API returned standard "${generated.intent.standard}". ` +
        `Mainnet agent_create uses nep366 wallet signing — see README ("Mainnet mode").`,
    );
  }
  const payload = generated.intent.payload as { message: string; nonce: string; recipient: string };
  const signature = signNep413(owner, payload);
  await client.submitIntent(type, generated.correlation_id, {
    standard: "nep413",
    payload: generated.intent.payload,
    public_key: owner.public_key,
    signature,
  });
  const status = await client.settle(generated.correlation_id, 120000);
  return { generated, status };
}

/** Merge provisioning outputs into .env (preserving user keys) and write profile/.env for Hermes. */
async function writeArtifacts(
  root: string,
  config: DemoConfig,
  state: DemoState,
  log: (msg: string) => void,
): Promise<void> {
  const assets = state.assets!;
  const rootEnv = {
    AGENT_API_URL: config.baseUrl,
    AGENT_API_KEY: config.apiKey ?? state.api_key ?? "",
    AGENT_ID: state.agent_id ?? "",
    HERMES_GRANT_TOKEN: state.grant_token ?? "",
    OWNER_ACCOUNT_ID: state.owner_account_id ?? "",
    FUNDING_ASSET_ID: assets.funded,
    FUNDING_SYMBOL: assets.fundedSymbol,
    SECOND_ASSET_ID: assets.second,
    SECOND_SYMBOL: assets.secondSymbol,
    BLOCKED_ASSET_ID: assets.blocked,
    BLOCKED_SYMBOL: assets.blockedSymbol,
    PER_TX_LIMIT_RAW: state.per_transaction_limit_raw ?? "",
  };
  loadEnvFile(path.join(root, ".env")); // keep user-set vars (NEAR_AI_API_KEY, RUN_HERMES, …)
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(rootEnv)) merged[k] = v;
  for (const key of ["NEAR_AI_API_KEY", "RUN_HERMES", "OWNER_PRIVATE_KEY"]) {
    const v = process.env[key];
    if (v) merged[key] = v;
  }
  if (!merged.NEAR_AI_API_KEY) delete merged.NEAR_AI_API_KEY;
  writeEnvFile(path.join(root, ".env"), merged);

  // profile/.env is what Hermes' ${VAR} substitution resolves against.
  // NEAR_AI_API_KEY is only written when actually set — an empty value here
  // would shadow the real key passed via the environment (docker --env-file).
  const profileEnv: Record<string, string> = {
    AGENT_API_URL: config.baseUrl,
    AGENT_API_KEY: rootEnv.AGENT_API_KEY,
    AGENT_GRANT_TOKEN: rootEnv.HERMES_GRANT_TOKEN,
    AGENT_ID: rootEnv.AGENT_ID,
  };
  if (process.env.NEAR_AI_API_KEY) profileEnv.NEAR_AI_API_KEY = process.env.NEAR_AI_API_KEY;
  writeEnvFile(path.join(root, "profile", ".env"), profileEnv);

  if (config.network === "testnet") {
    log(`\nProvisioned against Tidepool testnet (${NETWORKS.testnet}). Tokens have no value.`);
  }
}
