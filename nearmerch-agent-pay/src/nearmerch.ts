/**
 * nearmerch.com HTTP client: the same JSON API the storefront uses (see the store's
 * skills/nearmerch/SKILL.md). Catalog + quote are public; checkout needs a Sign in with NEAR
 * (NEP-413) session cookie; the x402 pay route needs no session.
 */
import { parseAuthToken, sign, type WalletInterface } from "near-sign-verify";
import { NEARMERCH_SIGN_IN_MESSAGE, NEARMERCH_SIGN_IN_RECIPIENT, type ShippingAddress } from "./config";
import {
  decodeHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type PaymentRequired,
  type SettleResponse,
} from "./x402";

export type Fetch = typeof fetch;

export type Variant = {
  id: string;
  title: string;
  price: number;
  availableForSale?: boolean;
  attributes?: Array<{ name: string; value: string }>;
};

export type Product = {
  id: string;
  slug: string;
  title: string;
  price: number;
  currency?: string;
  variants: Variant[];
  fulfillmentProvider?: string;
  metadata?: Record<string, unknown>;
};

export type CartItem = { productId: string; variantId: string; quantity: number };

export type Quote = {
  subtotal: number;
  shippingCost: number;
  tax: number;
  vat: number;
  total: number;
  currency: string;
  providerBreakdown: Array<{
    provider: string;
    selectedShipping: { rateId: string; shippingCost: number };
  }>;
};

export type CheckoutResult = {
  orderId: string;
  checkoutSessionId: string;
  totalAmount: number;
  currency: string;
  status: string;
};

export type PayRouteResponse = {
  status: number;
  /** Decoded PAYMENT-REQUIRED header (402s), if any. */
  required?: PaymentRequired;
  /** Decoded PAYMENT-RESPONSE header (settle receipt), if any. */
  receipt?: SettleResponse;
  body: Record<string, unknown>;
};

