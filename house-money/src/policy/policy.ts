import type { Policy } from "./types";

export type HouseMoneyPolicyInput = {
  /** Asset id from GET /v1/tokens. */
  asset: string;
  /** Exactly the owner's stake, in atomic units. */
  principalAtomic: bigint;
  chain: string;
  safeAddress: string;
  /** Veto window on the principal exit. Production: 3_600_000 (1h). */
  timelockMs?: number;
  /**
   * Let the agent trade: adds `swap` and the risk assets. The timelock then delays every swap as well as
   * the exit, so keep it short while trading. Withdraw stays pinned to the safe account.
   */
  trading?: {
    /** Assets the agent may hold besides the stake, with their per-transaction caps (atomic). */
    assets: Record<string, string>;
    maxActionsPerHour?: number;
  };
};

export const DEFAULT_TIMELOCK_MS = 3_600_000;

/** The house-money rule: one destination, one size, one veto window. */
export function buildHouseMoneyPolicy(input: HouseMoneyPolicyInput): Policy {
  if (input.principalAtomic <= 0n) throw new Error("principalAtomic must be positive");
  if (!input.safeAddress) throw new Error("safeAddress required");
  const trading = input.trading;
  return {
    frozen: false,
    actions: trading ? ["withdraw", "swap"] : ["withdraw"],
    confidential: false,
    owner_approval: false,
    assets: [input.asset, ...Object.keys(trading?.assets ?? {})],
    limits: { per_transaction: { [input.asset]: input.principalAtomic.toString(), ...(trading?.assets ?? {}) } },
    max_actions_per_hour: trading ? (trading.maxActionsPerHour ?? 30) : 5,
    destinations: {
      mode: "only",
      list: [{ action: "withdraw", chain: input.chain, address: input.safeAddress, memo: null }],
    },
    budget: { daily_usd: null, weekly_usd: null, monthly_usd: null },
    timelock_ms: input.timelockMs ?? DEFAULT_TIMELOCK_MS,
  };
}

/**
 * The same policy with `withdraw` removed. Applied after the principal has settled, it turns
 * "exactly once" from a runner convention into a policy fact: no grant, old or new, can withdraw again.
 */
export function buildSealedPolicy(policy: Policy): Policy {
  return { ...policy, actions: policy.actions.filter((a) => a !== "withdraw") };
}
