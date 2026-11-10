/**
 * Fake nearmerch: catalog, quote, Sign in with NEAR, x402 checkout and the pay route with the
 * near-intents behaviour of NEARBuilders/nearmerch.com#258 (unquoted entries appended to the
 * Phase 1 402, quote → facilitator /verify → quoted 402, deposit → /settle → 200).
 * Headers are encoded with @x402/core, so the client is checked against the real encoding.
 */
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { parseAuthToken } from "near-sign-verify";
import { json, type Handler } from "./ledger";
import type { FakePing } from "./fake-ping";

export const STORE = "http://store.test";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const NEAR_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export const PRODUCTS = [
  { id: "p-hoodie", slug: "hoodie", title: "NEAR Hoodie", price: 45, currency: "USD", fulfillmentProvider: "printful",
    variants: [{ id: "v-hoodie-m", title: "NEAR Hoodie / M", price: 45, availableForSale: true }] },
  { id: "p-tee", slug: "tee", title: "NEAR Logo T-Shirt", price: 22, currency: "USD", fulfillmentProvider: "printful",
    variants: [
      { id: "v-tee-s", title: "NEAR Logo T-Shirt / S", price: 22, availableForSale: false },
      { id: "v-tee-m", title: "NEAR Logo T-Shirt / M", price: 22, availableForSale: true },
    ] },
  { id: "p-legion", slug: "legion", title: "Legion Cap", price: 10, currency: "USD", metadata: { purchaseGate: { pluginId: "legion-holder" } },
    variants: [{ id: "v-legion", title: "Legion Cap", price: 10, availableForSale: true }] },
];

type Order = { id: string; status: string; totalAmount: number; currency: string; owner: string; createdAt: number };

export type StoreOptions = {
  intentsEnabled?: boolean;
  shipping?: number;
  tax?: number;
  now?: () => number;
};

export class FakeNearmerch {
  readonly orders = new Map<string, Order>();
  readonly signIns: Array<{ accountId: string; recipient: string; message: string; publicKey: string }> = [];
  private sessions = new Map<string, string>();
  private n = 0;
  private readonly now: () => number;

  constructor(
    private readonly ping: FakePing,
    private readonly opts: StoreOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  handle: Handler = async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/site-config") return json(200, { maintenance: { enabled: false } });
    if (req.method === "GET" && path === "/api/products") return json(200, { products: PRODUCTS, total: PRODUCTS.length });
    if (req.method === "POST" && path === "/api/quote") return json(200, this.quote((await req.json()) as never));
    if (req.method === "POST" && path === "/api/auth/near/verify") return this.verify(req);
    if (req.method === "POST" && path === "/api/checkout") return this.checkout(req);
    const orderMatch = path.match(/^\/api\/orders\/([^/]+)$/);
    if (req.method === "GET" && orderMatch) {
      const owner = this.session(req);
      const order = this.orders.get(orderMatch[1]!);
      if (!owner) return json(401, { code: "UNAUTHORIZED" });
      if (!order) return json(404, { code: "NOT_FOUND" });
      return json(200, { order });
    }
    const payMatch = path.match(/^\/orders\/([^/]+)\/pay$/);
    if (req.method === "POST" && payMatch) return this.pay(req, payMatch[1]!);
    return json(404, { code: "NOT_FOUND", path });
  };

  private quote(body: { items: Array<{ productId: string; variantId: string; quantity: number }>; shippingAddress: { email?: string } }) {
    const subtotal = body.items.reduce((sum, i) => sum + (PRODUCTS.find((p) => p.id === i.productId)?.price ?? 0) * i.quantity, 0);
    const shippingCost = this.opts.shipping ?? 4.95;
    const tax = this.opts.tax ?? 1.86;
    return {
      subtotal, shippingCost, tax, vat: 0, total: Math.round((subtotal + shippingCost + tax) * 100) / 100, currency: "USD",
      providerBreakdown: [{ provider: "printful", itemCount: 1, subtotal, selectedShipping: { provider: "printful", rateId: "STANDARD", rateName: "Flat Rate", shippingCost, currency: "USD" }, availableRates: [] }],
    };
  }

