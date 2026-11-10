import { describe, expect, it } from "vitest";
import {
  classifySettle,
  getChallenge,
  parseQuoted,
  requestQuote,
  selectIntentsAccept,
  settleDeposit,
  X402IntentsError,
} from "../src/ping-x402";
import { BASE_NETWORK, BASE_USDC } from "../src/config";
import type { PayRouteResponse } from "../src/nearmerch";
import { REFUND, world } from "./fakes/world";

const origin = { network: BASE_NETWORK, asset: BASE_USDC };

async function orderWithQuote(w: ReturnType<typeof world>) {
  const items = [{ productId: "p-tee", variantId: "v-tee-m", quantity: 1 }];
  const quote = await w.merchant.quote(items, w.cfg.shipping);
  await w.merchant.signIn({ privateKey: w.cfg.nearPrivateKey, accountId: "buyer.near" });
  const order = await w.merchant.checkout({ items, shippingAddress: w.cfg.shipping, quote });
  const challenge = await getChallenge(w.merchant, order.orderId);
  return { order, challenge };
}

describe("402 → near-intents entry", () => {
  it("picks the Base USDC near-intents entry, ignoring Phase 1 eip3009 and other origins", async () => {
    const w = world();
    const { challenge } = await orderWithQuote(w);
    expect(challenge.accepts).toHaveLength(3);
    const accepted = selectIntentsAccept(challenge, { network: BASE_NETWORK, asset: BASE_USDC.toLowerCase() });
    expect(accepted).toMatchObject({ network: "eip155:8453", amount: "", payTo: "" });
    expect(accepted.extra?.destination).toMatchObject({ network: "near:mainnet", amount: "28810000" });
  });

  it("explains a store with intents off", async () => {
    const w = world({ store: { intentsEnabled: false } });
    const { challenge } = await orderWithQuote(w);
    expect(() => selectIntentsAccept(challenge, origin)).toThrow(/near-intents offered: none; other: exact:eip155:8453/);
  });
});

describe("quote round trip", () => {
  it("returns depositAddress, amountIn, operationToken and refundDeadline from the quoted 402", async () => {
    const w = world();
    const { order, challenge } = await orderWithQuote(w);
    const quoted = await requestQuote(w.merchant, order.orderId, challenge, selectIntentsAccept(challenge, origin), REFUND);
    expect(quoted.depositAddress).toMatch(/^0x[d0-9]{40}$/);
    expect(quoted.amountIn).toBe(29_242_150n); // 28.81 * 1.015
    expect(quoted.operationToken).toMatch(/^optok_/);
    expect(Date.parse(quoted.refundDeadline)).toBeGreaterThan(Date.now());
    expect(w.ping.quotes.get(quoted.depositAddress)?.refundTo).toBe(REFUND);
  });

  it("surfaces facilitator refusals (quote unavailable / bad refundTo)", async () => {
    const w = world({ ping: { quoteUnavailable: true } });
    const { order, challenge } = await orderWithQuote(w);
    await expect(requestQuote(w.merchant, order.orderId, challenge, selectIntentsAccept(challenge, origin), REFUND)).rejects.toMatchObject({
      reason: "invalid_exact_near_intents_quote_unavailable",
    });
    const w2 = world();
    const o2 = await orderWithQuote(w2);
    await expect(requestQuote(w2.merchant, o2.order.orderId, o2.challenge, selectIntentsAccept(o2.challenge, origin), "not-an-address")).rejects.toMatchObject({
      reason: "refund_address_required",
    });
  });

  it("rejects a quoted entry without an operationToken", () => {
    const res: PayRouteResponse = {
      status: 402,
      required: { x402Version: 2, accepts: [{ scheme: "exact", network: BASE_NETWORK, asset: BASE_USDC, amount: "100", payTo: "0xabc", maxTimeoutSeconds: 60, extra: { refundDeadline: new Date().toISOString() } }] },
      body: {},
    };
    expect(() => parseQuoted(res)).toThrow(X402IntentsError);
  });
});

describe("classifySettle", () => {
  const r = (status: number, extra: Partial<PayRouteResponse> = {}): PayRouteResponse => ({ status, body: {}, ...extra });
  it.each([
    ["paid", r(200, { body: { orderId: "o", status: "paid" } })],
    ["paid", r(200, { body: { orderId: "o", idempotent: true } })],
    ["pending", r(402, { required: { x402Version: 2, error: "settlement_pending", accepts: [] } })],
    ["pending", r(403, { body: { error: "settlement_pending" } })],
    ["pending", r(409, { body: { error: "settlement_pending" } })],
    ["incomplete", r(402, { receipt: { success: false, errorReason: "settlement_pending", extra: { status: "INCOMPLETE_DEPOSIT" } } })],
    ["transient", r(502, { body: { error: "facilitator_unavailable" } })],
    ["transient", r(503)],
    ["failed", r(402, { required: { x402Version: 2, error: "exact_near_intents_payment_failed", accepts: [] } })],
    ["failed", r(402, { required: { x402Version: 2, error: "invalid_exact_near_intents_token_invalid", accepts: [] } })],
    ["failed", r(403, { body: { error: "expired" } })],
  ])("%s ← %j", (kind, res) => {
    expect(classifySettle(res).kind).toBe(kind);
  });
});

describe("settleDeposit", () => {
  async function funded(w: ReturnType<typeof world>) {
    const { order, challenge } = await orderWithQuote(w);
    const quoted = await requestQuote(w.merchant, order.orderId, challenge, selectIntentsAccept(challenge, origin), REFUND);
    const txHash = w.base.deliver(quoted.depositAddress, quoted.amountIn);
    return { order, quoted, txHash };
  }

  it("retries the SAME payload through settlement_pending and INCOMPLETE_DEPOSIT", async () => {
    const w = world({ ping: { pendingSettles: 2, incompleteSettles: 1 } });
    const { order, quoted, txHash } = await funded(w);
    const steps: string[] = [];
    const paid = await settleDeposit(w.merchant, order.orderId, quoted, txHash, { sleep: w.noSleep, onStep: (_, s) => steps.push(s.kind) });
    expect(steps).toEqual(["pending", "pending", "incomplete", "paid"]);
    expect(paid.receipt).toMatchObject({ success: true, network: "near:mainnet", amount: "28810000" });
    expect(w.store.orders.get(order.orderId)?.status).toBe("paid");
  });

  it("is idempotent once paid", async () => {
    const w = world();
    const { order, quoted, txHash } = await funded(w);
    await settleDeposit(w.merchant, order.orderId, quoted, txHash, { sleep: w.noSleep });
    const again = await settleDeposit(w.merchant, order.orderId, quoted, txHash, { sleep: w.noSleep });
    expect(again.body.idempotent).toBe(true);
    expect(w.ping.settleCalls).toBe(1);
  });

  it("stops on a terminal failure", async () => {
    const w = world({ ping: { terminalFailure: true } });
    const { order, quoted, txHash } = await funded(w);
    await expect(settleDeposit(w.merchant, order.orderId, quoted, txHash, { sleep: w.noSleep })).rejects.toMatchObject({ reason: "exact_near_intents_payment_failed" });
    expect(w.ping.settleCalls).toBe(1);
  });

  it("gives up after maxAttempts and says not to pay again", async () => {
    const w = world({ ping: { pendingSettles: 99 } });
    const { order, quoted, txHash } = await funded(w);
    await expect(settleDeposit(w.merchant, order.orderId, quoted, txHash, { sleep: w.noSleep, maxAttempts: 3 })).rejects.toThrow(/Do NOT pay again/);
    expect(w.ping.settleCalls).toBe(3);
  });
});
