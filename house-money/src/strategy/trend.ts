/**
 * Trend following on one risk asset against the stake asset: hold the risk asset while its price is
 * above its moving average, hold the stake asset while it is below. Pure; no I/O.
 */
import type { Strategy, StrategyContext, StrategyTarget } from "./types";

export type TrendConfig = {
  /** EMA smoothing, 0 < alpha <= 1. Higher reacts faster. */
  alpha?: number;
  /** Dead band around the EMA, so noise does not flip the position. */
  band?: number;
};

export type Target = StrategyTarget;

export class TrendStrategy implements Strategy {
  private ema: number | null = null;
  private target: Target = "stable";
  private readonly alpha: number;
  private readonly band: number;

  constructor(cfg: TrendConfig = {}) {
    this.alpha = cfg.alpha ?? 0.3;
    this.band = cfg.band ?? 0.01;
  }

  /** Feed one price. Returns the position the strategy wants to hold now. */
  update(price: number): Target {
    if (!(price > 0)) return this.target; // never move on a bad price
    this.ema = this.ema === null ? price : this.ema + this.alpha * (price - this.ema);
    if (price > this.ema * (1 + this.band)) this.target = "risk";
    else if (price < this.ema * (1 - this.band)) this.target = "stable";
    return this.target;
  }

  /** The Strategy seam: decide from the tick's context (only the risk price matters here). */
  decide(ctx: StrategyContext): StrategyTarget {
    return this.update(ctx.price(ctx.riskAsset));
  }

  get average() {
    return this.ema;
  }
}
