import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { PriceUnavailableError } from "../src/errors";
import type { TokenInfo } from "../src/policy/types";
import { portfolioValueMicroUsd, usdToMicro } from "../src/risk/pricing";

const USDC = "nep141:usdc-test";
const NOW = new Date("2026-10-19T12:00:00Z");
const token = (over: Partial<TokenInfo> = {}): TokenInfo => ({
  asset_id: USDC,
  symbol: "USDC",
  decimals: 6,
  blockchain: "near",
  price: 1,
  price_updated_at: "2026-10-19T11:55:00Z",
  price_expires_at: "2026-10-19T12:05:00Z",
  ...over,
});

describe("usdToMicro", () => {
  it("converts without float drift", () => {
    assert.equal(usdToMicro(0.999785), 999_785n);
    assert.equal(usdToMicro("12.5"), 12_500_000n);
    assert.equal(usdToMicro(1), 1_000_000n);
  });
});

describe("portfolioValueMicroUsd", () => {
  it("prices balances by decimals", () => {
    assert.equal(portfolioValueMicroUsd({ [USDC]: "2500000" }, [token({ price: 0.999785 })], NOW), 2_499_462n);
  });
  it("ignores zero balances even if unpriced", () => {
    assert.equal(portfolioValueMicroUsd({ other: "0" }, [], NOW), 0n);
  });
  it("fails closed on a stale price", () => {
    assert.throws(
      () => portfolioValueMicroUsd({ [USDC]: "1" }, [token({ price_expires_at: "2026-10-19T11:59:59Z" })], NOW),
      (e) => e instanceof PriceUnavailableError && e.code === "spend_price_unavailable",
    );
  });
  it("fails closed on a missing or null price", () => {
    assert.throws(() => portfolioValueMicroUsd({ x: "1" }, [], NOW), PriceUnavailableError);
    assert.throws(() => portfolioValueMicroUsd({ [USDC]: "1" }, [token({ price: null })], NOW), PriceUnavailableError);
  });
});
