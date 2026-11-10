/**
 * Client side of x402 `exact` + `near-intents` (x402 #3370), as Ping Agent Pay runs it.
 *
 * The agent never talks to Ping directly: it talks to the merchant's pay route (nearmerch
 * `POST /orders/:id/pay`), and the merchant forwards to Ping's `/verify` and `/settle` with its
 * own `X-Api-Key`. Two signed round trips:
 *
 *   1. quote   — PAYMENT-SIGNATURE { type: "quote", refundTo }  → 402 with ONE quoted entry
 *                (payTo = depositAddress, amount = amountIn, extra.operationToken/refundDeadline)
 *   2. deposit — fund depositAddress on the origin chain, then
 *                PAYMENT-SIGNATURE { type: "deposit", operationToken, depositAddress, txHash } → 200
 *
 * `settlement_pending` / `INCOMPLETE_DEPOSIT` keep the operation open: retry the SAME deposit
 * payload and never fund a second quote while one is pending.
 */
import type { Fetch, NearmerchClient, PayRouteResponse } from "./nearmerch";
import {
  encodeHeader,
  isNearIntents,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettleResponse,
} from "./x402";

export type QuotedPayment = {
  /** The quoted accepts entry, echoed back as `accepted` on the deposit payload. */
  accepted: PaymentRequirements;
  resource: PaymentRequired["resource"];
  depositAddress: string;
  depositMemo?: string;
  /** Minimum origin-chain delivery to depositAddress, atomic units of `accepted.asset`. */
  amountIn: bigint;
  operationToken: string;
  refundDeadline: string;
};

export class X402IntentsError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    readonly response?: PayRouteResponse,
  ) {
    super(message);
  }
}

/** Public facilitator discovery (no API key): which origin networks Ping accepts. */
export async function getSupported(pingUrl: string, fetchImpl: Fetch = fetch): Promise<{
  kinds: Array<{ x402Version: number; scheme: string; network: string; extra?: Record<string, unknown> }>;
}> {
  const res = await fetchImpl(`${pingUrl.replace(/\/$/, "")}/agentpay/x402/supported`);
  if (!res.ok) throw new Error(`Ping /agentpay/x402/supported HTTP ${res.status}`);
  return (await res.json()) as never;
}

/** The unpaid 402 for an order (no payment header). */
export async function getChallenge(merchant: NearmerchClient, orderId: string): Promise<PaymentRequired> {
  const res = await merchant.pay(orderId);
  if (res.status !== 402 || !res.required) {
    throw new X402IntentsError(
      `expected 402 with PAYMENT-REQUIRED from /orders/${orderId}/pay, got ${res.status}: ${JSON.stringify(res.body)}`,
      String(res.body.error ?? "no_challenge"),
      res,
    );
  }
  return res.required;
}

/** Picks the unquoted near-intents entry for the origin the wallet can pay on. */
export function selectIntentsAccept(
  required: PaymentRequired,
  origin: { network: string; asset: string },
): PaymentRequirements {
  const intents = required.accepts.filter(isNearIntents);
  const match = intents.find(
    (a) =>
      a.network === origin.network &&
      (a.network.startsWith("eip155:") ? a.asset.toLowerCase() === origin.asset.toLowerCase() : a.asset === origin.asset),
  );
  if (!match) {
    const offered = intents.map((a) => `${a.network}/${a.asset}`).join(", ") || "none";
    const other = required.accepts.filter((a) => !isNearIntents(a)).map((a) => `${a.scheme}:${a.network}`);
    throw new X402IntentsError(
      `no near-intents entry for ${origin.network}/${origin.asset} (near-intents offered: ${offered}` +
        `${other.length ? `; other: ${other.join(", ")}` : ""}). Is X402 intents enabled on the store?`,
      "no_intents_entry",
    );
  }
  return match;
}

export function buildQuotePayload(required: PaymentRequired, accepted: PaymentRequirements, refundTo: string): PaymentPayload {
  return {
    x402Version: 2,
    ...(required.resource ? { resource: required.resource } : {}),
    accepted,
    payload: { type: "quote", refundTo },
  };
}

export function buildDepositPayload(quoted: QuotedPayment, txHash: string): PaymentPayload {
  return {
    x402Version: 2,
    ...(quoted.resource ? { resource: quoted.resource } : {}),
    accepted: quoted.accepted,
    payload: {
      type: "deposit",
      operationToken: quoted.operationToken,
      depositAddress: quoted.depositAddress,
      ...(quoted.depositMemo ? { depositMemo: quoted.depositMemo } : {}),
      txHash,
    },
  };
}

