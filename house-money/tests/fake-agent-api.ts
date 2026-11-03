import { AgentApiError } from "../src/errors";
import type { Balances, Policy, TokenInfo, WithdrawRequest } from "../src/policy/types";
import type { AgentClient, GrantClient, Operation, SwapRequest } from "../src/agent-api/types";
import { usdToMicro } from "../src/risk/pricing";

/** Ordinary policy edits are at least this far apart on the real API; a pure freeze bypasses it. */
export const POLICY_COOLDOWN_MS = 600_000;

/** Fee the mock takes on every swap, in basis points. */
export const MOCK_SWAP_FEE_BPS = 30n;

type Grant = { agentId: string; label: string; expiresAt: number; revoked: boolean };
type Agent = {
  balances: Map<string, bigint>;
  policy: Policy | null;
  revision: number | null;
  actionTimes: number[];
  /** When the last non-freeze policy edit was applied (10-minute cooldown). */
  lastPolicyChangeAt: number | null;
};

/** Controllable clock so the 1h timelock can be fast-forwarded in a simulation or test. */
export class MockClock {
  constructor(private t = Date.now()) {}
  now() {
    return this.t;
  }
  date() {
    return new Date(this.t);
  }
}

/**
 * Local stand-in for the Agent API. Enforces the same policy layers the simulation relies on:
 * grant validity, frozen, action allowlist, asset allowlist, destination allowlist,
 * per-transaction cap, hourly rate, balance, timelock queue, and idempotent replay.
 */
export class MockAgentApi implements AgentClient {
  readonly clock: MockClock;
  private agents = new Map<string, Agent>();
  private grants = new Map<string, Grant>();
  private ops = new Map<string, Operation>();
  private byKey = new Map<string, { op: Operation; fingerprint: string }>();
  private opAgent = new Map<string, string>();
  /** Settled withdrawals, newest last (for the dashboard and assertions). */
  readonly settled: Operation[] = [];
  /** Executed swaps, newest last. */
  readonly swaps: Operation[] = [];
  private seq = 0;

  constructor(
    private tokens: TokenInfo[],
    clock = new MockClock(),
  ) {
    this.clock = clock;
  }

  // ---- test / simulation controls -------------------------------------------------

  createAgent(agentId: string, balances: Record<string, bigint> = {}, policy: Policy | null = null) {
    this.agents.set(agentId, {
      balances: new Map(Object.entries(balances)),
      policy,
      revision: policy ? 1 : null,
      actionTimes: [],
      lastPolicyChangeAt: null,
    });
  }

  setBalance(agentId: string, asset: string, amount: bigint) {
    this.agent(agentId).balances.set(asset, amount);
  }

  setTokens(tokens: TokenInfo[]) {
    this.tokens = tokens;
  }

  /** Advance time and release any queued executions that are due. */
  advance(ms: number) {
    this.clock["t"] += ms;
    this.releaseDue();
  }

  // ---- AgentClient ----------------------------------------------------------

  async getTokens() {
    return this.tokens;
  }

  async getPolicy(agentId: string) {
    const a = this.agent(agentId);
    return { policy: a.policy, revision: a.revision };
  }

  async updatePolicy(agentId: string, policy: Policy, expectedRevision: number) {
    const a = this.agent(agentId);
    if ((a.revision ?? 0) !== expectedRevision) throw new AgentApiError("policy_revision_conflict", undefined, 409);
    const pureFreeze = a.policy !== null && !a.policy.frozen && policy.frozen && JSON.stringify({ ...a.policy, frozen: true }) === JSON.stringify(policy);
    if (!pureFreeze && a.lastPolicyChangeAt !== null && this.clock.now() - a.lastPolicyChangeAt < POLICY_COOLDOWN_MS)
      throw new AgentApiError("policy_change_throttled", undefined, 429);
    if (!pureFreeze) a.lastPolicyChangeAt = this.clock.now();
    a.policy = policy;
    a.revision = expectedRevision + 1;
    return { revision: a.revision };
  }

  async issueGrant(agentId: string, label: string, expiresAt: Date) {
    this.agent(agentId);
    const token = `ngt_mock_${++this.seq}`;
    this.grants.set(token, { agentId, label, expiresAt: expiresAt.getTime(), revoked: false });
    return { token };
  }

  async revokeGrant(_agentId: string, token: string) {
    const g = this.grants.get(token);
    if (g) g.revoked = true;
  }

  forGrant(token: string): GrantClient {
    return {
      getBalances: async (agentId) => {
        this.checkGrant(token, agentId);
        return { balances: this.balances(agentId) };
      },
      withdraw: async (agentId, req, opts) => this.withdraw(token, agentId, req, opts.idempotencyKey),
      quote: async (agentId, req) => {
        this.agent(agentId);
        return { amountOut: this.quoteOut(req).toString() };
      },
      swap: async (agentId, req, opts) => this.swap(token, agentId, req, opts.idempotencyKey),
      transfer: async (agentId, req) => {
        this.checkGrant(token, agentId);
        const policy = this.requirePolicy(agentId);
        if (!policy.actions.includes("transfer")) throw new AgentApiError("policy_action_denied");
        throw new AgentApiError("not_implemented_in_mock", undefined, 501);
      },
    };
  }

