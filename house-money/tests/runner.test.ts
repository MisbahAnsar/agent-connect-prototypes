import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { MockAgentApi, POLICY_COOLDOWN_MS } from "./fake-agent-api";
import { buildHouseMoneyPolicy } from "../src/policy/policy";
import { FileStateStore } from "../src/runner/file-store";
import { HouseMoneyRunner, type RunnerConfig } from "../src/runner/runner";
import { MemoryStateStore, type StateStore } from "../src/runner/store";

const ASSET = "nep141:usdc-test";
const AGENT = "a1";
const SAFE = "0xsafe";
const P = 1_000_000n;

async function setup(balance = P, expiresInMs = 600_000) {
  const api = new MockAgentApi([]);
  api.setTokens([
    {
      asset_id: ASSET, symbol: "USDC", decimals: 6, blockchain: "near", price: 1,
      price_updated_at: api.clock.date().toISOString(),
      price_expires_at: new Date(api.clock.now() + expiresInMs).toISOString(),
    },
  ]);
  api.createAgent(AGENT, { [ASSET]: balance });
  await api.updatePolicy(
    AGENT,
    buildHouseMoneyPolicy({ asset: ASSET, principalAtomic: P, chain: "base", safeAddress: SAFE, timelockMs: 10_000 }),
    0,
  );
  const { token } = await api.issueGrant(AGENT, "r", new Date(api.clock.now() + 86_400_000));
  const store = new MemoryStateStore();
  const make = (s: StateStore = store, extra: Partial<RunnerConfig> = {}) =>
    new HouseMoneyRunner({
      client: api, grant: api.forGrant(token), agentId: AGENT, asset: ASSET,
      principalAtomic: P, principalMicroUsd: P, chain: "base", safeAddress: SAFE,
      store: s, now: () => api.clock.date(), ...extra,
    });
  return { api, make, store };
}

describe("HouseMoneyRunner", () => {
  it("does nothing below 2x", async () => {
    const { api, make } = await setup(P + P / 2n);
    const r = make();
    await r.tick();
    assert.equal(r.log.ofType("trigger").length, 0);
    assert.equal((await api.listScheduledExecutions(AGENT)).length, 0);
  });

  it("banks exactly the principal at 2x and settles after the timelock", async () => {
    const { api, make, store } = await setup(2n * P);
    const r = make();
    await r.tick();
    assert.equal(r.log.ofType("withdraw_queued").length, 1);
    assert.equal((await store.load()).banked, true);
    api.advance(10_000);
    await r.tick();
    assert.equal(r.log.ofType("withdraw_settled").length, 1);
    assert.equal(api.settled.length, 1);
    assert.equal(api.settled[0]!.request.amount, P.toString());
    await r.tick();
    assert.equal(r.log.ofType("withdraw_settled").length, 1, "settlement reported once");
  });

  it("never triggers twice, even as equity keeps rising", async () => {
    const { api, make } = await setup(2n * P);
    const r = make();
    await r.tick();
    api.setBalance(AGENT, ASSET, 10n * P);
    await r.tick();
    await r.tick();
    assert.equal(r.log.ofType("trigger").length, 1);
    assert.equal((await api.listScheduledExecutions(AGENT)).length, 1);
  });

  it("a restarted runner with a lost store replays under the same key (no second withdrawal)", async () => {
    const { api, make } = await setup(2n * P);
    await make(new MemoryStateStore()).tick();
    await make(new MemoryStateStore()).tick(); // state lost
    api.advance(10_000);
    assert.equal(api.settled.length, 1);
  });

  it("a restarted runner with persisted state does not even evaluate the trigger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hm-"));
    const path = join(dir, "state.json");
    const { api, make } = await setup(2n * P);
    await make(new FileStateStore(path)).tick();
    assert.equal(JSON.parse(await readFile(path, "utf8")).banked, true);
    const again = make(new FileStateStore(path));
    await again.tick();
    assert.equal(again.log.ofType("trigger").length, 0);
    assert.equal((await api.listScheduledExecutions(AGENT)).length, 1);
  });

  it("fails closed on a stale price: no trigger, no withdrawal", async () => {
    const { api, make } = await setup(5n * P, 1000);
    api.advance(2000);
    const r = make();
    await r.tick();
    assert.equal(r.log.ofType("price_unavailable").length, 1);
    assert.equal(r.log.ofType("trigger").length, 0);
    assert.equal((await api.listScheduledExecutions(AGENT)).length, 0);
  });

  it("records a policy refusal and stays un-banked so it can retry", async () => {
    const { api, make, store } = await setup(2n * P);
    const { policy, revision } = await api.getPolicy(AGENT);
    await api.updatePolicy(AGENT, { ...policy!, frozen: true }, revision!);
    const r = make();
    await r.tick();
    assert.deepEqual(r.log.ofType("refused").map((e) => e.code), ["wallet_frozen"]);
    assert.equal((await store.load()).banked, false);
  });

  it("reports a cancelled exit as failed", async () => {
    const { api, make } = await setup(2n * P);
    const r = make();
    await r.tick();
    const [op] = await api.listScheduledExecutions(AGENT);
    await api.cancelExecution(AGENT, op!.correlation_id);
    await r.tick();
    assert.equal(r.log.ofType("withdraw_failed").length, 1);
  });

  it("run() survives errors and stops on abort", async () => {
    const { make } = await setup(P);
    const r = make();
    let calls = 0;
    const orig = r.tick.bind(r);
    r.tick = async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return orig();
    };
    const ac = new AbortController();
    const done = r.run(5, ac.signal);
    await new Promise((res) => setTimeout(res, 80));
    ac.abort();
    await done;
    assert.ok(calls >= 2);
    assert.equal(r.log.ofType("error").length, 1);
  });
});

