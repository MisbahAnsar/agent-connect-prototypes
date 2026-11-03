/**
 * Recipe 4 — the live chaos recipe: drives the provisioned agent through the refusal matrix and
 * the money paths against the REAL hosted API, one probe at a time, and reports PASS/FAIL/SKIP.
 *
 *   npm run provision        (once, then fund the printed address)
 *   npm run recipe:4
 *
 * Moves (valueless) funds by design: a dust round-trip swap and a small withdrawal to your safe
 * address. On tidepool that is free play money; on mainnet it is real — the HOUSE_CONFIRM gate
 * applies. Set CHAOS_REVOKE=1 to also verify a revoked grant is locked out (kills the runner's
 * grant: re-run `npm run provision` afterwards).
 */
import { createAgentApi } from "@near-intents-agent-api/sdk";
import { loadDotEnv, networkFromEnv } from "../src/config";
import { AgentApiError } from "../src/errors";
import { LiveAgentApi } from "../src/agent-api/live";
import type { Operation } from "../src/agent-api/types";
import { loadProvisioned, ownerFromEnvOrState } from "../src/state";

type Outcome = { id: string; label: string; status: "PASS" | "FAIL" | "WARN" | "SKIP"; detail?: string };
const results: Outcome[] = [];

/** Codes the original README flagged as inferred (the API docs do not specify them). */
const INFERRED = new Set(["policy_denied", "agent_grant_required"]);

function report(id: string, label: string, status: Outcome["status"], detail?: string) {
  results.push({ id, label, status, detail });
  console.log(`  [${status.padEnd(4)}] ${id}${detail ? ` — ${detail}` : ""}`);
}

/** Runs one refusal probe: expects an error with `expected`; mismatch on an inferred code is a WARN. */
async function refusalProbe(id: string, label: string, expected: string, attempt: () => Promise<unknown>) {
  try {
    await attempt();
    report(id, label, "FAIL", `allowed (expected ${expected})`);
  } catch (e) {
    const code = e instanceof AgentApiError ? e.code : `unexpected:${String(e).slice(0, 80)}`;
    if (code === expected) report(id, label, "PASS", code);
    else if (INFERRED.has(expected)) report(id, label, "WARN", `got ${code}, expected ${expected} (inferred code — confirm with the API team)`);
    else report(id, label, "FAIL", `got ${code}, expected ${expected}`);
  }
}

/** Polls an operation until it leaves QUEUED/PROCESSING (tidepool settles fast; the cap is generous). */
async function settle(live: LiveAgentApi, op: Operation, timeoutMs = 90_000): Promise<Operation> {
  const deadline = Date.now() + timeoutMs;
  let current = op;
  while ((current.status === "QUEUED" || current.status === "PROCESSING") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2_000));
    current = await live.getStatus(op.correlation_id);
  }
  return current;
}

loadDotEnv();
const state = await loadProvisioned();
const net = networkFromEnv();

if (net.name === "mainnet" && process.env.HOUSE_CONFIRM !== "spend-real-funds") {
  console.error("Mainnet: the chaos recipe moves real funds. Re-run with HOUSE_CONFIRM=spend-real-funds to proceed.");
  process.exit(2);
}

const live = new LiveAgentApi({ apiKey: state.apiKey, baseUrl: state.baseUrl, owner: ownerFromEnvOrState(), balancesSource: net.balancesSource });
const sdk = createAgentApi({ apiKey: state.apiKey, baseUrl: state.baseUrl });
const grant = live.forGrant(state.grantToken);
const agentId = state.agentId;

console.log(`Chaos recipe on ${net.label} — agent ${agentId}`);
console.log(`Stake ${state.principalWhole} ${state.stakeSymbol}; safe ${state.safeAddress} on ${state.safeChain}\n`);

// ── 1. catalog + balances ─────────────────────────────────────────────────
let stakeBal = 0n;
try {
  const { balances } = await grant.getBalances(agentId);
  stakeBal = BigInt(balances[state.stakeAsset] ?? "0");
  report("balances", "read balances under the grant", "PASS", `${stakeBal} ${state.stakeSymbol} atomic`);
} catch (e) {
  report("balances", "read balances under the grant", "FAIL", e instanceof AgentApiError ? e.code : String(e));
}

const principalAtomic = BigInt(state.principalAtomic);
if (stakeBal === 0n) {
  console.log("\nAgent is unfunded — the money probes need a stake. Quote probes still run.\n");
  try {
    const deposit = await sdk.deposit(agentId, { origin_asset: state.stakeAsset });
    const d = (deposit as { details?: { deposit_address?: string | null; min_amount?: string | null; expires_at?: string | null } }).details ?? {};
    console.log(`Fund it: send ≥ ${d.min_amount ?? "(catalog minimum)"} ${state.stakeSymbol} to ${d.deposit_address}${d.expires_at ? ` (expires ${d.expires_at})` : ""}`);
  } catch {
    console.log(`Fund it via \`npm run provision\`'s deposit address (or re-run provision for a fresh one).`);
  }
}

