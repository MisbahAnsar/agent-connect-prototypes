import assert from "node:assert/strict";
import { test } from "vitest";
import { TrendStrategy } from "../src/strategy/trend";

test("starts on the stake asset and follows a rising price into the risk asset", () => {
  const s = new TrendStrategy({ alpha: 0.3, band: 0.01 });
  assert.equal(s.update(1), "stable");
  assert.equal(s.update(1.3), "risk");
  assert.equal(s.update(1.7), "risk");
});

test("leaves the risk asset when the price falls below its average", () => {
  const s = new TrendStrategy();
  for (const p of [1, 1.5, 2, 2.5]) s.update(p);
  assert.equal(s.update(1.2), "stable");
});

test("a move inside the dead band does not flip the position", () => {
  const s = new TrendStrategy({ alpha: 0.3, band: 0.05 });
  s.update(1);
  s.update(1.5); // risk
  assert.equal(s.update(s.average! * 0.99), "risk");
});

test("a bad price never moves the position", () => {
  const s = new TrendStrategy();
  s.update(1);
  s.update(2);
  assert.equal(s.update(Number.NaN), "risk");
  assert.equal(s.update(-3), "risk");
  assert.equal(s.update(0), "risk");
});
