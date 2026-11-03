import { PriceUnavailableError } from "../errors";
import type { Balances, TokenInfo } from "../policy/types";

/** USD amounts are carried as micro-USD (1e-6) bigints to avoid float drift. */
export const MICRO = 1_000_000n;

export function usdToMicro(usd: number | string): bigint {
  const [whole = "0", frac = ""] = (typeof usd === "number" ? usd.toFixed(6) : usd).split(".");
  return BigInt(whole) * MICRO + BigInt((frac + "000000").slice(0, 6));
}

/**
 * Portfolio value in micro-USD. Fails closed: any non-zero balance whose price is
 * missing or past `price_expires_at` throws, so a trigger never fires on unpriced equity.
 */
export function portfolioValueMicroUsd(
  balances: Balances,
  tokens: TokenInfo[],
  now: Date = new Date(),
): bigint {
  const byId = new Map(tokens.map((t) => [t.asset_id, t]));
  let total = 0n;
  for (const [assetId, raw] of Object.entries(balances)) {
    const amount = BigInt(raw);
    if (amount === 0n) continue;
    const token = byId.get(assetId);
    if (!token || token.price === null) throw new PriceUnavailableError(assetId, "missing");
    if (Date.parse(token.price_expires_at) <= now.getTime())
      throw new PriceUnavailableError(assetId, "stale");
    total += (amount * usdToMicro(token.price)) / 10n ** BigInt(token.decimals);
  }
  return total;
}
