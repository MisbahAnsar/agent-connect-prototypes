/**
 * Fake Ping Agent Pay facilitator (/verify quote + /settle deposit, x402 #3370 shapes).
 * Settles against FakeBase deliveries: short → INCOMPLETE_DEPOSIT, enough → success.
 */
import type { FakeBase } from "./ledger";

type Requirements = { network: string; asset: string; extra?: Record<string, unknown> };
type Payload = { accepted: Requirements; resource?: { url: string }; payload: Record<string, unknown> };

export type PingScenario = {
  /** Base delivery Ping asks for per USDC of destination (bps over 10_000). */
  amountInBps?: number;
  /** settle returns settlement_pending this many times before observing the deposit. */
  pendingSettles?: number;
  /** settle reports INCOMPLETE_DEPOSIT this many times even when funded (1Click lag). */
  incompleteSettles?: number;
  quoteUnavailable?: boolean;
  terminalFailure?: boolean;
  refundDeadlineMs?: number;
};

export class FakePing {
  readonly quotes = new Map<string, { amountIn: bigint; destination: { amount: string; network: string }; token: string; refundTo: string }>();
  verifyCalls = 0;
  settleCalls = 0;
  private n = 0;

  constructor(
    private readonly base: FakeBase,
    readonly scenario: PingScenario = {},
    private readonly now: () => number = Date.now,
  ) {}

  verify(paymentPayload: Payload, requirements: Requirements) {
    this.verifyCalls++;
    if (this.scenario.quoteUnavailable) return { isValid: false, invalidReason: "invalid_exact_near_intents_quote_unavailable" };
    const refundTo = String(paymentPayload.payload.refundTo ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(refundTo)) return { isValid: false, invalidReason: "refund_address_required" };
    const destination = requirements.extra?.destination as { amount: string; network: string };
    const amountIn = (BigInt(destination.amount) * BigInt(this.scenario.amountInBps ?? 10_150)) / 10_000n;
    const depositAddress = `0x${(++this.n).toString(16).padStart(40, "d")}`;
    const token = `optok_${this.n}_${paymentPayload.resource?.url ?? ""}`;
    this.quotes.set(depositAddress, { amountIn, destination, token, refundTo });
    return {
      isValid: true,
      extra: {
        depositAddress,
        amountIn: amountIn.toString(),
        refundDeadline: new Date(this.now() + (this.scenario.refundDeadlineMs ?? 30 * 60_000)).toISOString(),
        operationToken: token,
      },
    };
  }

  settle(paymentPayload: Payload) {
    this.settleCalls++;
    const p = paymentPayload.payload;
    const depositAddress = String(p.depositAddress);
    const quote = this.quotes.get(depositAddress);
    if (!quote || quote.token !== p.operationToken) return { success: false, errorReason: "invalid_exact_near_intents_token_invalid", transaction: "", network: paymentPayload.accepted.network };
    if (this.scenario.terminalFailure) return { success: false, errorReason: "exact_near_intents_payment_failed", transaction: String(p.txHash), network: paymentPayload.accepted.network };
    if ((this.scenario.pendingSettles ?? 0) > 0) {
      this.scenario.pendingSettles!--;
      return { success: false, errorReason: "settlement_pending", transaction: String(p.txHash), network: paymentPayload.accepted.network };
    }
    const delivered = this.base.delivered(depositAddress);
    if (delivered < quote.amountIn || (this.scenario.incompleteSettles ?? 0) > 0) {
      if ((this.scenario.incompleteSettles ?? 0) > 0) this.scenario.incompleteSettles!--;
      return { success: false, errorReason: "settlement_pending", transaction: String(p.txHash), network: paymentPayload.accepted.network, extra: { status: "INCOMPLETE_DEPOSIT" } };
    }
    return {
      success: true,
      transaction: `near_tx_${depositAddress.slice(-6)}`,
      network: quote.destination.network,
      amount: quote.destination.amount,
      payer: depositAddress,
      extra: { originNetwork: paymentPayload.accepted.network, originTxHash: String(p.txHash) },
    };
  }
}