// ── 2. quote probe (no funds at risk) ─────────────────────────────────────
if (state.riskAsset) {
  try {
    const { amountOut } = await grant.quote(agentId, { origin_asset: state.stakeAsset, destination_asset: state.riskAsset, amount: (principalAtomic / 10n).toString() });
    report("quote", "dry-run quote stake → risk", BigInt(amountOut) > 0n ? "PASS" : "FAIL", `amountOut ${amountOut}`);
  } catch (e) {
    report("quote", "dry-run quote stake → risk", "FAIL", e instanceof AgentApiError ? e.code : String(e));
  }
} else {
  report("quote", "dry-run quote stake → risk", "SKIP", "no HOUSE_RISK_ASSET provisioned");
}

if (stakeBal === 0n) {
  console.log("\nRemaining probes need funds. Provision, fund, re-run.");
  printSummary();
  process.exit(2);
}

// ── 3. dust round-trip swap ───────────────────────────────────────────────
const swapAmount = stakeBal / 10n;
if (state.riskAsset && swapAmount > 0n) {
  try {
    const { amountOut } = await grant.quote(agentId, { origin_asset: state.stakeAsset, destination_asset: state.riskAsset, amount: swapAmount.toString() });
    const minOut = (BigInt(amountOut) * 9_500n) / 10_000n; // 5% guard; tidepool fills immediately
    const op = await grant.swap(agentId, { origin_asset: state.stakeAsset, destination_asset: state.riskAsset, amount: swapAmount.toString(), min_amount_out: minOut.toString() }, { idempotencyKey: `chaos:${agentId}:out` });
    const done = await settle(live, op);
    report("swap-out", `swap ${swapAmount} ${state.stakeSymbol} → risk`, done.status === "SUCCESS" ? "PASS" : "FAIL", `${done.status}${done.failure_code ? ` (${done.failure_code})` : ""}${done.swap?.amountOut ? ` out ${done.swap.amountOut}` : ""}`);

    const outAmount = BigInt(done.swap?.amountOut ?? "0");
    if (done.status === "SUCCESS" && outAmount > 0n) {
      const { amountOut: backQuote } = await grant.quote(agentId, { origin_asset: state.riskAsset, destination_asset: state.stakeAsset, amount: outAmount.toString() });
      const backMin = (BigInt(backQuote) * 9_500n) / 10_000n;
      const back = await grant.swap(agentId, { origin_asset: state.riskAsset, destination_asset: state.stakeAsset, amount: outAmount.toString(), min_amount_out: backMin.toString() }, { idempotencyKey: `chaos:${agentId}:back` });
      const backDone = await settle(live, back);
      report("swap-back", "swap the proceeds back to the stake asset", backDone.status === "SUCCESS" ? "PASS" : "FAIL", `${backDone.status}${backDone.failure_code ? ` (${backDone.failure_code})` : ""}`);
    } else {
      report("swap-back", "swap the proceeds back to the stake asset", "SKIP", "swap-out did not settle");
    }
  } catch (e) {
    report("swap-out", "dust round-trip swap", "FAIL", e instanceof AgentApiError ? e.code : String(e));
    report("swap-back", "swap the proceeds back to the stake asset", "SKIP", "swap-out failed");
  }
} else {
  report("swap-out", "dust round-trip swap", "SKIP", "no risk asset provisioned");
  report("swap-back", "swap the proceeds back to the stake asset", "SKIP", "no risk asset provisioned");
}

// ── 4. refusal matrix (no funds at risk) ──────────────────────────────────
const withdrawChaos = (over: Partial<{ amount: string; chain: string; recipient: string; asset: string; memo: string | null }>, key: string) =>
  grant.withdraw(agentId, { asset: state.stakeAsset, amount: stakeBal.toString(), chain: state.safeChain, recipient: state.safeAddress, ...over }, { idempotencyKey: key });

await refusalProbe("refuse-transfer", "“give me my money back” (transfer out)", "policy_action_denied",
  () => grant.transfer(agentId, { asset: state.stakeAsset, amount: "1", recipient: state.ownerAccountId }));
await refusalProbe("refuse-address", "withdraw to another address", "policy_destination_denied",
  () => withdrawChaos({ recipient: "0xdead0000000000000000000000000000000000" }, `chaos:${agentId}:addr`));
