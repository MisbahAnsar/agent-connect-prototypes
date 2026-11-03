import { PriceUnavailableError } from "../errors";
import type { TokenInfo } from "../policy/types";

/** Which side of the stake/risk pair the position should sit in. */
export type StrategyTarget = "risk" | "stable";

/** Everything a strategy may look at for one decision. Prices fail closed: an unpriced asset throws. */
export type StrategyContext = {
  agentId: string;
  /** The stake asset (the cash side of the pair; what deposits arrive in). */
  stakeAsset: string;
  /** The asset the strategy may speculate in. */
  riskAsset: string;
  /** Atomic-unit balances keyed by asset id. */
  balances: Record<string, string>;
  /** Token catalog snapshot for this tick; prices may be null or stale. */
  tokens: TokenInfo[];
  /** USD price of one asset; throws `PriceUnavailableError` when missing or stale. */
  price(assetId: string): number;
  /** Whole portfolio in micro-USD (1e-6), fail-closed pricing. */
  equityMicroUsd: bigint;
};

/**
 * The plug-in seam: you decide, the wrapper executes. Return which asset the position should sit in
 * right now; the trader quotes, guards slippage, respects the policy and the principal exit for you.
 */
export interface Strategy {
  decide(ctx: StrategyContext): StrategyTarget | Promise<StrategyTarget>;
}

/** Fail-closed price lookup over one catalog snapshot (shared by the runner's context builder). */
export function makePriceFn(tokens: TokenInfo[], now: Date): (assetId: string) => number {
  const byId = new Map(tokens.map((t) => [t.asset_id, t]));
  return (assetId: string): number => {
    const token = byId.get(assetId);
    if (!token || token.price === null) throw new PriceUnavailableError(assetId, "missing");
    if (Date.parse(token.price_expires_at) <= now.getTime()) throw new PriceUnavailableError(assetId, "stale");
    return token.price;
  };
}
