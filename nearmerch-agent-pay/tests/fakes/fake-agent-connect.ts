/**
 * Fake Agent Connect MCP server (Streamable HTTP JSON-RPC): Bearer auth, session id, SSE or JSON
 * replies, and the tools the prototype uses. A bridged withdraw delivers amount minus
 * (feeBps + fixedFee) to FakeBase after `pollsUntilSuccess` get_operation calls.
 */
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { NEAR_USDC_TOKEN } from "../../src/config";
import { base58 } from "./keys";
import { json, type FakeBase, type Handler } from "./ledger";

export const MCP = "https://mcp.test";
export const AC_KEY = "ack_test_secret_never_printed";

export type AgentConnectScenario = {
  balance?: bigint;
  feeBps?: bigint;
  fixedFee?: bigint;
  pollsUntilSuccess?: number;
  /** one UNCERTAIN status before SUCCESS (exercises refresh_operation) */
  uncertainOnce?: boolean;
  previewWarnings?: Array<{ code: string; message?: string }>;
  failWithdraw?: boolean;
  sse?: boolean;
};

type Op = { operation_id: string; status: string; amount: bigint; to: string; polls: number; key: string; txHash?: string; out: bigint };

export class FakeAgentConnect {
  readonly calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  readonly ops = new Map<string, Op>();
  balance: bigint;
  private session = "mcp-session-1";
  private n = 0;
  private uncertainUsed = false;
  readonly nearKey = generateKeyPairSync("ed25519");
  readonly nearPublicKey: string;

  constructor(
    private readonly base: FakeBase,
    readonly scenario: AgentConnectScenario = {},
  ) {
    this.balance = scenario.balance ?? 100_000_000n;
    const jwk = this.nearKey.publicKey.export({ format: "jwk" });
    this.nearPublicKey = `ed25519:${base58(Buffer.from(jwk.x!, "base64url"))}`;
  }

  count(tool: string): number {
    return this.calls.filter((c) => c.tool === tool).length;
  }

  private quoteOut(amount: bigint): bigint {
    const out = amount - (amount * (this.scenario.feeBps ?? 100n)) / 10_000n - (this.scenario.fixedFee ?? 20_000n);
    return out > 0n ? out : 0n;
  }

  handle: Handler = async (req) => {
    if (req.headers.get("authorization") !== `Bearer ${AC_KEY}`) {
      return json(401, { jsonrpc: "2.0", error: { code: -32000, message: "missing authorization header" }, id: null });
    }
    if (req.method === "DELETE") return new Response(null, { status: 200 });
    const msg = (await req.json()) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (msg.method === "initialize") {
      return json(200, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake-agent-connect" } } }, { "mcp-session-id": this.session });
    }
    if (req.headers.get("mcp-session-id") !== this.session) return json(400, { error: "missing session" });
    if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (msg.method === "tools/list") {
      return this.reply(msg.id, { tools: ["get_accounts", "get_balances", "get_policy", "withdraw_preview", "withdraw", "get_operation", "refresh_operation", "near_sign_message"].map((name) => ({ name, inputSchema: { type: "object" } })) });
    }
    if (msg.method !== "tools/call") return json(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    const tool = msg.params!.name!;
    const args = msg.params!.arguments ?? {};
    this.calls.push({ tool, args });
    try {
      return this.reply(msg.id, { content: [{ type: "text", text: JSON.stringify(this.tool(tool, args)) }] });
    } catch (e) {
      const err = e as { code?: string; layer?: string };
      return this.reply(msg.id, { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: err.code ?? "unknown", layer: err.layer ?? "api", next_step: "fix it" } }) }] });
    }
  };

  private reply(id: number | undefined, result: unknown): Response {
    const body = { jsonrpc: "2.0", id, result };
    if (this.scenario.sse) {
      return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return json(200, body);
  }

  private tool(name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case "get_accounts":
        return { accounts: [{ name: "Checking", enabled: true, intents_account_id: "agent.intents", near_account_id: "a".repeat(64), evm_account_id: "0x1111111111111111111111111111111111111111" }] };
      case "get_balances":
        return { balances: [{ token: NEAR_USDC_TOKEN, balance_raw: this.balance.toString(), available_raw: this.balance.toString() }] };
      case "get_policy":
        return { destinations: { mode: "any" }, actions: { withdraw: true }, timelock_ms: 0 };
      case "get_network_status":
        return { one_click: "operational", custody: "operational", near: "operational" };
      case "withdraw_preview": {
        const amount = BigInt(String(args.amount));
        const warnings = [...(this.scenario.previewWarnings ?? [])];
        if (amount > this.balance) warnings.push({ code: "insufficient_balance" });
        return { quote: { amount_out: this.quoteOut(amount).toString(), time_estimate_seconds: 30 }, spend: { amount_usd: String(Number(amount) / 1e6) }, fee: null, warnings };
      }
      case "withdraw": {
        if (this.scenario.failWithdraw) throw Object.assign(new Error(), { code: "policy_destination_denied", layer: "policy" });
        const key = String(args.idempotency_key);
        const amount = BigInt(String(args.amount));
        const existing = [...this.ops.values()].find((o) => o.key === key);
        if (existing) {
          if (existing.amount !== amount || existing.to !== args.to) throw Object.assign(new Error(), { code: "idempotency_conflict", layer: "request" });
          return { operation_id: existing.operation_id, status: existing.status };
        }
        if (amount > this.balance) throw Object.assign(new Error(), { code: "insufficient_balance", layer: "balance" });
        this.balance -= amount;
        const op: Op = { operation_id: `op_${++this.n}`, status: "PROCESSING", amount, to: String(args.to), polls: 0, key, out: this.quoteOut(amount) };
        this.ops.set(op.operation_id, op);
        return { operation_id: op.operation_id, status: op.status };
      }
      case "get_operation":
      case "refresh_operation": {
        const op = this.ops.get(String(args.operation_id));
        if (!op) throw Object.assign(new Error(), { code: "operation_not_found", layer: "request" });
        op.polls++;
        if (op.status !== "SUCCESS" && this.scenario.uncertainOnce && !this.uncertainUsed && name === "get_operation") {
          this.uncertainUsed = true;
          return { operation_id: op.operation_id, status: "UNCERTAIN", failure_code: null, details: {} };
        }
        if (op.status !== "SUCCESS" && op.polls >= (this.scenario.pollsUntilSuccess ?? 2)) {
          op.txHash = this.base.deliver(op.to, op.out);
          op.status = "SUCCESS";
        }
        return {
          operation_id: op.operation_id, status: op.status, failure_code: null,
          details: op.status === "SUCCESS" ? { amount_out: op.out.toString(), evidence: { destination_tx_hash: op.txHash } } : { expected_amount_out: op.out.toString() },
        };
      }
      case "near_sign_message": {
        const nonce = Buffer.from(String(args.nonce), "base64");
        if (nonce.length !== 32) throw Object.assign(new Error(), { code: "invalid_nonce", layer: "request" });
        const sig = edSign(null, Buffer.from(`${args.message}|${args.recipient}|${nonce.toString("hex")}`), this.nearKey.privateKey);
        return { account_id: "a".repeat(64), public_key: this.nearPublicKey, signature: sig.toString("base64") };
      }
      default:
        throw Object.assign(new Error(), { code: "unknown_tool", layer: "request" });
    }
  }
}
