export interface DemoPolicyInput {
  ownerAccountId: string;
  /** Asset ids Hermes may hold or trade (e.g. [fundedUsdc, wnear]). */
  allowedAssets: string[];
  /** The asset the per-transaction cap applies to (the faucet-funded one). */
  fundedAsset: string;
  /** Atomic units, as string (USDC has 6 decimals → "20000000" = 20 USDC). */
  perTransactionLimit: string;
  /** Whole US dollars per day across all assets. */
  dailyUsd: string;
}

/**
 * The demo policy, mirroring the shape the owner signs at agent_create:
 * - swap/transfer/withdraw only (deposits are always allowed)
 * - only whitelisted assets; a hard per-transaction cap on the funded asset
 * - a daily USD budget across everything
 * - transfers/withdrawals may only land back on the owner's account
 */
export function demoPolicy(input: DemoPolicyInput): Record<string, unknown> {
  return {
    frozen: false,
    actions: ["swap", "transfer", "withdraw"],
    confidential: false,
    owner_approval: false,
    assets: input.allowedAssets,
    limits: {
      per_transaction: {
        [input.fundedAsset]: input.perTransactionLimit,
      },
    },
    max_actions_per_hour: null,
    destinations: {
      mode: "only",
      list: [
        { action: "transfer", address: input.ownerAccountId, confidential: false },
        { action: "withdraw", chain: "near", address: input.ownerAccountId, memo: null },
      ],
    },
    budget: {
      daily_usd: input.dailyUsd,
      weekly_usd: null,
      monthly_usd: null,
    },
    timelock_ms: 0,
  };
}
