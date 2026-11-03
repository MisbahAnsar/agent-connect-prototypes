/** Deterministic price paths for the scenario harness. All pure; no I/O. */

/**
 * The default story: a steep run-up, a 40% drawdown, then flat. Used by the original repo's
 * trading replay (rally → bank → red day burns only house money).
 */
export function pricePath(upSteps = 24, downSteps = 12, tailSteps = 20, start = 1, peak = 4, dropPct = 0.4): number[] {
  const out: number[] = [];
  for (let i = 1; i <= upSteps; i++) out.push(start + ((peak - start) * i) / upSteps);
  for (let j = 1; j <= downSteps; j++) out.push(peak * Math.pow(1 - dropPct, j / downSteps));
  const last = out[out.length - 1]!;
  for (let k = 0; k < tailSteps; k++) out.push(last);
  return out;
}

/**
 * Rally, then two staggered drops of 35% each. A sell queued at the first drop (quote 2.6, min
 * fill 0.7× that with 3000 bps slippage) releases two steps later at 1.69 — below its
 * min_amount_out — so the swap fails instead of shortchanging the exit.
 */
export function staggeredCrashPath(upSteps = 12, peak = 4, drop = 0.35, tailSteps = 26): number[] {
  const out: number[] = [];
  for (let i = 1; i <= upSteps; i++) out.push(1 + ((peak - 1) * i) / upSteps);
  out.push(out[out.length - 1]! * (1 - drop));
  out.push(out[out.length - 1]! * (1 - drop));
  const last = out[out.length - 1]!;
  for (let k = 0; k < tailSteps; k++) out.push(last);
  return out;
}

/**
 * The default rally with a mild −10%-per-step dip right after the trigger: equity falls below 2x
 * while the cash is still being raised (swap queued, not released). The trigger must latch anyway.
 */
export function latchPath(upSteps = 24, peak = 4, dipSteps = 2, dip = 0.1, tailSteps = 24): number[] {
  const out: number[] = [];
  for (let i = 1; i <= upSteps; i++) out.push(1 + ((peak - 1) * i) / upSteps);
  for (let j = 1; j <= dipSteps; j++) out.push(out[out.length - 1]! * (1 - dip));
  const last = out[out.length - 1]!;
  for (let k = 0; k < tailSteps; k++) out.push(last);
  return out;
}
