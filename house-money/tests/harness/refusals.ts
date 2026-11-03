import { AgentApiError } from "../../src/errors";
import { principalKey } from "../../src/risk/trigger";
import { TRADE_AGENT, TRADE_SAFE, TRADE_RISK, TRADE_STABLE, type TradingSimulation } from "./trading-simulation";

export type RefusalCheck = {
  id: string;
  label: string;
  /** Error code the policy must answer with, or "replay" when the same operation must come back. */
  expected: string;
  got: string;
  pass: boolean;
};

type Attempt = () => Promise<unknown>;

async function code(fn: Attempt): Promise<string> {
  try {
    await fn();
    return "allowed";
  } catch (e) {
    return e instanceof AgentApiError ? e.code : `unexpected: ${String(e)}`;
  }
}

/** The rate probes burn budget 1 atom at a time, so they need an asset the agent actually holds. */
export async function pickRateAsset(s: TradingSimulation): Promise<string> {
  const { balances } = await s.grant.getBalances(TRADE_AGENT);
  return BigInt(balances[TRADE_STABLE] ?? "0") > 0n ? TRADE_STABLE : TRADE_RISK;
}

/**
 * The refusal matrix, run against whatever state the simulation is in. Order matters: the
 * rate-limit probe goes last because it consumes the agent's hourly action budget (its probes
 * are 1-atom withdrawals to the safe account, which the policy permits).
 */
export async function runRefusalMatrix(s: TradingSimulation): Promise<RefusalCheck[]> {
  const g = s.grant;
  const P = s.principalAtomic;
  const out: RefusalCheck[] = [];
  const check = (id: string, label: string, expected: string, got: string) =>
    out.push({ id, label, expected, got, pass: expected === got });

  const withdraw = (over: Partial<{ amount: string; chain: string; recipient: string; asset: string; memo: string | null }>, key: string) =>
    g.withdraw(
      TRADE_AGENT,
      { asset: TRADE_STABLE, amount: P.toString(), chain: "base", recipient: TRADE_SAFE, ...over },
      { idempotencyKey: key },
    );

  check("reverse", "“Give me my money back” (transfer out)", "policy_action_denied",
    await code(() => g.transfer(TRADE_AGENT, { asset: TRADE_STABLE, amount: "1", recipient: "owner.near" })));

  check("other-address", "Withdraw to another address", "policy_destination_denied",
    await code(() => withdraw({ recipient: "0xattacker" }, "m-addr")));

  check("other-chain", "Withdraw to the safe address on another chain", "policy_destination_denied",
    await code(() => withdraw({ chain: "near" }, "m-chain")));

  check("memo", "Withdraw with an unlisted memo", "policy_destination_denied",
    await code(() => withdraw({ memo: "sneaky" }, "m-memo")));

  check("other-asset", "Withdraw an asset outside the allowlist", "policy_denied",
    await code(() => withdraw({ asset: "nep141:other" }, "m-asset")));

  check("over-cap", "Withdraw principal + 1", "policy_limit_exceeded",
    await code(() => withdraw({ amount: (P + 1n).toString() }, "m-cap")));

  // Only meaningful once the exit exists; the runner's persisted state holds its operation id.
  const original = (await s.store.load()).withdrawalId;
  if (original) {
    let replayed: string;
    try {
      replayed = (await withdraw({}, principalKey(TRADE_AGENT))).correlation_id === original ? "replay" : "new-operation";
    } catch (e) {
      replayed = e instanceof AgentApiError ? e.code : String(e);
    }
    check("replay", "Replay the principal exit (same key)", "replay", replayed);
  }

  const { token } = await s.api.issueGrant(TRADE_AGENT, "matrix-revoked", new Date(s.api.clock.now() + 60_000));
  await s.api.revokeGrant(TRADE_AGENT, token);
  check("revoked", "Use a revoked grant", "agent_grant_required",
    await code(() => s.api.forGrant(token).getBalances(TRADE_AGENT)));

  const rateAsset = await pickRateAsset(s);
  let rate = "never-limited";
  for (let i = 0; i < 10; i++) {
    const r = await code(() => withdraw({ asset: rateAsset, amount: "1" }, `m-rate-${i}`));
    if (r === "policy_action_limit_exceeded") { rate = r; break; }
    if (r !== "allowed" && r !== "insufficient_balance") { rate = r; break; }
  }
  check("rate", "Exceed 5 actions in an hour", "policy_action_limit_exceeded", rate);

  return out;
}