  async getStatus(correlationId: string) {
    const op = this.ops.get(correlationId);
    if (!op) throw new AgentApiError("not_found", undefined, 404);
    return { ...op };
  }

  async listScheduledExecutions(agentId: string) {
    this.agent(agentId);
    return [...this.ops.values()]
      .filter((o) => o.status === "QUEUED")
      .sort((a, b) => Date.parse(a.execute_after!) - Date.parse(b.execute_after!))
      .map((o) => ({ ...o }));
  }

  async cancelExecution(_agentId: string, correlationId: string) {
    const op = this.ops.get(correlationId);
    if (!op) throw new AgentApiError("not_found", undefined, 404);
    if (op.status !== "QUEUED") throw new AgentApiError("execution_not_cancellable", undefined, 409);
    op.status = "CANCELLED";
    delete op.execute_after;
    return { ...op };
  }

  // ---- internals ------------------------------------------------------------

  private agent(agentId: string) {
    const a = this.agents.get(agentId);
    if (!a) throw new AgentApiError("agent_not_found", undefined, 404);
    return a;
  }

  private balances(agentId: string): Balances {
    return Object.fromEntries([...this.agent(agentId).balances].map(([k, v]) => [k, v.toString()]));
  }

  private requirePolicy(agentId: string) {
    const p = this.agent(agentId).policy;
    if (!p) throw new AgentApiError("policy_not_ready", undefined, 409);
    return p;
  }

  private checkGrant(token: string, agentId: string) {
    const g = this.grants.get(token);
    if (!g || g.agentId !== agentId) throw new AgentApiError("agent_grant_required", undefined, 401);
    if (g.revoked) throw new AgentApiError("agent_grant_required", undefined, 401);
    if (g.expiresAt <= this.clock.now()) throw new AgentApiError("agent_grant_required", undefined, 401);
  }

  private async withdraw(token: string, agentId: string, req: WithdrawRequest, key: string) {
    this.checkGrant(token, agentId);
    const fingerprint = JSON.stringify([req.asset, req.amount, req.chain, req.recipient, req.memo ?? null]);
    const replay = this.byKey.get(`${agentId}:${key}`);
    if (replay) {
      // Same key + same request replays the original; the same key with a different body is a conflict.
      if (replay.fingerprint !== fingerprint) throw new AgentApiError("idempotency_conflict", undefined, 409);
      return { ...replay.op };
    }

    const a = this.agent(agentId);
    const policy = this.requirePolicy(agentId);
    this.validate(a, policy, req);

    const op: Operation = {
      correlation_id: `op_mock_${++this.seq}`,
      status: "QUEUED",
      request: req,
      idempotencyKey: key,
    };
    a.actionTimes.push(this.clock.now());
    this.ops.set(op.correlation_id, op);
    this.byKey.set(`${agentId}:${key}`, { op, fingerprint });
    this.opAgent.set(op.correlation_id, agentId);

    if (policy.timelock_ms > 0) {
      op.execute_after = new Date(this.clock.now() + policy.timelock_ms).toISOString();
    } else {
      this.execute(op, agentId);
    }
    return { ...op };
  }

  /** Expected output at the catalog prices, after the mock fee. Throws `quote_unavailable` without both prices. */
  private quoteOut(req: SwapRequest): bigint {
    const inT = this.tokens.find((t) => t.asset_id === req.origin_asset);
    const outT = this.tokens.find((t) => t.asset_id === req.destination_asset);
    if (!inT || !outT || inT.price === null || outT.price === null) throw new AgentApiError("quote_unavailable", undefined, 400);
    const valueMicro = (BigInt(req.amount) * usdToMicro(inT.price)) / 10n ** BigInt(inT.decimals);
    const gross = (valueMicro * 10n ** BigInt(outT.decimals)) / usdToMicro(outT.price);
    return (gross * (10_000n - MOCK_SWAP_FEE_BPS)) / 10_000n;
  }