await refusalProbe("refuse-chain", "withdraw to the safe address on another chain", "policy_destination_denied",
  () => withdrawChaos({ chain: "near" }, `chaos:${agentId}:chain`));
await refusalProbe("refuse-asset", "withdraw an unlisted asset", "policy_denied",
  () => withdrawChaos({ asset: "nep141:chaos-not-listed" }, `chaos:${agentId}:asset`));
await refusalProbe("refuse-cap", "withdraw over the per-transaction cap", "policy_limit_exceeded",
  () => withdrawChaos({ amount: (principalAtomic + 1n).toString() }, `chaos:${agentId}:cap`));

// ── 5. idempotency: a real (small) withdrawal to the safe address ─────────
const exitAmount = stakeBal < principalAtomic ? stakeBal : principalAtomic;
let exitId: string | undefined;
try {
  const op = await grant.withdraw(agentId, { asset: state.stakeAsset, amount: exitAmount.toString(), chain: state.safeChain, recipient: state.safeAddress }, { idempotencyKey: `chaos:${agentId}:exit` });
  exitId = op.correlation_id;
  const done = await settle(live, op);
  report("withdraw", `withdraw ${exitAmount} ${state.stakeSymbol} to the safe address`, done.status === "SUCCESS" || done.status === "QUEUED" ? "PASS" : "FAIL", `${done.status}${done.failure_code ? ` (${done.failure_code})` : ""}`);

  const replay = await grant.withdraw(agentId, { asset: state.stakeAsset, amount: exitAmount.toString(), chain: state.safeChain, recipient: state.safeAddress }, { idempotencyKey: `chaos:${agentId}:exit` });
  report("idem-replay", "same key + same body replays the original", replay.correlation_id === exitId ? "PASS" : "FAIL", replay.correlation_id);

  await refusalProbe("idem-conflict", "same key + different body is a conflict", "idempotency_conflict",
    () => grant.withdraw(agentId, { asset: state.stakeAsset, amount: exitAmount.toString(), chain: state.safeChain, recipient: state.safeAddress, memo: "different" }, { idempotencyKey: `chaos:${agentId}:exit` }));
} catch (e) {
  report("withdraw", "small withdrawal to the safe address", "FAIL", e instanceof AgentApiError ? e.code : String(e));
  report("idem-replay", "same key + same body replays the original", "SKIP", "withdraw failed");
  report("idem-conflict", "same key + different body is a conflict", "SKIP", "withdraw failed");
}

// ── 6. owner veto window (mainnet only: tidepool rejects timelock_ms) ─────
if (net.name === "tidepool") {
  report("veto", "cancel a queued exit during the veto window", "SKIP", "tidepool has no timelock — mainnet only");
} else {
  try {
    const scheduled = await live.listScheduledExecutions(agentId);
    const target = scheduled.find((o) => o.correlation_id === exitId) ?? scheduled[0];
    if (!target) {
      report("veto", "cancel a queued exit during the veto window", "FAIL", "nothing is scheduled");
    } else {
      await live.cancelExecution(agentId, target.correlation_id);
      const op = await live.getStatus(target.correlation_id);
      report("veto", "cancel a queued exit during the veto window", op.status === "CANCELLED" ? "PASS" : "FAIL", op.status);
    }
  } catch (e) {
    report("veto", "cancel a queued exit during the veto window", "FAIL", e instanceof AgentApiError ? e.code : String(e));
  }
}

// ── 7. revoked grant (destructive only to a throwaway grant) ──────────────
if (process.env.CHAOS_REVOKE === "1") {
  try {
    const expires = new Date(Date.now() + 60_000);
    const { token } = await live.issueGrant(agentId, "chaos:revoked", expires);
    await live.revokeGrant(agentId, token);
    await refusalProbe("revoked", "use a revoked grant", "agent_grant_required",
      () => live.forGrant(token).getBalances(agentId));
  } catch (e) {
    report("revoked", "use a revoked grant", "FAIL", e instanceof AgentApiError ? e.code : String(e));
  }
} else {
  report("revoked", "use a revoked grant", "SKIP", "set CHAOS_REVOKE=1 (re-provision afterwards)");
}

printSummary();

process.exit(results.some((r) => r.status === "FAIL") ? 1 : 0);

function printSummary() {
  const pass = results.filter((r) => r.status === "PASS").length;
  const skip = results.filter((r) => r.status === "SKIP").length;
  const warn = results.filter((r) => r.status === "WARN").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  console.log(`\n${pass} PASS · ${fail} FAIL · ${warn} WARN · ${skip} SKIP`);
  if (warn > 0) console.log("WARNs are inferred error codes — worth confirming with the API team.");
}
