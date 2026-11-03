/**
 * Thin typed client for the NEAR Intents Agent API.
 * Contract: https://docs.agentsonintents.com/integration/agent-api/overview
 * Testnet:  https://www.usetidepool.tech (free, self-serve, tokens have no value)
 *
 * Deliberately dependency-free (plain fetch) so it runs on any Node >= 18.
 * The official SDK (`@near-intents-agent-api/sdk`, Node >= 24) is a drop-in
 * production alternative — see README.
 */
import { randomUUID } from "node:crypto";

export interface JsonApiError {
  status?: string;
  code: string;
  layer?: string;
  title?: string;
  detail?: string;
  source?: { pointer?: string };
  meta?: { retryable?: boolean };
}

export class AgentApiError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly errors: JsonApiError[],
    public readonly requestId?: string,
  ) {
    super(
      `Agent API ${httpStatus}: ${errors.map((e) => `${e.code}${e.layer ? ` [${e.layer}]` : ""}${e.detail ? ` — ${e.detail}` : ""}`).join("; ")}`,
    );
    this.name = "AgentApiError";
  }
  get code(): string | undefined {
    return this.errors[0]?.code;
  }
  get layer(): string | undefined {
    return this.errors[0]?.layer;
  }
}

export interface TokenInfo {
  asset_id: string;
  symbol?: string;
  decimals?: number;
  blockchain?: string;
  price?: number | null;
}

export interface IntentPayload {
  message?: string;
  nonce?: string;
  recipient?: string;
  [k: string]: unknown;
}

export interface GeneratedIntent {
  correlation_id: string;
  agent_id?: string;
  status: string;
  expires_at?: string;
  intent: { standard: string; payload: IntentPayload };
  preview?: { summary?: string; policy?: unknown };
}

export type ActionStatus =
  | "QUEUED"
  | "PROCESSING"
  | "PENDING_DEPOSIT"
  | "PENDING_APPROVAL"
  | "SUCCESS"
  | "FAILED"
  | "REFUNDED"
  | "UNCERTAIN"
  | "NEEDS_REVIEW";

export interface StatusObject {
  correlation_id: string;
  agent_id?: string;
  type: string;
  status: ActionStatus;
  failure_code: string | null;
  created_at?: string;
  updated_at?: string;
  grant?: { id?: string; label?: string } | null;
  details: Record<string, unknown>;
}

export interface PolicyState {
  revision: number;
  status: string;
  provider_policy_synced?: boolean;
  policy: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

export interface Balance {
  asset_id: string;
  symbol?: string;
  decimals?: number;
  blockchain?: string;
  price?: number | null;
  balance_raw: string;
  balance: string;
  available_raw: string;
  available: string;
}

const TERMINAL_FAILURE = new Set(["FAILED", "REFUNDED", "NEEDS_REVIEW"]);

export class AgentApiClient {
  constructor(
    public readonly baseUrl: string,
    private apiKey?: string,
  ) {}

  setApiKey(key: string | undefined): void {
    this.apiKey = key;
  }

  private async request(
    method: string,
    path: string,
    opts: { body?: unknown; grant?: string; idempotencyKey?: string } = {},
  ): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    if (opts.grant) headers["x-grant-token"] = opts.grant;
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
    const res = await fetch(this.baseUrl.replace(/\/$/, "") + "/v1" + path, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errors: JsonApiError[] = Array.isArray(json?.errors) ? json.errors : [];
      throw new AgentApiError(res.status, errors, json?.meta?.request_id);
    }
    return { status: res.status, json };
  }

  /** Free self-serve partner key (testnet; no auth). */
  async createKey(name: string): Promise<string> {
    const { json } = await this.request("POST", "/keys", { body: { name } });
    return json.api_key as string;
  }

  async whoami(): Promise<unknown> {
    return (await this.request("GET", "/whoami")).json;
  }

  async tokens(): Promise<TokenInfo[]> {
    const { json } = await this.request("GET", "/tokens");
    return (json.data ?? json) as TokenInfo[];
  }

  async generateIntent(body: Record<string, unknown>, idempotencyKey?: string): Promise<GeneratedIntent> {
    const { json } = await this.request("POST", "/generate-intent", { body, idempotencyKey });
    return json as GeneratedIntent;
  }

  async submitIntent(
    type: string,
    correlationId: string,
    signedData: Record<string, unknown>,
  ): Promise<void> {
    await this.request("POST", "/submit-intent", {
      body: { type, correlation_id: correlationId, signed_data: signedData },
    });
  }

  async status(correlationId: string, waitMs = 30000): Promise<StatusObject> {
    const { json } = await this.request(
      "GET",
      `/status?correlation_id=${encodeURIComponent(correlationId)}&wait_ms=${waitMs}`,
    );
    return json as StatusObject;
  }

  /**
   * Long-poll until the correlation reaches a final state.
   * Returns on SUCCESS; throws on FAILED/REFUNDED/NEEDS_REVIEW (UNCERTAIN keeps polling).
   */
  async settle(correlationId: string, timeoutMs = 120000): Promise<StatusObject> {
    const deadline = Date.now() + timeoutMs;
    let last: StatusObject | undefined;
    while (Date.now() < deadline) {
      last = await this.status(correlationId, 30000);
      if (last.status === "SUCCESS") return last;
      if (TERMINAL_FAILURE.has(last.status)) {
        throw new Error(
          `${last.type} ended ${last.status}${last.failure_code ? ` (${last.failure_code})` : ""}: ${JSON.stringify(last.details?.failure_reason ?? last.details ?? {}).slice(0, 400)}`,
        );
      }
    }
    throw new Error(
      `Timed out waiting for ${correlationId}; last status ${last?.status ?? "unknown"}`,
    );
  }

  async getAgent(agentId: string): Promise<Record<string, any>> {
    return (await this.request("GET", `/agents/${agentId}`)).json;
  }

  async getPolicy(agentId: string): Promise<PolicyState> {
    return (await this.request("GET", `/agents/${agentId}/policy`)).json;
  }

  /**
   * `source` is network-dependent (mainnet: "public" | "confidential";
   * Tidepool testnet: "intents"), so it's optional and omitted by default.
   */
  async getBalances(
    agentId: string,
    source?: "public" | "confidential" | "intents",
  ): Promise<{ near_account_id?: string; balances: Balance[] }> {
    const q = source ? `?source=${source}` : "";
    return (await this.request("GET", `/agents/${agentId}/balances${q}`)).json;
  }

  async listGrants(agentId: string): Promise<{ data: Array<Record<string, any>> }> {
    return (await this.request("GET", `/agents/${agentId}/grants`)).json;
  }

  /**
   * Submit an agent action (swap/transfer/withdraw/deposit).
   * Returns 202 {correlation_id, ...}. Pass `grant` for spending actions;
   * `dry: true` in the body yields a 200 quote instead (swap: no grant needed).
   */
  async action(
    kind: "swap" | "transfer" | "withdraw" | "deposit",
    agentId: string,
    body: Record<string, unknown>,
    opts: { grant?: string; idempotencyKey?: string } = {},
  ): Promise<Record<string, any>> {
    // The API requires an Idempotency-Key on every action; auto-generate one
    // (callers should pass and persist their own for safe retries).
    const idempotencyKey = opts.idempotencyKey ?? `api-${randomUUID()}`;
    const { status, json } = await this.request(
      "POST",
      `/agents/${agentId}/${kind}`,
      { body, grant: opts.grant, idempotencyKey },
    );
    if (status !== 202 && status !== 200) {
      throw new Error(`Unexpected ${status} for ${kind}: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return json;
  }
}
