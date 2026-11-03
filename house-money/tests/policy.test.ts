import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { buildHouseMoneyPolicy } from "../src/policy/policy";

const USDC = "nep141:usdc-test";

describe("buildHouseMoneyPolicy", () => {
  const policy = buildHouseMoneyPolicy({ asset: USDC, principalAtomic: 1000n, chain: "base", safeAddress: "0xsafe" });
  it("allows only withdraw, one asset, one destination", () => {
    assert.deepEqual(policy.actions, ["withdraw"]);
    assert.deepEqual(policy.assets, [USDC]);
    assert.equal(policy.destinations.mode, "only");
    assert.equal(policy.destinations.list.length, 1);
    assert.equal(policy.destinations.list[0]!.address, "0xsafe");
  });
  it("caps per-transaction at exactly the principal and defaults to a 1h timelock", () => {
    assert.equal(policy.limits.per_transaction![USDC], "1000");
    assert.equal(policy.timelock_ms, 3_600_000);
    assert.equal(policy.max_actions_per_hour, 5);
  });
  it("rejects a non-positive principal", () => {
    assert.throws(() => buildHouseMoneyPolicy({ asset: USDC, principalAtomic: 0n, chain: "base", safeAddress: "0x" }));
  });
});
