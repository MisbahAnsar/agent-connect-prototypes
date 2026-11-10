/**
 * Agent Connect over MCP (Streamable HTTP, `Authorization: Bearer $AGENT_CONNECT_KEY`): the payer
 * wallet. Moves NEAR Intents USDC to Ping's quoted Base deposit address with withdraw_preview →
 * withdraw → get_operation, and can sign the nearmerch NEP-413 login with near_sign_message.
 *
 * Ported from Ping's ping-checkout-example/examples/agent-connect-pay (lib/mcp.ts,
 * lib/gross-up-withdraw.ts), with fetch/sleep injected for offline tests.
 * Tool reference: https://agent-connect-app-production.up.railway.app/docs/mcp-tools
 */
import type { WalletInterface } from "near-sign-verify";
import type { Fetch } from "./nearmerch";

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export class AgentConnectToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
    readonly code?: string,
    readonly layer?: string,
  ) {
    super(`${tool}: ${message}`);
  }
}

export class AgentConnectMcp {
  private readonly url: string;
  private sessionId: string | null = null;
  private nextId = 1;
  private protocolVersion = "2025-03-26";
  private readonly fetchImpl: Fetch;
  private readonly bearer: string;

  constructor(opts: { url: string; bearer: string; fetchImpl?: Fetch }) {
    this.url = opts.url.replace(/\/$/, "");
    this.bearer = opts.bearer;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async connect(): Promise<void> {
    const init = await this.rpc("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: "nearmerch-agent-pay", version: "0.1.0" },
    });
    const v = (init as { protocolVersion?: string } | undefined)?.protocolVersion;
    if (v) this.protocolVersion = v;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    const res = (await this.rpc("tools/list", {})) as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
    return res?.tools ?? [];
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.rpc("tools/call", { name, arguments: args });
    return parseToolResult<T>(name, result);
  }

  async disconnect(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.fetchImpl(this.url, { method: "DELETE", headers: this.headers() });
    } catch {
      // best effort
    }
    this.sessionId = null;
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const res = await this.post({ jsonrpc: "2.0", id: this.nextId++, method, params });
    if (res.error) throw new AgentConnectToolError(method, res.error.message);
    return res.result;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.bearer}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": this.protocolVersion,
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
    };
  }

  private async post(body: Record<string, unknown>): Promise<JsonRpcResponse> {
    const res = await this.fetchImpl(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify(body) });
    const session = res.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (res.status === 202) return { jsonrpc: "2.0", id: null, result: null };
    const text = await res.text();
    // Never echo request headers (they carry the bearer key); the body is the server's own error.
    if (res.status === 401) throw new AgentConnectToolError("mcp", "HTTP 401 — AGENT_CONNECT_KEY missing, expired (30-day keys) or revoked");
    if (!res.ok) throw new AgentConnectToolError("mcp", `HTTP ${res.status}: ${text.slice(0, 300)}`);
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) return parseSse(text);
    return JSON.parse(text) as JsonRpcResponse;
  }
}

function parseSse(raw: string): JsonRpcResponse {
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      return JSON.parse(payload) as JsonRpcResponse;
    } catch {
      continue;
    }
  }
  throw new AgentConnectToolError("mcp", "no JSON-RPC message in SSE stream");
}

function parseToolResult<T>(tool: string, result: unknown): T {
  const r = result as { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };
  const text = r?.content?.find((c) => c.type === "text")?.text;
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // plain text
    }
  }
  if (r?.isError) {
    const err = (parsed as { error?: { code?: string; layer?: string; next_step?: string; detail?: string } })?.error;
    if (err?.code) {
      throw new AgentConnectToolError(tool, `${err.code}${err.detail ? ` (${err.detail})` : ""}${err.next_step ? ` — ${err.next_step}` : ""}`, err.code, err.layer);
    }
    throw new AgentConnectToolError(tool, typeof parsed === "string" ? parsed : JSON.stringify(parsed ?? "tool error"));
  }
  if (r?.structuredContent !== undefined) return r.structuredContent as T;
  return (parsed ?? result) as T;
}

// ── accounts ──────────────────────────────────────────────────────────────

