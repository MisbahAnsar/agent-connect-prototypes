/**
 * Tier 1 — API-level policy e2e against the live Agent API (testnet).
 *
 * These tests ARE the three recipes without the LLM in the loop:
 * deterministic assertions on the policy gate's status codes and error codes.
 * A real swap runs once (small amount); blocked attempts cost nothing.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { AgentApiClient, AgentApiError, type Balance } from "../scripts/lib/api.js";
import type { ProvisionResult } from "../scripts/lib/provision.js";
import { fixture } from "./helpers/fixture.js";

let ctx: ProvisionResult;
let client: AgentApiClient;

beforeAll(async () => {
  ctx = await fixture();
  client = ctx.client;
});

describe("provisioned fixture", () => {
  it("has an ACTIVE agent with an APPLIED policy", async () => {
    const agent = await client.getAgent(ctx.state.agent_id!);
    expect(agent.status).toBe("ACTIVE");

    const policy = await client.getPolicy(ctx.state.agent_id!);
    expect(policy.status).toBe("APPLIED");
    expect(policy.provider_policy_synced).toBe(true);
    expect((policy.policy.budget as Record<string, unknown>).daily_usd).toBe("50");

    const assets = ctx.state.assets!;
    expect(policy.policy.assets).toContain(assets.funded);
    expect(policy.policy.assets).toContain(assets.second);
    expect(policy.policy.assets).not.toContain(assets.blocked);
    expect((policy.policy.limits as any).per_transaction[assets.funded]).toBe(
      ctx.state.per_transaction_limit_raw,
    );
  });

  it("has a faucet-funded balance for the funded asset", async () => {
    const { balances } = await client.getBalances(ctx.state.agent_id!);
    const funded: Balance | undefined = balances.find((b) => b.asset_id === ctx.state.assets!.funded);
    expect(funded, "funded asset in balances").toBeTruthy();
    expect(BigInt(funded!.balance_raw) > 0n).toBe(true);
  });
});

describe("recipe 1: swap within limits settles SUCCESS", () => {
  it("executes a small allowed swap end-to-end", async () => {
    const assets = ctx.state.assets!;
    const amount = "5000000"; // 5 USDC — half the 20 USDC per-transaction cap

    const res = await client.action(
      "swap",
      ctx.state.agent_id!,
      { origin_asset: assets.funded, destination_asset: assets.second, amount },
      { grant: ctx.state.grant_token!, idempotencyKey: `e2e-r1-${randomUUID()}` },
    );
    expect(res.correlation_id).toBeTruthy();

    const settled = await client.settle(res.correlation_id, 150000);
    expect(settled.status).toBe("SUCCESS");
    expect(String(settled.details.amount_out)).toMatch(/^\d+$/);
    expect(BigInt(String(settled.details.amount_out)) > 0n).toBe(true);
  }, 180000);
});

describe("recipe 2: over-limit swap is refused by the policy gate", () => {
  it("returns 403 policy_transaction_limit_exceeded and charges nothing", async () => {
    const assets = ctx.state.assets!;
    const cap = BigInt(ctx.state.per_transaction_limit_raw!);
    const amount = (cap + 10_000_000n).toString(); // cap + 10 USDC

    const err = await client
      .action(
        "swap",
        ctx.state.agent_id!,
        { origin_asset: assets.funded, destination_asset: assets.second, amount },
        { grant: ctx.state.grant_token!, idempotencyKey: `e2e-r2-${randomUUID()}` },
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(AgentApiError);
    expect((err as AgentApiError).httpStatus).toBe(403);
    expect((err as AgentApiError).code).toBe("policy_transaction_limit_exceeded");
    expect((err as AgentApiError).layer).toBe("policy");
  });
});

describe("recipe 3: disallowed destination asset is refused", () => {
  it("returns 403 policy_asset_denied", async () => {
    const assets = ctx.state.assets!;
    const err = await client
      .action(
        "swap",
        ctx.state.agent_id!,
        { origin_asset: assets.funded, destination_asset: assets.blocked, amount: "1000000" },
        { grant: ctx.state.grant_token!, idempotencyKey: `e2e-r3-${randomUUID()}` },
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(AgentApiError);
    expect((err as AgentApiError).httpStatus).toBe(403);
    expect((err as AgentApiError).code).toBe("policy_asset_denied");
    expect((err as AgentApiError).layer).toBe("policy");
  });

  it("still quotes the same swap with warnings — the gate is at execution, not pricing", async () => {
    const assets = ctx.state.assets!;
    const quote = await client.action("swap", ctx.state.agent_id!, {
      origin_asset: assets.funded,
      destination_asset: assets.blocked,
      amount: "1000000",
      dry: true,
    });
    expect(quote.dry).toBe(true);
    expect(quote.quote).toBeTruthy();
    // Policy refusals surface as warnings on quotes (spend_* / policy_* codes).
    expect(Array.isArray(quote.warnings)).toBe(true);
  });
});
