import { describe, expect, it } from "vitest";
import { NearmerchClient, NearmerchError, pickItem, selectedRatesFrom } from "../src/nearmerch";
import { usdToUsdcAtomic, formatUsdc, missingShipping } from "../src/config";
import { PRODUCTS } from "./fakes/fake-nearmerch";
import { world } from "./fakes/world";

describe("pickItem", () => {
  it("skips unavailable variants and gated products", () => {
    const { product, variant } = pickItem(PRODUCTS as never, { query: "T-SHIRT" });
    expect(product.id).toBe("p-tee");
    expect(variant.id).toBe("v-tee-m");
    // cheapest overall is the gated Legion Cap; it must not be picked
    expect(pickItem(PRODUCTS as never, {}).product.id).toBe("p-tee");
  });

  it("honours explicit ids and fails clearly", () => {
    expect(pickItem(PRODUCTS as never, { productId: "p-hoodie" }).variant.id).toBe("v-hoodie-m");
    expect(() => pickItem(PRODUCTS as never, { productId: "p-tee", variantId: "v-tee-s" })).toThrow(/no buyable product/);
    expect(() => pickItem(PRODUCTS as never, { productId: "p-legion" })).toThrow(/gated/);
  });
});

describe("money helpers", () => {
  it("converts dollars to USDC atomic without float drift", () => {
    expect(usdToUsdcAtomic(28.81)).toBe(28_810_000n);
    expect(usdToUsdcAtomic(0.1 + 0.2)).toBe(300_000n);
    expect(formatUsdc(28_810_000n)).toBe("28.81");
    expect(formatUsdc("1")).toBe("0.000001");
  });

  it("lists missing shipping env names", () => {
    expect(missingShipping({ firstName: "a", lastName: "", email: "", addressLine1: "", city: "", postCode: "", country: "" })).toContain("SHIP_EMAIL");
  });
});

describe("NearmerchClient", () => {
  it("signs in with NEP-413 for near-merch-store.near and keeps the session cookie", async () => {
    const w = world();
    const { accountId } = await w.merchant.signIn({ privateKey: w.cfg.nearPrivateKey, accountId: "buyer.near" });
    expect(accountId).toBe("buyer.near");
    expect(w.merchant.signedIn).toBe(true);
    expect(w.store.signIns[0]).toMatchObject({ recipient: "near-merch-store.near", message: "Sign in to NEAR Merch Store", publicKey: w.key.publicKey });
  });

  it("checkout needs a session and sends paymentProvider x402 + selectedRates", async () => {
    const w = world();
    const items = [{ productId: "p-tee", variantId: "v-tee-m", quantity: 1 }];
    const quote = await w.merchant.quote(items, w.cfg.shipping);
    expect(selectedRatesFrom(quote)).toEqual({ printful: "STANDARD" });
    await expect(w.merchant.checkout({ items, shippingAddress: w.cfg.shipping, quote })).rejects.toThrow(/signIn/);
    await w.merchant.signIn({ privateKey: w.cfg.nearPrivateKey, accountId: "buyer.near" });
    const order = await w.merchant.checkout({ items, shippingAddress: w.cfg.shipping, quote });
    expect(order).toMatchObject({ status: "payment_pending", totalAmount: 28.81 });
  });

  it("surfaces API errors with status and body", async () => {
    const w = world();
    const raw = new NearmerchClient({ baseUrl: "http://store.test", fetchImpl: w.fetchImpl });
    await expect(raw.getOrder("nope")).rejects.toBeInstanceOf(NearmerchError);
  });
});