export type AgentAccount = {
  name: string;
  intents_account_id?: string;
  near_account_id?: string;
  evm_account_id?: string;
  enabled?: boolean;
};

/** get_accounts, then the named account (or the first enabled one). Pass the exact name to later calls. */
export async function resolveAccount(mcp: AgentConnectMcp, wanted?: string): Promise<AgentAccount> {
  const res = await mcp.callTool<{ accounts?: AgentAccount[] } | AgentAccount[]>("get_accounts", {});
  const accounts = Array.isArray(res) ? res : (res.accounts ?? []);
  const account = wanted ? accounts.find((a) => a.name === wanted) : accounts.find((a) => a.enabled !== false);
  if (!account) {
    throw new Error(`Agent Connect account ${wanted ? `"${wanted}" ` : ""}not found (have: ${accounts.map((a) => a.name).join(", ") || "none"})`);
  }
  return account;
}

export type Balance = { token?: string; asset_id?: string; balance_raw?: string; available_raw?: string };

/** Spendable atomic balance of `token` (confidential source — public reads are unavailable). */
export async function availableBalance(mcp: AgentConnectMcp, account: string, token: string): Promise<bigint> {
  const res = await mcp.callTool<{ balances?: Balance[] } | Balance[]>("get_balances", { account, source: "confidential" });
  const balances = Array.isArray(res) ? res : (res.balances ?? []);
  const entry = balances.find((b) => (b.token ?? b.asset_id) === token);
  return BigInt(entry?.available_raw ?? entry?.balance_raw ?? "0");
}

// ── withdraw: gross-up, submit, poll ───────────────────────────────────────

export type WithdrawPreview = {
  quote?: { amount_out?: string; min_amount_out?: string; time_estimate_seconds?: number };
  spend?: { amount_usd?: string };
  warnings?: Array<{ code?: string; message?: string; [k: string]: unknown }>;
};

/** Preview warnings that mean the real withdraw would be refused (see "Budget, Previews and Fees"). */
const REFUSAL_WARNINGS = new Set([
  "policy_action_denied",
  "policy_destination_denied",
  "policy_schedule_denied",
  "spend_price_unavailable",
  "spend_budget_exceeded",
  "policy_transaction_limit_exceeded",
  "policy_limit_exceeded",
  "policy_action_limit_exceeded",
  "insufficient_balance",
  // older names used by Ping's example
  "frozen",
  "owner_approval_required",
  "timelock",
  "destination_not_allowed",
  "limit_exceeded",
  "schedule_blocked",
]);

export function refusalWarnings(preview: WithdrawPreview): string[] {
  return (preview.warnings ?? [])
    .filter((w) => w.code && REFUSAL_WARNINGS.has(w.code))
    .map((w) => `${w.code}${w.message ? `: ${w.message}` : ""}`);
}

export type GrossUp = { sourceAmount: bigint; amountOut: bigint; previewsUsed: number; preview: WithdrawPreview };

/**
 * Bridged withdrawals report `quote.amount_out` on the destination chain net of bridge cost, and
 * Ping's `amountIn` is a MINIMUM delivery. Bump the source amount until amount_out >= required.
 * Each preview spends one of the wallet's custody operations, so the loop is capped.
 */
export async function grossUpWithdraw(
  mcp: AgentConnectMcp,
  args: { account: string; token: string; chain: string; to: string; requiredOut: bigint; maxPreviews: number },
): Promise<GrossUp> {
  let sourceAmount = args.requiredOut;
  for (let i = 1; i <= args.maxPreviews; i++) {
    const preview = await mcp.callTool<WithdrawPreview>("withdraw_preview", {
      account: args.account,
      token: args.token,
      amount: sourceAmount.toString(),
      chain: args.chain,
      to: args.to,
    });
    const refusals = refusalWarnings(preview);
    if (refusals.length) throw new Error(`withdraw would be refused: ${refusals.join("; ")}`);
    const out = preview.quote?.amount_out;
    if (!out || !/^\d+$/.test(out)) throw new Error("withdraw_preview returned no quote.amount_out");
    const amountOut = BigInt(out);
    if (amountOut >= args.requiredOut) return { sourceAmount, amountOut, previewsUsed: i, preview };
    if (amountOut === 0n) throw new Error("withdraw_preview quoted amount_out 0 (below route minimum?)");
    // proportional bump + 2% headroom (Ping's live E2E: 202064 → 212166)
    sourceAmount = (sourceAmount * args.requiredOut * 102n) / (amountOut * 100n) + 1n;
  }
  throw new Error(`gross-up: amount_out still below ${args.requiredOut} after ${args.maxPreviews} previews`);
}

