import {
  AgentApiError as SdkError,
  createAgentApi,
  createGrantCredential,
  grantCommitment,
  type AgentApi,
  type BalanceSource,
  type GenerateIntentResponse,
  type SignedData,
  type StatusResponse,
} from "@near-intents-agent-api/sdk";
import { AgentApiError } from "../errors";
import type { Balances, Policy, TokenInfo } from "../policy/types";
import type { AgentClient, GrantClient, OpStatus, Operation } from "./types";

/**
 * Signs an owner intent with the owner's wallet. The SDK holds no signers: implement this with the
 * NEAR wallet, an EVM wallet or a passkey (see the SDK README's "Signing" section) and return the
 * submission body for `generated.intent`, unchanged.
 */
export interface OwnerSigner {
  sign(generated: GenerateIntentResponse): Promise<SignedData>;
}

export type LiveOptions = {
  apiKey: string;
  baseUrl?: string;
  owner: OwnerSigner;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Long-poll slice for owner intents (the API caps it at 30s). */
  waitMs?: number;
  /**
   * Balance source: tidepool only reports "intents"; the hosted mainnet API defaults to "public".
   * The SDK's schema predates tidepool, so "intents" is cast at the call site.
   */
  balancesSource?: "public" | "confidential" | "intents";
};

const TERMINAL = new Set<StatusResponse["status"]>(["SUCCESS", "REFUNDED", "FAILED", "UNCERTAIN", "NEEDS_REVIEW"]);

/** Real statuses -> the demo's smaller vocabulary. `UNCERTAIN` stays in flight: never treat it as failed. */
export function mapStatus(s: StatusResponse["status"]): OpStatus {
  switch (s) {
    case "SUCCESS": return "SUCCESS";
    case "QUEUED": return "QUEUED";
    case "REFUNDED":
    case "FAILED":
    case "NEEDS_REVIEW": return "FAILED";
    default: return "PROCESSING"; // PROCESSING, UNCERTAIN, PENDING_*
  }
}

/** Run an SDK call; surface its stable error `code` through the same error class the runner already handles. */
export async function translate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SdkError) throw new AgentApiError(e.code, e.message, e.status);
    throw e;
  }
}

const toOperation = (
  s: Pick<StatusResponse, "correlation_id" | "status" | "failure_code">,
  request: Operation["request"],
  idempotencyKey: string,
): Operation => ({
  correlation_id: s.correlation_id,
  status: mapStatus(s.status),
  ...(s.failure_code ? { failure_code: s.failure_code } : {}),
  request,
  idempotencyKey,
});

/**
 * The quote object's fields are not specified by the API schema, so read the output amount defensively
 * (the 1Click-style `amountOut`, snake_case, or nested under `quote`) and return null if it is absent.
 */
