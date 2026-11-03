import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { AgentApiError } from "../../src/errors";
import { TRADE_AGENT, TRADE_RISK, TRADE_SAFE, TRADE_STABLE, TradingSimulation } from "../harness/trading-simulation";
import { pricePath } from "../harness/price-paths";

describe("trading agent on the mock", () => {
  it("trades the rally, banks exactly the principal once, and burns only house money in the drawdown", async () => {
    const s = await new TradingSimulation().init();
    await s.runToEnd();
    const settled = s.api.settled;
    assert.equal(settled.length, 1);
    assert.equal(settled[0]!.request.amount, s.principalAtomic.toString());
    assert.equal(settled[0]!.request.recipient, TRADE_SAFE);
    assert.equal(s.log.ofType("trigger").length, 1);
    assert.ok(s.api.swaps.length >= 3, "it traded");
    const last = s.timeline.at(-1)!;
    assert.equal(last.bankedMicroUsd, s.principalAtomic);
    assert.ok(last.equityMicroUsd >= s.principalAtomic, "the stake is still whole after a 40% drawdown");
  });

  it("raises the stake asset before the exit is requested, and never asks for cash it cannot withdraw", async () => {
    const s = await new TradingSimulation().init();
    await s.runToEnd();
    const raise = s.log.events.find((e) => e.type === "swap_queued" && e.reason === "raise_cash");
    const queued = s.log.ofType("withdraw_queued")[0];
    assert.ok(raise && queued && raise.at <= queued.at);
    assert.equal(s.log.ofType("refused").filter((e) => e.code === "insufficient_balance").length, 0);
  });

  it("keeps the principal reserved in the stake asset while the exit is queued", async () => {
    const s = await new TradingSimulation({ timelockMs: 6_000, slippageBps: 8_000n, prices: pricePath(24, 12, 30, 1, 6) }).init();
    let queuedSeen = false;
    while (await s.step()) {
      const q = (await s.api.listScheduledExecutions(TRADE_AGENT)).some((o) => !o.swap);
      if (q) {
        queuedSeen = true;
        const bal = BigInt((await s.grant.getBalances(TRADE_AGENT)).balances[TRADE_STABLE] ?? "0");
        assert.ok(bal >= s.principalAtomic, `reserve breached: ${bal}`);
      }
    }
    assert.ok(queuedSeen);
    assert.equal(s.api.settled.length, 1);
  });

  it("holds the stake and does nothing when the market never trends up", async () => {
    const s = await new TradingSimulation({ prices: Array.from({ length: 30 }, () => 1) }).init();
    await s.runToEnd();
    assert.equal(s.api.swaps.length, 0);
    assert.equal(s.api.settled.length, 0);
  });

  it("a stale price halts trading as well as banking", async () => {
    const s = await new TradingSimulation().init();
    s.api.setTokens(s.api["tokens"].map((t) => ({ ...t, price_expires_at: new Date(s.api.clock.now() - 1).toISOString() })));
    s.api.setBalance(TRADE_AGENT, TRADE_RISK, 10n ** 24n);
    await s.trader.step();
    assert.equal(s.log.ofType("price_unavailable").length, 1);
    assert.equal(s.api.swaps.length, 0);
  });

  it("the policy keeps withdraw pinned to the safe account while swapping is allowed", async () => {
    const s = await new TradingSimulation().init();
    const g = s.grant;
    await assert.rejects(g.withdraw(TRADE_AGENT, { asset: TRADE_STABLE, amount: "1", chain: "base", recipient: "0xattacker" }, { idempotencyKey: "k1-attacker" }), (e: unknown) => e instanceof AgentApiError && e.code === "policy_destination_denied");
    await assert.rejects(g.swap(TRADE_AGENT, { origin_asset: TRADE_STABLE, destination_asset: "nep141:unlisted", amount: "1000" }, { idempotencyKey: "k2-unlisted" }), (e: unknown) => e instanceof AgentApiError && e.code === "policy_denied");
  });

  it("the price path rises, falls 40% from the peak, then holds", () => {
    const p = pricePath();
    assert.equal(Math.max(...p), 4);
    assert.ok(Math.abs(p[p.length - 1]! / 4 - 0.6) < 1e-9);
  });
});