export type Operation = {
  operation_id?: string;
  status?: string;
  failure_code?: string | null;
  details?: { evidence?: { destination_tx_hash?: string }; destination_tx_hash?: string; amount_out?: string; [k: string]: unknown };
};

export async function submitWithdraw(
  mcp: AgentConnectMcp,
  args: { account: string; token: string; amount: bigint; chain: string; to: string; idempotencyKey: string },
): Promise<Operation> {
  const op = await mcp.callTool<Operation>("withdraw", {
    account: args.account,
    token: args.token,
    amount: args.amount.toString(),
    chain: args.chain,
    to: args.to,
    idempotency_key: args.idempotencyKey,
  });
  if (!op.operation_id) throw new Error(`withdraw returned no operation_id: ${JSON.stringify(op)}`);
  return op;
}

/** Polls get_operation (refresh_operation on UNCERTAIN) until SUCCESS; throws on FAILED/REFUNDED/NEEDS_REVIEW. */
export async function waitForOperation(
  mcp: AgentConnectMcp,
  operationId: string,
  opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; onStatus?: (op: Operation) => void } = {},
): Promise<Operation> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const pollMs = opts.pollMs ?? 3_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const started = now();
  let uncertain = false;
  while (now() - started < timeoutMs) {
    const op: Operation = await mcp.callTool<Operation>(uncertain ? "refresh_operation" : "get_operation", { operation_id: operationId });
    opts.onStatus?.(op);
    const status: string = (op.status ?? "").toUpperCase();
    if (status === "SUCCESS") return op;
    if (status === "FAILED" || status === "REFUNDED" || status === "NEEDS_REVIEW") {
      throw new Error(`withdraw ${operationId} ended ${status}${op.failure_code ? ` (${op.failure_code})` : ""}`);
    }
    uncertain = status === "UNCERTAIN";
    await sleep(pollMs);
  }
  throw new Error(`timed out waiting for withdraw ${operationId} — keep polling it, never resubmit under a new key`);
}

export function destinationTxHash(op: Operation): string {
  const hash = op.details?.evidence?.destination_tx_hash ?? op.details?.destination_tx_hash;
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error(`operation ${op.operation_id} has no Base destination_tx_hash yet`);
  }
  return hash;
}

// ── NEP-413 sign-in through the agent's own NEAR key ───────────────────────

/**
 * near-sign-verify WalletInterface backed by Agent Connect's `near_sign_message`.
 * Needs the owner to enable `native.near.sign_message` for recipient `near-merch-store.near`.
 * The tool's exact argument/response field names are not in the public docs; this sends the
 * NEP-413 names (message, recipient, nonce as base64) and accepts snake_case or camelCase back.
 */
export function agentConnectNep413Wallet(mcp: AgentConnectMcp, account: string): WalletInterface {
  return {
    async signMessage({ message, recipient, nonce }) {
      const res = await mcp.callTool<Record<string, unknown>>("near_sign_message", {
        account,
        message,
        recipient,
        nonce: Buffer.from(nonce).toString("base64"),
      });
      const pick = (...keys: string[]) => keys.map((k) => res[k]).find((x): x is string => typeof x === "string");
      const accountId = pick("accountId", "account_id", "near_account_id");
      const publicKey = pick("publicKey", "public_key");
      const signature = pick("signature");
      if (!accountId || !publicKey || !signature) {
        throw new Error(`near_sign_message returned unexpected fields: ${Object.keys(res).join(", ")}`);
      }
      return { accountId, publicKey, signature };
    },
  };
}