describe("HouseMoneyRunner post-bank seal (opt-in)", () => {
  const SAFE_REQ = { asset: ASSET, amount: "1", chain: "base", recipient: SAFE };

  it("is off by default: after settlement a new key can still withdraw to the safe account", async () => {
    const { api, make } = await setup(2n * P);
    const r = make();
    await r.tick();
    api.advance(10_000);
    await r.tick();
    assert.equal(r.log.ofType("policy_sealed").length, 0);
    const { token } = await api.issueGrant(AGENT, "x", new Date(api.clock.now() + 1000));
    const op = await api.forGrant(token).withdraw(AGENT, SAFE_REQ, { idempotencyKey: "fresh" });
    assert.equal(op.status, "QUEUED");
  });

  it("drops withdraw after settlement, waiting out the 10-minute edit cooldown", async () => {
    const { api, make } = await setup(2n * P);
    const r = make(undefined, { sealAfterSettlement: true });
    await r.tick();
    api.advance(10_000);
    await r.tick(); // settled; the policy was edited moments ago, so the seal is deferred
    assert.deepEqual(r.log.ofType("seal_deferred").map((e) => e.code), ["policy_change_throttled"]);
    assert.equal(r.log.ofType("policy_sealed").length, 0);

    api.advance(POLICY_COOLDOWN_MS);
    await r.tick();
    assert.equal(r.log.ofType("policy_sealed").length, 1);
    await r.tick();
    await r.tick();
    assert.equal(r.log.ofType("policy_sealed").length, 1, "sealed once");

    const { token } = await api.issueGrant(AGENT, "x", new Date(api.clock.now() + 1000));
    await assert.rejects(api.forGrant(token).withdraw(AGENT, SAFE_REQ, { idempotencyKey: "fresh" }), (e) => (e as { code?: string }).code === "policy_action_denied");
  });

  it("does not seal when the exit was cancelled (the principal is still in the agent)", async () => {
    const { api, make } = await setup(2n * P);
    const r = make(undefined, { sealAfterSettlement: true });
    await r.tick();
    const [op] = await api.listScheduledExecutions(AGENT);
    await api.cancelExecution(AGENT, op!.correlation_id);
    api.advance(POLICY_COOLDOWN_MS);
    await r.tick();
    await r.tick();
    assert.equal(r.log.ofType("policy_sealed").length, 0);
    assert.equal(r.log.ofType("seal_deferred").length, 0);
  });
});