export class NearmerchError extends Error {
  constructor(
    readonly label: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`${label} failed (HTTP ${status}): ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
}

/** NEP-413 signer: a local "ed25519:..." key for `accountId`, or any NEP-413 wallet (e.g. Agent Connect). */
export type NearSigner = { privateKey: string; accountId: string } | { wallet: WalletInterface };

export class NearmerchClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: Fetch;
  private cookie: string | null = null;

  constructor(opts: { baseUrl: string; fetchImpl?: Fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get signedIn(): boolean {
    return this.cookie !== null;
  }

  async siteConfig(): Promise<{ maintenance?: { enabled: boolean; message?: string } }> {
    return this.json("site-config", "GET", "/api/site-config");
  }

  async listProducts(limit = 50): Promise<Product[]> {
    const res = await this.json<{ products: Product[] }>("products", "GET", `/api/products?limit=${limit}`);
    return res.products;
  }

  async quote(items: CartItem[], shippingAddress: ShippingAddress): Promise<Quote> {
    return this.json("quote", "POST", "/api/quote", { items, shippingAddress });
  }

  /** Sign in with NEAR: POST /api/auth/near/verify with a near-sign-verify token, keep the session cookie. */
  async signIn(signer: NearSigner): Promise<{ accountId: string }> {
    const authToken =
      "wallet" in signer
        ? await sign(NEARMERCH_SIGN_IN_MESSAGE, { signer: signer.wallet, recipient: NEARMERCH_SIGN_IN_RECIPIENT })
        : await sign(NEARMERCH_SIGN_IN_MESSAGE, {
            signer: signer.privateKey,
            accountId: signer.accountId,
            recipient: NEARMERCH_SIGN_IN_RECIPIENT,
          });
    // The verify route takes the account id beside the token; for a wallet it is inside the token.
    const accountId = "wallet" in signer ? parseAuthToken(authToken).accountId : signer.accountId;
    const res = await this.fetchImpl(`${this.baseUrl}/api/auth/near/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: this.baseUrl },
      body: JSON.stringify({ accountId, authToken }),
    });
    const body = await readBody(res);
    if (!res.ok) throw new NearmerchError("sign-in", res.status, body);
    const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]!).filter(Boolean);
    if (cookies.length === 0) throw new NearmerchError("sign-in (no session cookie)", res.status, body);
    this.cookie = cookies.join("; ");
    const user = (body as { user?: { accountId?: string } }).user;
    return { accountId: user?.accountId ?? accountId };
  }

  /** Creates a new order every call — never retry a successful checkout. */
  async checkout(input: { items: CartItem[]; shippingAddress: ShippingAddress; quote: Quote }): Promise<CheckoutResult> {
    if (!this.cookie) throw new Error("checkout needs a session: call signIn() first");
    return this.json("checkout", "POST", "/api/checkout", {
      items: input.items,
      shippingAddress: input.shippingAddress,
      selectedRates: selectedRatesFrom(input.quote),
      shippingCost: input.quote.shippingCost,
      successUrl: `${this.baseUrl}/order-confirmation`,
      cancelUrl: `${this.baseUrl}/checkout`,
      paymentProvider: "x402",
    });
  }

  async getOrder(orderId: string): Promise<{ order: { id: string; status: string; totalAmount: number } }> {
    return this.json("order", "GET", `/api/orders/${encodeURIComponent(orderId)}`);
  }

  /** POST /orders/:id/pay — without a header it answers 402 with the accepts list. */
  async pay(orderId: string, paymentSignature?: string): Promise<PayRouteResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/orders/${encodeURIComponent(orderId)}/pay`, {
      method: "POST",
      headers: paymentSignature ? { [PAYMENT_SIGNATURE_HEADER]: paymentSignature } : {},
    });
    const raw = await readBody(res);
    const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : { text: raw };
    const reqHeader = res.headers.get(PAYMENT_REQUIRED_HEADER);
    const resHeader = res.headers.get(PAYMENT_RESPONSE_HEADER);
    return {
      status: res.status,
      ...(reqHeader ? { required: safeDecode<PaymentRequired>(reqHeader) } : {}),
      ...(resHeader ? { receipt: safeDecode<SettleResponse>(resHeader) } : {}),
      body,
    };
  }

  private async json<T>(label: string, method: "GET" | "POST", path: string, payload?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    if (this.cookie) headers.Cookie = this.cookie;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    const body = await readBody(res);
    if (!res.ok) throw new NearmerchError(label, res.status, body);
    return body as T;
  }
}

/** `{ [provider]: rateId }` from the quote's selected shipping, as checkout expects. */
export function selectedRatesFrom(quote: Quote): Record<string, string> {
  return Object.fromEntries(quote.providerBreakdown.map((p) => [p.provider, p.selectedShipping.rateId]));
}

/**
 * Picks a buyable variant: explicit ids win, else the first product whose title matches `query`
 * (case-insensitive), else the cheapest ungated product. Gated products (metadata.purchaseGate) are skipped.
 */
export function pickItem(
  products: Product[],
  want: { productId?: string; variantId?: string; query?: string },
): { product: Product; variant: Variant } {
  const buyable = (p: Product) => !p.metadata?.purchaseGate;
  const available = (vr: Variant) => vr.availableForSale !== false;
  let candidates = products.filter(buyable);
  if (want.productId) candidates = candidates.filter((p) => p.id === want.productId);
  else if (want.query) {
    const q = want.query.toLowerCase();
    candidates = candidates.filter((p) => p.title.toLowerCase().includes(q));
  } else candidates = [...candidates].sort((a, b) => a.price - b.price);
  for (const product of candidates) {
    const variant = want.variantId
      ? product.variants.find((vr) => vr.id === want.variantId && available(vr))
      : product.variants.find(available);
    if (variant) return { product, variant };
  }
  throw new Error(
    `no buyable product matches ${JSON.stringify(want)} (${products.length} products listed; gated items are skipped)`,
  );
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function safeDecode<T>(header: string): T | undefined {
  try {
    return decodeHeader<T>(header);
  } catch {
    return undefined;
  }
}
