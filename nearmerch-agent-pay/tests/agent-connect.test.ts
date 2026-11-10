import { describe, expect, it } from "vitest";
import { sign, parseAuthToken } from "near-sign-verify";
import {
  AgentConnectMcp,
  agentConnectNep413Wallet,
  availableBalance,
  destinationTxHash,
  grossUpWithdraw,
  resolveAccount,
  submitWithdraw,
  waitForOperation,
} from "../src/agent-connect";
import { NEAR_USDC_TOKEN } from "../src/config";
import { AC_KEY, MCP } from "./fakes/fake-agent-connect";
import { world } from "./fakes/world";

const TO = "0x00000000000000000000000000000000000000d1";

describe("MCP transport", () => {
  it("initialises a session and reads JSON and SSE replies", async () => {
    for (const sse of [false, true]) {
      const w = world({ ac: { sse } });
      await w.mcp.connect();
      expect((await resolveAccount(w.mcp)).name).toBe("Checking");
      expect(await availableBalance(w.mcp, "Checking", NEAR_USDC_TOKEN)).toBe(100_000_000n);
      expect((await w.mcp.listTools()).map((t) => t.name)).toContain("near_sign_message");
    }
  });

  it("a bad key fails with a hint and never echoes the key", async () => {
    const w = world();
    const bad = new AgentConnectMcp({ url: MCP, bearer: "wrong-key", fetchImpl: w.fetchImpl });
    const err = await bad.connect().catch((e: Error) => e);
    expect(String(err)).toMatch(/401/);
    expect(String(err)).not.toContain("wrong-key");
    expect(String(err)).not.toContain(AC_KEY);
  });

  it("tool errors carry the Agent Connect code and layer", async () => {
    const w = world({ ac: { failWithdraw: true } });
    await w.mcp.connect();
    await expect(submitWithdraw(w.mcp, { account: "Checking", token: NEAR_USDC_TOKEN, amount: 1n, chain: "base", to: TO, idempotencyKey: "k" })).rejects.toMatchObject({
      code: "policy_destination_denied",
      layer: "policy",
    });
  });
});

describe("gross-up + withdraw", () => {
  it("grosses up until Base amount_out covers amountIn", async () => {
    const w = world({ ac: { feeBps: 100n, fixedFee: 20_000n } });
    await w.mcp.connect();
    const g = await grossUpWithdraw(w.mcp, { account: "Checking", token: NEAR_USDC_TOKEN, chain: "base", to: TO, requiredOut: 29_242_150n, maxPreviews: 3 });
    expect(g.previewsUsed).toBe(2);
    expect(g.amountOut).toBeGreaterThanOrEqual(29_242_150n);
    expect(w.ac.count("withdraw_preview")).toBe(2);
  });

  it("refuses when the preview warns the real withdraw would be refused", async () => {
    const w = world({ ac: { previewWarnings: [{ code: "policy_destination_denied", message: "destinations: only" }] } });
    await w.mcp.connect();
    await expect(grossUpWithdraw(w.mcp, { account: "Checking", token: NEAR_USDC_TOKEN, chain: "base", to: TO, requiredOut: 1_000_000n, maxPreviews: 3 })).rejects.toThrow(/policy_destination_denied/);
  });

  it("caps previews", async () => {
    const w = world({ ac: { feeBps: 100n } });
    await w.mcp.connect();
    await expect(grossUpWithdraw(w.mcp, { account: "Checking", token: NEAR_USDC_TOKEN, chain: "base", to: TO, requiredOut: 1_000_000n, maxPreviews: 1 })).rejects.toThrow(/after 1 previews/);
  });

  it("replays a withdraw by idempotency key and rejects changed params", async () => {
    const w = world();
    await w.mcp.connect();
    const args = { account: "Checking", token: NEAR_USDC_TOKEN, amount: 5_000_000n, chain: "base", to: TO, idempotencyKey: "nearmerch:o1:0xd1" };
    const a = await submitWithdraw(w.mcp, args);
    const b = await submitWithdraw(w.mcp, args);
    expect(b.operation_id).toBe(a.operation_id);
    expect(w.ac.balance).toBe(95_000_000n);
    await expect(submitWithdraw(w.mcp, { ...args, amount: 6_000_000n })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("polls through UNCERTAIN (refresh_operation) to the Base tx hash", async () => {
    const w = world({ ac: { uncertainOnce: true, pollsUntilSuccess: 3 } });
    await w.mcp.connect();
    const op = await submitWithdraw(w.mcp, { account: "Checking", token: NEAR_USDC_TOKEN, amount: 5_000_000n, chain: "base", to: TO, idempotencyKey: "k1" });
    const done = await waitForOperation(w.mcp, op.operation_id!, { sleep: w.noSleep });
    expect(destinationTxHash(done)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(w.ac.count("refresh_operation")).toBe(1);
    expect(w.base.delivered(TO)).toBe(4_930_000n);
  });

  it("rejects a missing or malformed destination tx hash", () => {
    expect(() => destinationTxHash({ operation_id: "x", details: {} })).toThrow(/no Base destination_tx_hash/);
    expect(() => destinationTxHash({ operation_id: "x", details: { evidence: { destination_tx_hash: "0x12" } } })).toThrow();
  });
});

describe("NEP-413 via near_sign_message", () => {
  it("adapts the tool to a near-sign-verify wallet for near-merch-store.near", async () => {
    const w = world();
    await w.mcp.connect();
    const token = await sign("Sign in to NEAR Merch Store", { signer: agentConnectNep413Wallet(w.mcp, "Checking"), recipient: "near-merch-store.near" });
    const data = parseAuthToken(token);
    expect(data).toMatchObject({ accountId: "a".repeat(64), publicKey: w.ac.nearPublicKey, recipient: "near-merch-store.near" });
    expect(w.ac.calls.find((c) => c.tool === "near_sign_message")?.args).toMatchObject({ account: "Checking", recipient: "near-merch-store.near" });
  });
});
