import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { principalKey, shouldBankPrincipal } from "../src/risk/trigger";

describe("shouldBankPrincipal", () => {
  const principal = 1_000_000n;
  it("is false just below 2x, true at exactly 2x and above", () => {
    assert.equal(shouldBankPrincipal({ equity: 1_999_999n, principal, banked: false }), false);
    assert.equal(shouldBankPrincipal({ equity: 2_000_000n, principal, banked: false }), true);
    assert.equal(shouldBankPrincipal({ equity: 5_000_000n, principal, banked: false }), true);
  });
  it("never fires once banked", () => {
    assert.equal(shouldBankPrincipal({ equity: 9_000_000n, principal, banked: true }), false);
  });
  it("supports a lower multiple for live low-funds spikes", () => {
    assert.equal(shouldBankPrincipal({ equity: 1_100_000n, principal, banked: false, multiple: 1n }), true);
  });
  it("uses a fixed key per agent, not per date", () => {
    assert.equal(principalKey("a1"), "principal:a1");
  });
  it("multipleBps allows a fractional trigger and wins over multiple", () => {
    assert.equal(shouldBankPrincipal({ equity: 1_020_000n, principal: 1_000_000n, banked: false, multipleBps: 10_200n }), true);
    assert.equal(shouldBankPrincipal({ equity: 1_019_999n, principal: 1_000_000n, banked: false, multipleBps: 10_200n }), false);
    assert.equal(shouldBankPrincipal({ equity: 1_020_000n, principal: 1_000_000n, banked: false, multiple: 2n, multipleBps: 10_200n }), true);
    assert.equal(shouldBankPrincipal({ equity: 2_000_000n, principal: 1_000_000n, banked: false }), true);
  });

});