export function quoteAmountOut(quote: unknown): string | null {
  const find = (o: unknown, depth = 0): string | null => {
    if (!o || typeof o !== "object" || depth > 2) return null;
    const rec = o as Record<string, unknown>;
    for (const k of ["amountOut", "amount_out", "destination_amount"]) {
      const v = rec[k];
      if ((typeof v === "string" || typeof v === "number") && /^[0-9]+$/.test(String(v))) return String(v);
    }
    for (const v of Object.values(rec)) {
      const r = find(v, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return find(quote);
}

const EMPTY_REQUEST: Operation["request"] = { asset: "", amount: "0", chain: "", recipient: "" };

/**
 * The real Agent API behind the same interfaces the mock implements. Owner actions are
 * generate -> sign -> submit -> wait; grant actions use `forGrant(token)`.
 *
 * Not exercised against the live service from this repo: that needs a funded owner account and an
 * API key. The unit tests drive it through the real SDK with a fake `fetch`.
 */
export class LiveAgentApi implements AgentClient {
  private readonly api: AgentApi;
  private readonly waitMs: number;

  constructor(private readonly opts: LiveOptions) {
    this.api = createAgentApi({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, fetch: opts.fetch });
    this.waitMs = opts.waitMs ?? 30_000;
  }

  private async settled(correlationId: string) {
    for (;;) {
      const status = await this.api.getStatus(correlationId, { waitMs: this.waitMs });
      if (TERMINAL.has(status.status)) return status;
    }
  }

  /** The four owner steps. Throws the API's failure code unless the intent succeeds. */
  private async ownerAction(request: Parameters<AgentApi["generateIntent"]>[0]) {
    return translate(async () => {
      const generated = await this.api.generateIntent(request);
      const signedData = await this.opts.owner.sign(generated);
      await this.api.submitIntent({ type: generated.type, correlation_id: generated.correlation_id, signed_data: signedData });
      const status = await this.settled(generated.correlation_id);
      if (status.status !== "SUCCESS") throw new AgentApiError(status.failure_code ?? status.status, undefined, 409);
      return status;
    });
  }

  async getTokens(): Promise<TokenInfo[]> {
    return translate(async () => (await this.api.getTokens()) as unknown as TokenInfo[]);
  }

  async getPolicy(agentId: string) {
    const view = await translate(() => this.api.getPolicy(agentId));
    return { policy: view.policy as unknown as Policy | null, revision: view.revision };
  }

  async updatePolicy(agentId: string, policy: Policy, expectedRevision: number) {
    await this.ownerAction({
      type: "policy_update",
      agent_id: agentId,
      expected_revision: expectedRevision,
      policy: policy as unknown as Extract<Parameters<AgentApi["generateIntent"]>[0], { type: "policy_update" }>["policy"],
    });
    const { revision } = await this.getPolicy(agentId);
    return { revision: revision ?? expectedRevision + 1 };
  }

  async issueGrant(agentId: string, label: string, expiresAt: Date) {
    const { token, commitment } = createGrantCredential();
    await this.ownerAction({ type: "grant_issue", agent_id: agentId, label, credential: commitment, expires_at: expiresAt.toISOString() });
    return { token };
  }

  async revokeGrant(agentId: string, token: string) {
    const commitment = grantCommitment(token);
    const grants = await translate(() => this.api.listGrants(agentId));
    const grant = grants.find((g) => g.owner_message.credential === commitment);
    if (!grant) throw new AgentApiError("grant_not_found", undefined, 404);
    await this.ownerAction({ type: "grant_revoke", agent_id: agentId, grant_id: grant.grant_id });
  }

  forGrant(token: string): GrantClient {
    const grant = this.api.forGrant(token);
    const balancesSource = this.opts.balancesSource ?? "public";
    return {
      getBalances: async (agentId) => {
        const view = await translate(() => this.api.getBalances(agentId, { source: balancesSource as BalanceSource }));
        const balances: Balances = {};
        for (const b of view.balances) balances[b.asset_id] = (BigInt(balances[b.asset_id] ?? "0") + BigInt(b.balance_raw)).toString();
        return { balances };
      },
      withdraw: (agentId, req, { idempotencyKey }) =>
        translate(async () => {
          const res = await grant.withdraw(agentId, { asset: req.asset, amount: req.amount, chain: req.chain, recipient: req.recipient, ...(req.memo ? { memo: req.memo } : {}) }, { idempotencyKey });
          return toOperation(res, req, idempotencyKey);
        }),
      quote: (agentId, req) =>
        translate(async () => {
          const res = await grant.swap(agentId, { ...req, dry: true });
          const amountOut = quoteAmountOut(res.quote);
          if (amountOut === null) throw new AgentApiError("quote_unavailable", "quote carried no output amount", 502);
          return { amountOut };
        }),
      swap: (agentId, req, { idempotencyKey }) =>
        translate(async () => {
          const res = await grant.swap(agentId, req, { idempotencyKey });
          const op = toOperation(res, { asset: req.origin_asset, amount: req.amount, chain: "", recipient: "" }, idempotencyKey);
          return { ...op, swap: { request: req } };
        }),
      transfer: (agentId, req) =>
        translate(async () => {
          const res = await grant.transfer(agentId, req);
          return toOperation(res, { ...req, chain: "near" }, res.idempotencyKey);
        }),
    };
  }

  async getStatus(correlationId: string) {
    const s = await translate(() => this.api.getStatus(correlationId));
    return toOperation(s, EMPTY_REQUEST, "");
  }

  async listScheduledExecutions(agentId: string) {
    const page = await translate(() => this.api.listScheduledExecutions(agentId));
    return page.data.map((e): Operation => ({
      correlation_id: e.correlation_id,
      status: "QUEUED",
      execute_after: e.execute_after,
      request: EMPTY_REQUEST,
      idempotencyKey: "",
    }));
  }

  async cancelExecution(agentId: string, correlationId: string) {
    await this.ownerAction({ type: "execution_cancel", agent_id: agentId, correlation_id: correlationId });
    return this.getStatus(correlationId);
  }
}