/** Reads the quoted 402 (header first; Ping's express middleware also mirrors it in the body). */
export function parseQuoted(res: PayRouteResponse): QuotedPayment {
  const required = res.required ?? (Array.isArray(res.body.accepts) ? (res.body as unknown as PaymentRequired) : undefined);
  const error = required?.error ?? (res.body.error as string | undefined) ?? (res.body.invalidReason as string | undefined);
  if (res.status !== 402 || !required || required.accepts.length !== 1 || error) {
    throw new X402IntentsError(
      `quote refused (HTTP ${res.status}${error ? `, ${error}` : ""}): ${JSON.stringify(res.body)}`,
      error ?? `http_${res.status}`,
      res,
    );
  }
  const accepted = required.accepts[0]!;
  const extra = accepted.extra ?? {};
  const operationToken = typeof extra.operationToken === "string" ? extra.operationToken : "";
  const refundDeadline = typeof extra.refundDeadline === "string" ? extra.refundDeadline : "";
  if (!accepted.payTo || !/^[1-9]\d*$/.test(accepted.amount) || !operationToken || Number.isNaN(Date.parse(refundDeadline))) {
    throw new X402IntentsError("quoted 402 is missing payTo/amount/operationToken/refundDeadline", "malformed_quote", res);
  }
  return {
    accepted,
    resource: required.resource,
    depositAddress: accepted.payTo,
    ...(typeof extra.depositMemo === "string" ? { depositMemo: extra.depositMemo } : {}),
    amountIn: BigInt(accepted.amount),
    operationToken,
    refundDeadline,
  };
}

/** Round trip 1: ask the merchant (→ Ping /verify) for a deposit address + amountIn. */
export async function requestQuote(
  merchant: NearmerchClient,
  orderId: string,
  required: PaymentRequired,
  accepted: PaymentRequirements,
  refundTo: string,
): Promise<QuotedPayment> {
  const res = await merchant.pay(orderId, encodeHeader(buildQuotePayload(required, accepted, refundTo)));
  const quoted = parseQuoted(res);
  if (quoted.accepted.network !== accepted.network || quoted.accepted.asset.toLowerCase() !== accepted.asset.toLowerCase()) {
    throw new X402IntentsError("quoted entry changed network/asset", "quote_mismatch", res);
  }
  return quoted;
}

export type SettleStep =
  | { kind: "paid"; body: Record<string, unknown>; receipt?: SettleResponse }
  | { kind: "pending"; reason: string; receipt?: SettleResponse }
  | { kind: "incomplete"; reason: string; receipt?: SettleResponse }
  | { kind: "transient"; reason: string }
  | { kind: "failed"; reason: string; receipt?: SettleResponse };

/** Maps one deposit-payload response from the pay route to what the agent should do next. */
export function classifySettle(res: PayRouteResponse): SettleStep {
  const receipt = res.receipt;
  const reason =
    res.required?.error ??
    (res.body.error as string | undefined) ??
    (res.body.errorReason as string | undefined) ??
    receipt?.errorReason ??
    `http_${res.status}`;
  if (res.status === 200 && typeof res.body.orderId === "string") return { kind: "paid", body: res.body, ...(receipt ? { receipt } : {}) };
  if (receipt?.extra?.status === "INCOMPLETE_DEPOSIT" || res.body.status === "INCOMPLETE_DEPOSIT") {
    return { kind: "incomplete", reason: "INCOMPLETE_DEPOSIT", ...(receipt ? { receipt } : {}) };
  }
  if (reason === "settlement_pending" || receipt?.errorReason === "settlement_pending") {
    return { kind: "pending", reason: "settlement_pending", ...(receipt ? { receipt } : {}) };
  }
  if ([429, 502, 503, 504].includes(res.status)) return { kind: "transient", reason };
  return { kind: "failed", reason, ...(receipt ? { receipt } : {}) };
}

export type SettleOptions = {
  /** Total deposit presentations (first try included). */
  maxAttempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onStep?: (attempt: number, step: SettleStep) => void;
};

/**
 * Round trip 2: present the deposit and retry the same payload while the operation is open.
 * Returns on `paid`; throws X402IntentsError on a terminal failure or when attempts run out
 * (the operation may still settle — check the order before doing anything else, never re-pay).
 */
export async function settleDeposit(
  merchant: NearmerchClient,
  orderId: string,
  quoted: QuotedPayment,
  txHash: string,
  opts: SettleOptions = {},
): Promise<Extract<SettleStep, { kind: "paid" }>> {
  const maxAttempts = opts.maxAttempts ?? 40;
  const delayMs = opts.delayMs ?? 5_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const header = encodeHeader(buildDepositPayload(quoted, txHash));
  let last: SettleStep | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await merchant.pay(orderId, header);
    const step = classifySettle(res);
    opts.onStep?.(attempt, step);
    if (step.kind === "paid") return step;
    if (step.kind === "failed") {
      throw new X402IntentsError(`settlement failed: ${step.reason} (${JSON.stringify(res.body)})`, step.reason, res);
    }
    last = step;
    if (attempt < maxAttempts) await sleep(step.kind === "transient" ? delayMs * 2 : delayMs);
  }
  throw new X402IntentsError(
    `settlement still open after ${maxAttempts} attempts (${last?.kind}: ${"reason" in (last ?? {}) ? (last as { reason: string }).reason : "?"}). ` +
      `Do NOT pay again — re-run settle later with the same tx hash, or check GET /api/orders/${orderId}.`,
    last && "reason" in last ? last.reason : "settlement_timeout",
  );
}
