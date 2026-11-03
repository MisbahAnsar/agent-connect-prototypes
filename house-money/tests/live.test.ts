import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createGrantCredential, grantCommitment, type GenerateIntentResponse, type SignedData } from "@near-intents-agent-api/sdk";
import { AgentApiError } from "../src/errors";
import { buildHouseMoneyPolicy } from "../src/policy/policy";
import { LiveAgentApi, mapStatus, quoteAmountOut, type OwnerSigner } from "../src/agent-api/live";

const KEY = `naa_${"A".repeat(43)}`;
const AGENT = "agent-1";
const ASSET = "nep141:usdc-test";

type Seen = { method: string; path: string; headers: Record<string, string>; body: unknown };
type Route = (req: Seen) => { status?: number; json: unknown };

/** A fake network: the real SDK builds the requests, this answers them. */
function fakeApi(routes: Record<string, Route>) {
  const seen: Seen[] = [];
  const fetchFn = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const req: Seen = {
      method: init?.method ?? "GET",
      path: url.pathname,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(req);
    const route = routes[`${req.method} ${req.path}`];
    if (!route) return new Response(JSON.stringify({ errors: [{ code: "not_found", title: "x" }] }), { status: 404 });
    const { status = 200, json } = route(req);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, seen };
}

const policyIntent = (_: Seen) => ({
  json: { type: "policy_update", correlation_id: "c-policy", intent: { standard: "nep366", payload: { p: 1 } } },
});
const signer = (calls: GenerateIntentResponse[] = []): OwnerSigner => ({
  async sign(generated) {
    calls.push(generated);
    return { signed: "by-owner" } as unknown as SignedData;
  },
});
const success = (type: string, extra = {}) => ({ type, correlation_id: "c-1", agent_id: AGENT, status: "SUCCESS", failure_code: null, ...extra });

