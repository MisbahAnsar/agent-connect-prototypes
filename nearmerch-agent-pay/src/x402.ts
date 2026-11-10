/**
 * The slice of x402 v2 this prototype needs. Header values are base64(JSON), the same encoding
 * as @x402/core's encode/decode helpers (tests/x402.test.ts checks that both round-trip).
 */

export type PaymentRequirements = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
};

export type Resource = { url: string; description?: string; mimeType?: string };

export type PaymentRequired = {
  x402Version: number;
  error?: string;
  resource?: Resource;
  accepts: PaymentRequirements[];
};

export type PaymentPayload = {
  x402Version: 2;
  resource?: Resource;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
};

export type SettleResponse = {
  success: boolean;
  errorReason?: string;
  transaction?: string;
  network?: string;
  amount?: string;
  payer?: string;
  extra?: Record<string, unknown>;
};

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeHeader<T>(header: string): T {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as T;
}

/** `near-intents` entries carry this marker in `extra` (x402 #3370). */
export const NEAR_INTENTS_TRANSFER_METHOD = "near-intents";

export function isNearIntents(req: PaymentRequirements): boolean {
  return req.extra?.assetTransferMethod === NEAR_INTENTS_TRANSFER_METHOD;
}
