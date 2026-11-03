import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { TRADE_AGENT, TRADE_SAFE, TRADE_STABLE, TradingSimulation } from "../harness/trading-simulation";
import { pickRateAsset, runRefusalMatrix } from "../harness/refusals";

const byId = (checks: Awaited<ReturnType<typeof runRefusalMatrix>>) => Object.fromEntries(checks.map((c) => [c.id, c]));

describe("refusal matrix", () => {
  it("every check passes once the principal has been banked", async () => {
    const s = await new TradingSimulation({ maxActionsPerHour: 5 }).init();
    await s.runToEnd();
    const checks = await runRefusalMatrix(s);
    for (const c of checks) assert.ok(c.pass, `${c.id}: expected ${c.expected}, got ${c.got}`);
    assert.deepEqual(Object.keys(byId(checks)), [
      "reverse", "other-address", "other-chain", "memo", "other-asset", "over-cap", "replay", "revoked", "rate",
    ]);
  });

  it("also holds mid-flight, while the exit is still queued", async () => {
    const s = await new TradingSimulation({ maxActionsPerHour: 5 }).init();
    for (let i = 0; i < 25; i++) await s.step(); // trigger mid-rally, 3s veto window still open
    assert.equal((await s.api.listScheduledExecutions(TRADE_AGENT)).length >= 1, true);
    const checks = await runRefusalMatrix(s);
    for (const c of checks) assert.ok(c.pass, `${c.id}: expected ${c.expected}, got ${c.got}`);
  });

  it("holds before the trigger too (replay is skipped: nothing to replay)", async () => {
    const s = await new TradingSimulation({ maxActionsPerHour: 5 }).init();
    for (let i = 0; i < 5; i++) await s.step();
    const checks = byId(await runRefusalMatrix(s));
    assert.equal(checks["replay"], undefined);
    for (const c of Object.values(checks)) assert.ok(c.pass, `${c.id}: expected ${c.expected}, got ${c.got}`);
  });

  it("the rate limit frees up again an hour later", async () => {
    const s = await new TradingSimulation({ maxActionsPerHour: 5 }).init();
    await s.runToEnd();
    await runRefusalMatrix(s);
    s.api.advance(3_600_001);
    const asset = await pickRateAsset(s);
    const op = await s.grant.withdraw(
      TRADE_AGENT,
      { asset, amount: "1", chain: "base", recipient: TRADE_SAFE },
      { idempotencyKey: "after-the-hour" },
    );
    assert.ok(op.correlation_id);
  });

  it("documents a known gap: a NEW key can still withdraw up to the cap to the safe account", async () => {
    // The per-transaction cap stays at the principal forever, so a second exit under a different
    // key is policy-legal. It can only go to the owner's safe account, but it is not "exactly once"
    // at the policy layer. Closing it needs a post-bank policy_update (sealAfterSettlement).
    const s = await new TradingSimulation().init();
    await s.runToEnd();
    const op = await s.grant.withdraw(
      TRADE_AGENT,
      { asset: TRADE_STABLE, amount: "100000000", chain: "base", recipient: TRADE_SAFE },
      { idempotencyKey: "fresh-key" },
    );
    assert.equal(op.status, "QUEUED");
  });
});