  private async swap(token: string, agentId: string, req: SwapRequest, key: string) {
    this.checkGrant(token, agentId);
    const fingerprint = JSON.stringify(["swap", req.origin_asset, req.destination_asset, req.amount, req.min_amount_out ?? null]);
    const replay = this.byKey.get(`${agentId}:${key}`);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw new AgentApiError("idempotency_conflict", undefined, 409);
      return { ...replay.op };
    }
    const a = this.agent(agentId);
    const p = this.requirePolicy(agentId);
    if (p.frozen) throw new AgentApiError("wallet_frozen");
    if (!p.actions.includes("swap")) throw new AgentApiError("policy_action_denied");
    if (p.assets !== "any" && !(p.assets.includes(req.origin_asset) && p.assets.includes(req.destination_asset)))
      throw new AgentApiError("policy_denied");
    const amount = BigInt(req.amount);
    if (amount <= 0n) throw new AgentApiError("invalid_amount", undefined, 400);
    const cap = p.limits.per_transaction?.[req.origin_asset];
    if (cap !== undefined && amount > BigInt(cap)) throw new AgentApiError("policy_limit_exceeded");
    if (p.max_actions_per_hour !== null) {
      const since = this.clock.now() - 3_600_000;
      if (a.actionTimes.filter((t) => t > since).length >= p.max_actions_per_hour)
        throw new AgentApiError("policy_action_limit_exceeded", undefined, 429);
    }
    if ((a.balances.get(req.origin_asset) ?? 0n) < amount) throw new AgentApiError("insufficient_balance");
    const out = this.quoteOut(req);
    // Mock-only code: the real API's response to an unmet min_amount_out is not documented.
    if (req.min_amount_out !== undefined && out < BigInt(req.min_amount_out)) throw new AgentApiError("min_amount_out_not_met", undefined, 400);

    const op: Operation = {
      correlation_id: `op_mock_${++this.seq}`,
      status: "QUEUED",
      request: { asset: req.origin_asset, amount: req.amount, chain: "", recipient: "" },
      idempotencyKey: key,
      swap: { request: req },
    };
    a.actionTimes.push(this.clock.now());
    this.ops.set(op.correlation_id, op);
    this.byKey.set(`${agentId}:${key}`, { op, fingerprint });
    this.opAgent.set(op.correlation_id, agentId);
    // The policy delay applies to every money action except deposits, swaps included.
    if (p.timelock_ms > 0) op.execute_after = new Date(this.clock.now() + p.timelock_ms).toISOString();
    else this.execute(op, agentId);
    return { ...op };
  }

  /** Policy layers, in the order the real API reports them. */
  private validate(a: Agent, p: Policy, req: WithdrawRequest) {
    if (p.frozen) throw new AgentApiError("wallet_frozen");
    if (!p.actions.includes("withdraw")) throw new AgentApiError("policy_action_denied");
    if (p.assets !== "any" && !p.assets.includes(req.asset)) throw new AgentApiError("policy_denied");

    const listed = p.destinations.list.some(
      (d) =>
        d.action === "withdraw" &&
        d.chain === req.chain &&
        d.address === req.recipient &&
        (d.memo ?? null) === (req.memo ?? null),
    );
    if (p.destinations.mode === "only" ? !listed : listed) throw new AgentApiError("policy_destination_denied");

    const amount = BigInt(req.amount);
    if (amount <= 0n) throw new AgentApiError("invalid_amount", undefined, 400);
    const cap = p.limits.per_transaction?.[req.asset];
    if (cap !== undefined && amount > BigInt(cap)) throw new AgentApiError("policy_limit_exceeded");

    if (p.max_actions_per_hour !== null) {
      const since = this.clock.now() - 3_600_000;
      if (a.actionTimes.filter((t) => t > since).length >= p.max_actions_per_hour)
        throw new AgentApiError("policy_action_limit_exceeded", undefined, 429);
    }
    if ((a.balances.get(req.asset) ?? 0n) < amount) throw new AgentApiError("insufficient_balance");
  }

  private releaseDue() {
    for (const op of this.ops.values()) {
      if (op.status === "QUEUED" && Date.parse(op.execute_after!) <= this.clock.now()) {
        this.execute(op, this.opAgent.get(op.correlation_id)!);
      }
    }
  }

  /** Funds leave at release time (a queued op reserves nothing), so balance is re-checked. */
  private execute(op: Operation, agentId: string) {
    const a = this.agent(agentId);
    const have = a.balances.get(op.request.asset) ?? 0n;
    const amount = BigInt(op.request.amount);
    delete op.execute_after;
    if (have < amount) {
      op.status = "FAILED";
      op.failure_code = "insufficient_balance";
      return;
    }
    if (op.swap) {
      // Re-priced at release, like the real service: the fill follows the market, not the request time.
      const out = this.quoteOut(op.swap.request);
      const min = op.swap.request.min_amount_out;
      if (min !== undefined && out < BigInt(min)) {
        op.status = "FAILED";
        op.failure_code = "min_amount_out_not_met";
        return;
      }
      const dest = op.swap.request.destination_asset;
      a.balances.set(op.request.asset, have - amount);
      a.balances.set(dest, (a.balances.get(dest) ?? 0n) + out);
      op.swap.amountOut = out.toString();
      op.status = "SUCCESS";
      this.swaps.push({ ...op });
      return;
    }
    a.balances.set(op.request.asset, have - amount);
    op.status = "SUCCESS";
    this.settled.push({ ...op });
  }
}
