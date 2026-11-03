import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { TRADE_AGENT, TRADE_STABLE, TradingSimulation } from "../harness/trading-simulation";
import { latchPath, staggeredCrashPath } from "../harness/price-paths";
import { HouseMoneyRunner } from "../../src/runner/runner";
import { MemoryStateStore } from "../../src/runner/store";

describe("financial edge cases", () => {
  it("a crash while a sell is queued fails the swap on min_amount_out instead of shortchanging the exit", async () => {
    const s = await new TradingSimulation({ prices: staggeredCrashPath(), slippageBps: 3_000n }).init();
    await s.runToEnd();

    const failed = s.log.ofType("swap_failed").filter((e) => e.failureCode === "min_amount_out_not_met");
    assert.ok(failed.length >= 1, "the crash must strand at least one queued sell below its min output");
    assert.equal(s.api.settled.length, 0, "no exit may settle on short cash");
    // the runner never withdraws principal it does not hold: it keeps waiting for cash
    assert.equal(s.log.ofType("withdraw_queued").length, 0);
    assert.equal(s.log.ofType("awaiting_cash").length, 0, "the trigger never fires on the crashed market");
    // and the trader keeps trying: it re-quotes at the real price after each failure
    const queuedAfterFailure = s.log.ofType("swap_queued").filter((e) => failed.length > 0 && e.at > failed[0]!.at);
    assert.ok(queuedAfterFailure.length >= 1, "the trader continues after a min-output failure");
  });

  it("an exit that cannot settle at release is reported once and leaves the agent recoverable", async () => {
    const s = await new TradingSimulation().init();
    // run until the exit is queued (the reserve holds the stake asset whole at that point)
    let queued = false;
    while (await s.step()) {
      if (s.log.ofType("withdraw_queued").length > 0) { queued = true; break; }
    }
    assert.ok(queued, "the default path must queue the exit");

    // simulate the documented caveat: a reserve violation (or external drain) empties the
    // stake asset before the timelock releases
    s.api.setBalance(TRADE_AGENT, TRADE_STABLE, 0n);
    s.api.advance(5_000);
    await s.runner.tick();
    assert.deepEqual(s.log.ofType("withdraw_failed").map((e) => e.failureCode), ["insufficient_balance"]);
    assert.equal(s.api.settled.length, 0, "nothing settled: the safe account received nothing");
    assert.equal((await s.store.load()).banked, true, "reported exactly once; the runner does not re-withdraw on its own");
  });

  it("a crash between request and persistence replays the same idempotency key: exactly one settlement", async () => {
    const s = await new TradingSimulation().init();
    await s.runToEnd();
    assert.equal(s.api.settled.length, 1);
    const originalId = s.api.settled[0]!.correlation_id;

    // the runner "crashes" and loses its state; the market then rallies again past the trigger
    s.store = new MemoryStateStore();
    s.api.setBalance(TRADE_AGENT, TRADE_STABLE, 10n * s.principalAtomic);
    s.runner = new HouseMoneyRunner({
      client: s.api,
      grant: s.grant,
      agentId: TRADE_AGENT,
      asset: TRADE_STABLE,
      principalAtomic: s.principalAtomic,
      principalMicroUsd: s.principalAtomic,
      chain: "base",
      safeAddress: "0xsafe000000000000000000000000000000000001",
      store: s.store,
      log: s.log,
      now: () => s.api.clock.date(),
    });
    await s.runner.tick();

    assert.equal(s.api.settled.length, 1, "no second settlement");
    assert.equal((await s.store.load()).withdrawalId, originalId, "the replay returned the original operation");
    assert.equal((await s.store.load()).banked, true);
  });

  it("the trigger latches: a dip below 2x while the cash is being raised does not cancel the exit", async () => {
    const s = await new TradingSimulation({ prices: latchPath(24, 5, 2, 0.15, 24), timelockMs: 6_000, slippageBps: 6_000n }).init();
    let triggerStep = -1;
    let i = 0;
    while (await s.step()) {
      i++;
      if (triggerStep < 0 && s.log.ofType("trigger").length > 0) triggerStep = i;
    }

    assert.ok(triggerStep > 0, "the trigger must fire mid-rally");
    assert.equal(s.log.ofType("trigger").length, 1, "the trigger fires exactly once");
    assert.equal(s.api.settled.length, 1, "the exit settles despite the dip");

    // while the exit was queued, equity dipped below the 2x trigger — the latch is what carried it through
    const principalMicro = s.principalAtomic; // stake asset is $1 → principal micro-USD == atomic
    const dipped = s.timeline.some((t) => t.t > triggerStep && t.bankedMicroUsd === 0n && t.equityMicroUsd < 2n * principalMicro);
    assert.ok(dipped, "equity must have dipped below the trigger mid-flight");
  });
});