  private async verify(req: Request) {
    const { accountId, authToken } = (await req.json()) as { accountId: string; authToken: string };
    const data = parseAuthToken(authToken);
    if (data.recipient !== "near-merch-store.near" || data.accountId !== accountId) return json(401, { code: "UNAUTHORIZED" });
    this.signIns.push({ accountId, recipient: data.recipient, message: data.message, publicKey: data.publicKey });
    const sid = `sess_${++this.n}`;
    this.sessions.set(sid, accountId);
    return new Response(JSON.stringify({ success: true, token: sid, user: { id: "u1", accountId, network: "mainnet" } }), {
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["set-cookie", `better-auth.session_token=${sid}; Path=/; HttpOnly; SameSite=Lax`],
        ["set-cookie", `better-auth.session_data=x; Path=/; HttpOnly`],
      ],
    });
  }

  private session(req: Request): string | undefined {
    const m = (req.headers.get("cookie") ?? "").match(/better-auth\.session_token=([^;]+)/);
    return m ? this.sessions.get(m[1]!) : undefined;
  }

  private async checkout(req: Request) {
    const owner = this.session(req);
    if (!owner) return json(401, { code: "UNAUTHORIZED", message: "Authentication required", data: { authType: "nearAccountId" } });
    const body = (await req.json()) as { paymentProvider?: string; selectedRates?: Record<string, string>; items: never; shippingAddress: never; successUrl?: string };
    if (body.paymentProvider !== "x402") return json(400, { code: "BAD_REQUEST", message: "this fake only does x402" });
    if (!body.selectedRates?.printful || !body.successUrl) return json(400, { code: "BAD_REQUEST" });
    const q = this.quote({ items: body.items, shippingAddress: body.shippingAddress });
    const id = `order-${++this.n}`;
    this.orders.set(id, { id, status: "payment_pending", totalAmount: q.total, currency: "USD", owner, createdAt: this.now() });
    return json(200, { orderId: id, checkoutSessionId: `x402:${id}`, totalAmount: q.total, currency: "USD", status: "payment_pending" });
  }

  private resource(orderId: string) {
    return { url: `${STORE}/orders/${orderId}/pay`, description: `nearmerch order ${orderId}`, mimeType: "application/json" };
  }

  private intentsEntry(network: string, asset: string, totalAtomic: string) {
    return {
      scheme: "exact", network, asset, amount: "", payTo: "", maxTimeoutSeconds: 1800,
      extra: {
        assetTransferMethod: "near-intents", paymentFlow: "upfront", indicativeAmount: totalAtomic,
        destination: { network: "near:mainnet", asset: `nep141:${NEAR_USDC}`, amount: totalAtomic, recipient: "nearmerchstore.sputnik-dao.near" },
      },
    };
  }

  private paymentRequired(orderId: string, accepts: unknown[], error?: string, receipt?: unknown, status = 402) {
    const headers: Record<string, string> = {
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, ...(error ? { error } : {}), resource: this.resource(orderId), accepts } as never),
      "cache-control": "no-store",
    };
    if (receipt) headers["PAYMENT-RESPONSE"] = encodePaymentResponseHeader(receipt as never);
    return json(status, error ? { error } : {}, headers);
  }

  private async pay(req: Request, orderId: string) {
    const order = this.orders.get(orderId);
    if (!order) return json(403, { error: "order_not_found" });
    const totalAtomic = (BigInt(Math.round(order.totalAmount * 100)) * 10_000n).toString();
    const header = req.headers.get("payment-signature");
    if (!header) {
      if (order.status === "paid") return json(200, { orderId, status: order.status, idempotent: true });
      const phase1 = { scheme: "exact", network: "eip155:8453", asset: BASE_USDC, amount: totalAtomic, payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 900, extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" } };
      const intents = this.opts.intentsEnabled === false ? [] : [this.intentsEntry("eip155:42161", ARB_USDC, totalAtomic), this.intentsEntry("eip155:8453", BASE_USDC, totalAtomic)];
      return this.paymentRequired(orderId, [phase1, ...intents]);
    }
    const payload = decodePaymentSignatureHeader(header) as unknown as { x402Version: number; resource?: { url: string }; accepted: { network: string; asset: string; extra?: Record<string, unknown> }; payload: Record<string, unknown> };
    if (payload.resource?.url !== this.resource(orderId).url) return this.paymentRequired(orderId, [], "invalid_payload");
    if (payload.payload.type === "quote") {
      const unquoted = this.intentsEntry(payload.accepted.network, payload.accepted.asset, totalAtomic);
      const v = this.ping.verify(payload as never, unquoted as never);
      if (!v.isValid) return this.paymentRequired(orderId, [unquoted], v.invalidReason);
      const quoted = { ...unquoted, amount: v.extra!.amountIn, payTo: v.extra!.depositAddress, extra: { ...unquoted.extra, refundDeadline: v.extra!.refundDeadline, operationToken: v.extra!.operationToken } };
      return this.paymentRequired(orderId, [quoted]);
    }
    if (payload.payload.type === "deposit") {
      if (order.status === "paid") return json(200, { orderId, status: order.status, idempotent: true });
      const settle = this.ping.settle(payload as never);
      const receipt = { ...settle };
      if (settle.success) {
        order.status = "paid";
        return json(200, { orderId, status: "paid", currency: "USD" }, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(receipt as never) });
      }
      if (settle.errorReason === "exact_near_intents_payment_failed") order.status = "payment_failed";
      return this.paymentRequired(orderId, [payload.accepted], settle.errorReason, receipt);
    }
    return this.paymentRequired(orderId, [], "invalid_payload");
  }
}
