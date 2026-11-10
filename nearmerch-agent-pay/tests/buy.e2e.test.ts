/** The whole recipe offline: fake nearmerch (#258 behaviour) + fake Ping + fake Agent Connect. */
import { describe, expect, it } from "vitest";
import { buyWithAgentConnect, SpendGuardError } from "../src/buy";
import { world } from "./fakes/world";

async function run(w: ReturnType<typeof world>, confirm = true) {
  const stages: string[] = [];
  const logs: string[] = [];
  await w.mcp.connect();
  const result = await buyWithAgentConnect(
    { merchant: w.merchant, mcp: w.mcp, sleep: w.noSleep, pollMs: 0, log: (m) => logs.push(m), checkpoint: (s) => stages.push(s), settle: { delayMs: 0 } },
    w.cfg,
    { confirm },
  );
  return { result, stages, logs };
}

describe("buy a t-shirt with Agent Connect via Ping Agent Pay", () => {
  it("happy path: one order, one withdraw, deposit covers amountIn, settled on near:mainnet", async () => {
    const w = world({ ping: { pendingSettles: 1 } });
    const { result, stages, logs } = await run(w);
    expect(result).toMatchObject({ product: "NEAR Logo T-Shirt", variant: "NEAR Logo T-Shirt / M", totalUsd: 28.81, orderStatus: "paid", settlementNetwork: "near:mainnet" });
    expect(stages).toEqual(["order_created", "quoted", "withdraw_submitted", "deposited", "paid"]);
    expect(w.store.orders.size).toBe(1);
    expect(w.ac.count("withdraw")).toBe(1);
    expect(w.base.delivered(result.depositAddress)).toBeGreaterThanOrEqual(BigInt(result.amountIn));
    expect(w.ac.calls.find((c) => c.tool === "withdraw")?.args).toMatchObject({ chain: "base", to: result.depositAddress, idempotency_key: `nearmerch:${result.orderId}:${result.depositAddress}` });
    expect(logs.join("\n")).toContain("settle   attempt 1: pending");
    // the AGENT_CONNECT_KEY and NEAR key never reach logs
    expect(logs.join("\n")).not.toContain(w.cfg.agentConnectKey);
    expect(logs.join("\n")).not.toContain(w.cfg.nearPrivateKey);
  });

  it("signs in with the agent's own NEAR key through near_sign_message", async () => {
    const w = world({ env: { NEARMERCH_SIGNER: "agent-connect", NEAR_PRIVATE_KEY: "", NEAR_ACCOUNT_ID: "" } });
    const { result } = await run(w);
    expect(result.orderStatus).toBe("paid");
    expect(w.store.signIns[0]).toMatchObject({ accountId: "a".repeat(64), publicKey: w.ac.nearPublicKey });
  });

  it("without confirm: makes no request at all", async () => {
    const w = world();
    await expect(run(w, false)).rejects.toBeInstanceOf(SpendGuardError);
    expect(w.calls.filter((c) => c.includes("store.test"))).toEqual([]);
    expect(w.ac.calls).toEqual([]);
  });

  it("MAX_USDC below the quote: refuses before sign-in/checkout", async () => {
    const w = world({ env: { MAX_USDC: "20" } });
    await expect(run(w)).rejects.toThrow(/above MAX_USDC=20/);
    expect(w.store.orders.size).toBe(0);
    expect(w.ac.count("withdraw")).toBe(0);
  });

  it("quoted amountIn above the cap: no withdraw", async () => {
    const w = world({ env: { MAX_USDC: "29" }, ping: { amountInBps: 10_200 } });
    await expect(run(w)).rejects.toThrow(/quoted amountIn .* above MAX_USDC/);
    expect(w.ac.count("withdraw")).toBe(0);
  });

  it("not enough USDC in the Agent Connect account: refuses before checkout", async () => {
    const w = world({ ac: { balance: 10_000_000n } });
    await expect(run(w)).rejects.toThrow(/not enough USDC/);
    expect(w.store.orders.size).toBe(0);
  });

  it("a policy that would refuse the withdraw stops at the preview", async () => {
    const w = world({ ac: { previewWarnings: [{ code: "spend_budget_exceeded" }] } });
    await expect(run(w)).rejects.toThrow(/spend_budget_exceeded/);
    expect(w.ac.count("withdraw")).toBe(0);
  });

  it("store without near-intents entries: clear error, no quote, no withdraw", async () => {
    const w = world({ store: { intentsEnabled: false } });
    await expect(run(w)).rejects.toThrow(/Is X402 intents enabled/);
    expect(w.ping.verifyCalls).toBe(0);
    expect(w.ac.count("withdraw")).toBe(0);
  });

  it("missing REFUND_ADDRESS or shipping: refuses up front", async () => {
    await expect(run(world({ env: { REFUND_ADDRESS: "" } }))).rejects.toThrow(/REFUND_ADDRESS/);
    await expect(run(world({ env: { SHIP_EMAIL: "" } }))).rejects.toThrow(/SHIP_EMAIL/);
  });

  it("terminal settle failure after the deposit is reported, never re-paid", async () => {
    const w = world({ ping: { terminalFailure: true } });
    await expect(run(w)).rejects.toMatchObject({ reason: "exact_near_intents_payment_failed" });
    expect(w.ac.count("withdraw")).toBe(1);
    expect([...w.store.orders.values()][0]?.status).toBe("payment_failed");
  });
});
