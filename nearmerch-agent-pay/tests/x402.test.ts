import { describe, expect, it } from "vitest";
import {
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";
import { decodeHeader, encodeHeader, isNearIntents, type PaymentRequired } from "../src/x402";
import { buildQuotePayload } from "../src/ping-x402";

const required: PaymentRequired = {
  x402Version: 2,
  resource: { url: "http://store.test/orders/o1/pay", description: "ünïcødé order" },
  accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0xA", amount: "", payTo: "", maxTimeoutSeconds: 60, extra: { assetTransferMethod: "near-intents" } }],
};

describe("x402 header encoding matches @x402/core", () => {
  it("our PAYMENT-SIGNATURE decodes with @x402/core", () => {
    const payload = buildQuotePayload(required, required.accepts[0]!, "0x2222222222222222222222222222222222222222");
    const decoded = decodePaymentSignatureHeader(encodeHeader(payload));
    expect(decoded).toEqual(payload);
  });

  it("@x402/core PAYMENT-REQUIRED decodes with ours (incl. non-ASCII)", () => {
    const header = encodePaymentRequiredHeader(required as never);
    expect(decodeHeader(header)).toEqual(required);
    expect(decodePaymentRequiredHeader(encodeHeader(required))).toEqual(required);
  });

  it("recognises near-intents entries by extra.assetTransferMethod", () => {
    expect(isNearIntents(required.accepts[0]!)).toBe(true);
    expect(isNearIntents({ ...required.accepts[0]!, extra: { assetTransferMethod: "eip3009" } })).toBe(false);
  });
});