describe("LiveAgentApi (through the real SDK, fake network)", () => {
  it("quotes a swap with dry:true and no idempotency key, and reads the output amount", async () => {
    const { token } = createGrantCredential();
    const { fetchFn, seen } = fakeApi({
      [`POST /v1/agents/${AGENT}/swap`]: () => ({ status: 202, json: { dry: true, type: "swap", quote: { quote: { amountOut: "12345" } } } }),
    });
    const live = new LiveAgentApi({ apiKey: KEY, owner: signer(), fetch: fetchFn });
    const out = await live.forGrant(token).quote(AGENT, { origin_asset: "a", destination_asset: "b", amount: "100" });
    assert.deepEqual(out, { amountOut: "12345" });
    assert.equal((seen[0]!.body as { dry: boolean }).dry, true);
    assert.equal(seen[0]!.headers["idempotency-key"], undefined);
  });

  it("swaps under the grant with a min output and a stable key, and reports QUEUED", async () => {
    const { token } = createGrantCredential();
    const { fetchFn, seen } = fakeApi({
      [`POST /v1/agents/${AGENT}/swap`]: () => ({ status: 202, json: { type: "swap", correlation_id: "c-s", agent_id: AGENT, status: "QUEUED", failure_code: null } }),
    });
    const live = new LiveAgentApi({ apiKey: KEY, owner: signer(), fetch: fetchFn });
    const op = await live.forGrant(token).swap(AGENT, { origin_asset: "a", destination_asset: "b", amount: "100", min_amount_out: "90" }, { idempotencyKey: "swap:agent-1:1" });
    assert.equal(op.status, "QUEUED");
    assert.equal(op.swap?.request.min_amount_out, "90");
    assert.equal(seen[0]!.headers["idempotency-key"], "swap:agent-1:1");
    assert.equal(seen[0]!.headers["x-grant-token"], token);
  });

  it("a quote with no output amount is refused, not guessed", async () => {
    const { token } = createGrantCredential();
    const { fetchFn } = fakeApi({ [`POST /v1/agents/${AGENT}/swap`]: () => ({ status: 202, json: { dry: true, type: "swap", quote: { nothing: 1 } } }) });
    const live = new LiveAgentApi({ apiKey: KEY, owner: signer(), fetch: fetchFn });
    await assert.rejects(live.forGrant(token).quote(AGENT, { origin_asset: "a", destination_asset: "b", amount: "1" }), (e: unknown) => e instanceof AgentApiError && e.code === "quote_unavailable");
  });

  it("quoteAmountOut reads camelCase, snake_case and nested fields, and nothing else", () => {
    assert.equal(quoteAmountOut({ amountOut: "5" }), "5");
    assert.equal(quoteAmountOut({ amount_out: 7 }), "7");
    assert.equal(quoteAmountOut({ quote: { amountOut: "9" } }), "9");
    assert.equal(quoteAmountOut({ amountOut: "1.5" }), null);
    assert.equal(quoteAmountOut(null), null);
  });

  it("withdraws with the grant token and a stable idempotency key, and reports QUEUED", async () => {
    const { token } = createGrantCredential();
    const { fetchFn, seen } = fakeApi({
      [`POST /v1/agents/${AGENT}/withdraw`]: () => ({ json: { type: "withdraw", correlation_id: "c-w", agent_id: AGENT, status: "QUEUED", failure_code: null } }),
    });
    const live = new LiveAgentApi({ apiKey: KEY, owner: signer(), fetch: fetchFn });
    const op = await live.forGrant(token).withdraw(
      AGENT,
      { asset: ASSET, amount: "1000", chain: "base", recipient: "0xsafe" },
      { idempotencyKey: "principal:agent-1" },
    );
    assert.equal(op.status, "QUEUED");
    assert.equal(op.correlation_id, "c-w");
    assert.equal(op.idempotencyKey, "principal:agent-1");
    const req = seen[0]!;
    assert.equal(req.headers["x-grant-token"], token);
    assert.equal(req.headers["idempotency-key"], "principal:agent-1");
    assert.deepEqual(req.body, { asset: ASSET, amount: "1000", chain: "base", recipient: "0xsafe" });
  });

  it("turns a policy refusal into the error class the runner handles, keeping the code", async () => {
    const { token } = createGrantCredential();
    const { fetchFn } = fakeApi({
      [`POST /v1/agents/${AGENT}/withdraw`]: () => ({
        status: 403,
        json: { errors: [{ code: "policy_destination_denied", title: "Destination denied", detail: "not in the policy" }], meta: { request_id: "r1" } },
      }),
    });
    const live = new LiveAgentApi({ apiKey: KEY, owner: signer(), fetch: fetchFn });
    await assert.rejects(
      live.forGrant(token).withdraw(AGENT, { asset: ASSET, amount: "1", chain: "base", recipient: "0xevil" }, { idempotencyKey: "k" }),
      (e) => e instanceof AgentApiError && e.code === "policy_destination_denied" && e.status === 403,
    );
  });

  it("reads balances as atomic amounts per asset", async () => {
    const { token } = createGrantCredential();
    const { fetchFn, seen } = fakeApi({
      [`GET /v1/agents/${AGENT}/balances`]: () => ({ json: { balances: [{ asset_id: ASSET, balance_raw: "700" }, { asset_id: ASSET, balance_raw: "300" }, { asset_id: "nep141:other", balance_raw: "5" }] } }),
    });
    const live = new LiveAgentApi({ apiKey: KEY, owner: signer(), fetch: fetchFn });
    const { balances } = await live.forGrant(token).getBalances(AGENT);
    assert.deepEqual(balances, { [ASSET]: "1000", "nep141:other": "5" });
    assert.match(seen[0]!.path + "", /balances/);
  });

  it("applies a policy update through generate, owner signature, submit, wait and read-back", async () => {
    const generated: GenerateIntentResponse[] = [];
    const policy = buildHouseMoneyPolicy({ asset: ASSET, principalAtomic: 1000n, chain: "base", safeAddress: "0xsafe", timelockMs: 30_000 });
    const { fetchFn, seen } = fakeApi({
      "POST /v1/generate-intent": policyIntent,
      "POST /v1/submit-intent": () => ({ json: success("policy_update", { correlation_id: "c-policy" }) }),
      "GET /v1/status": () => ({ json: success("policy_update", { correlation_id: "c-policy" }) }),
      [`GET /v1/agents/${AGENT}/policy`]: () => ({ json: { policy, revision: 5 } }),
    });
    const live = new LiveAgentApi({ apiKey: KEY, owner: signer(generated), fetch: fetchFn, waitMs: 1 });
    const out = await live.updatePolicy(AGENT, policy, 4);
    assert.deepEqual(out, { revision: 5 });
    assert.equal(generated.length, 1);
    const gen = seen.find((r) => r.path === "/v1/generate-intent")!.body as Record<string, unknown>;
    assert.equal(gen.type, "policy_update");
    assert.equal(gen.expected_revision, 4);
    const sub = seen.find((r) => r.path === "/v1/submit-intent")!.body as Record<string, unknown>;
    assert.deepEqual(sub.signed_data, { signed: "by-owner" });
    assert.equal(sub.correlation_id, "c-policy");
  });

  it("throws the API's failure code when an owner intent does not succeed", async () => {
    const { fetchFn } = fakeApi({
      "POST /v1/generate-intent": policyIntent,
      "POST /v1/submit-intent": () => ({ json: success("policy_update", { status: "PROCESSING" }) }),
      "GET /v1/status": () => ({ json: success("policy_update", { status: "FAILED", failure_code: "policy_revision_conflict" }) }),
    });
    const live = new LiveAgentApi({ apiKey: KEY, owner: signer(), fetch: fetchFn, waitMs: 1 });
    const policy = buildHouseMoneyPolicy({ asset: ASSET, principalAtomic: 1n, chain: "base", safeAddress: "0x", timelockMs: 0 });
    await assert.rejects(live.updatePolicy(AGENT, policy, 1), (e) => e instanceof AgentApiError && e.code === "policy_revision_conflict");
  });

  it("revokes a grant by matching its commitment to the listed grant id", async () => {
    const { token } = createGrantCredential();
    const { fetchFn, seen } = fakeApi({
      [`GET /v1/agents/${AGENT}/grants`]: () => ({ json: { data: [{ grant_id: "g-other", owner_message: { credential: "x" } }, { grant_id: "g-mine", owner_message: { credential: grantCommitment(token) } }] } }),
      "POST /v1/generate-intent": () => ({ json: { type: "grant_revoke", correlation_id: "c-rev", intent: { standard: "nep366", payload: {} } } }),
      "POST /v1/submit-intent": () => ({ json: success("grant_revoke", { correlation_id: "c-rev" }) }),
      "GET /v1/status": () => ({ json: success("grant_revoke", { correlation_id: "c-rev" }) }),
    });
    const live = new LiveAgentApi({ apiKey: KEY, owner: signer(), fetch: fetchFn, waitMs: 1 });
    await live.revokeGrant(AGENT, token);
    const gen = seen.find((r) => r.path === "/v1/generate-intent")!.body as Record<string, unknown>;
    assert.equal(gen.type, "grant_revoke");
    assert.equal(gen.grant_id, "g-mine");
  });

  it("lists timelocked executions earliest first as QUEUED operations", async () => {
    const { fetchFn } = fakeApi({
      [`GET /v1/agents/${AGENT}/executions/scheduled`]: () => ({ json: { data: [{ correlation_id: "c-1", execute_after: "2026-10-19T10:00:00Z", state: "scheduled" }], next_cursor: null } }),
    });
    const live = new LiveAgentApi({ apiKey: KEY, owner: signer(), fetch: fetchFn });
    const ops = await live.listScheduledExecutions(AGENT);
    assert.deepEqual(ops.map((o) => [o.correlation_id, o.status, o.execute_after]), [["c-1", "QUEUED", "2026-10-19T10:00:00Z"]]);
  });
});

describe("mapStatus", () => {
  it("never treats an uncertain outcome as failed", () => {
    assert.equal(mapStatus("UNCERTAIN"), "PROCESSING");
    assert.equal(mapStatus("PROCESSING"), "PROCESSING");
    assert.equal(mapStatus("PENDING_SIGNATURE"), "PROCESSING");
    assert.equal(mapStatus("QUEUED"), "QUEUED");
    assert.equal(mapStatus("SUCCESS"), "SUCCESS");
    assert.equal(mapStatus("FAILED"), "FAILED");
    assert.equal(mapStatus("REFUNDED"), "FAILED");
    assert.equal(mapStatus("NEEDS_REVIEW"), "FAILED");
  });
});
