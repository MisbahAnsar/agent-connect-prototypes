import type { Balances, Policy, TokenInfo, WithdrawRequest } from "../policy/types";

export type OpStatus = "QUEUED" | "PROCESSING" | "SUCCESS" | "FAILED" | "CANCELLED";

export type SwapRequest = {
  origin_asset: string;
  destination_asset: string;
  amount: string;
  /** Refuse a fill worse than this (atomic units of the destination asset). */
  min_amount_out?: string;
};

export type Operation = {
  correlation_id: string;
  status: OpStatus;
  failure_code?: string;
  /** Present while QUEUED: when the timelock releases. */
  execute_after?: string;
  request: WithdrawRequest;
  idempotencyKey: string;
  /** Present on swaps. `amountOut` is known once the swap has run. */
  swap?: { request: SwapRequest; amountOut?: string };
};

/** Agent-side surface: what a grant holder can do. */
export interface GrantClient {
  getBalances(agentId: string): Promise<{ balances: Balances }>;
  withdraw(agentId: string, req: WithdrawRequest, opts: { idempotencyKey: string }): Promise<Operation>;
  /** Dry-run quote: expected output in the destination asset's atomic units. Moves nothing. */
  quote(agentId: string, req: SwapRequest): Promise<{ amountOut: string }>;
  /** Timelocked like every money action except deposits: it may return QUEUED and run later. */
  swap(agentId: string, req: SwapRequest, opts: { idempotencyKey: string }): Promise<Operation>;
  /** Present so the simulation can show it refused when the policy omits "transfer". */
  transfer(agentId: string, req: { asset: string; amount: string; recipient: string }): Promise<Operation>;
}

/** Backend/owner surface (owner signatures are abstracted away in the mock). */
export interface AgentClient {
  getTokens(): Promise<TokenInfo[]>;
  getPolicy(agentId: string): Promise<{ policy: Policy | null; revision: number | null }>;
  /** Owner-signed policy_update; `expectedRevision` guards against concurrent edits. */
  updatePolicy(agentId: string, policy: Policy, expectedRevision: number): Promise<{ revision: number }>;
  /** Owner-signed grant_issue; returns the bearer token. */
  issueGrant(agentId: string, label: string, expiresAt: Date): Promise<{ token: string }>;
  revokeGrant(agentId: string, token: string): Promise<void>;
  forGrant(token: string): GrantClient;
  getStatus(correlationId: string): Promise<Operation>;
  listScheduledExecutions(agentId: string): Promise<Operation[]>;
  /** Owner-signed execution_cancel. */
  cancelExecution(agentId: string, correlationId: string): Promise<Operation>;
}
