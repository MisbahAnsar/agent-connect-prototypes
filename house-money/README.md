# House Money — a trading use case for the NEAR Intents Agent API

The simple wrapper for trading strategies: **deposit → run your strategy → repeat**, with
policy-enforced principal protection on top. An agent trades with an owner's stake; the moment
gains cover the stake, the stake withdraws itself to a safe address, exactly once. Everything
after that is house money — the worst case is already banked, and no later prompt, market crash
or compromised strategy can reach it.

Extracted from the internal *House Money* experiment (Experiment 18), stripped of its UI and
simulation layers. Runs against the real Agent API: **Tidepool testnet by default** (free,
tokens have no value), mainnet via a one-line switch.

## The loop

```
runTradingLoop({
  strategy: myStrategy,          // ← the only thing you write
  stakeAsset, riskAsset,         // the pair (e.g. USDC / wETH)
  house: { ... },                // optional: bank the principal once gains cover it
})
```

Every tick the wrapper prices the portfolio (fail-closed: a missing or stale price halts the
tick), asks your strategy which side of the pair to hold, then quotes, guards slippage, sizes
the swap and submits it under the grant. With `house`, the runner additionally withdraws exactly
the principal to the safe address — the policy's only allowed destination — under a fixed
idempotency key, exactly once, through a timelocked veto window.

## Writing a strategy

Implement one method — pure decision, handled execution (`src/strategy/types.ts`):

```ts
class MyStrategy implements Strategy {
  decide(ctx: StrategyContext): StrategyTarget {
    // ctx.price(riskAsset), ctx.equityMicroUsd, ctx.balances, ctx.tokens
    return ctx.price(ctx.riskAsset) > ctx.price(ctx.stakeAsset) ? "risk" : "stable";
  }
}
```

`TrendStrategy` (EMA + dead band) is the reference implementation; `recipes/03_my_strategy.ts`
is a copy-me template.

## Quickstart

```sh
npm install
cp .env.example .env      # tidepool defaults; set HOUSE_SAFE_ADDRESS to anything you control
npm run provision         # mints a free key + creates the agent + prints the deposit address
# send the (valueless) stake to the printed address
npm run recipe:1          # trend trading loop
npm run recipe:2          # + the principal exit (the whole story)
npm run recipe:3          # your own strategy
npm run recipe:4          # live chaos probes (refusals, idempotency, veto)
```

### Switching to mainnet

In `.env`: `NETWORK=mainnet`, a real `AGENT_API_KEY` (naa_…, partner dashboard), a dedicated
low-value `OWNER_ACCOUNT_ID` / `OWNER_PRIVATE_KEY`, and `HOUSE_SAFE_ADDRESS` on a chain you
trust. Mainnet money-moving recipes refuse to run without `HOUSE_CONFIRM=spend-real-funds`,
and the dry run prints the plan and policy first. Treat the demo deployment's "mainnet"
catalog as real funds.

## Edge-case testing

Two layers, one for each place financial edge cases actually live:

**Offline scenario harness** (`tests/`, vitest, CI-able). A steppable `TradingSimulation`
(`tests/harness/`) drives the real Trader + Runner over deterministic price paths against the
policy-enforcing fake — same classes the recipes run. Scenarios:

- rally → bank exactly once → the drawdown burns only house money (`happy-path.test.ts`)
- cash-first ordering, the reserve while the exit is queued, stale-price halts, flat markets
- the 9-check refusal matrix, pre-trigger / mid-flight / post-bank (`refusal-matrix.test.ts`)
- financial edge cases (`edge-cases.test.ts`): a crash stranding a queued sell below its
  `min_amount_out` (the exit waits instead of shortchanging), an exit that cannot settle at
  release (`insufficient_balance`, reported once), a lost state store replaying the same
  idempotency key (exactly one settlement), and the trigger latching through a dip below 2x

**Live chaos recipe** (`npm run recipe:4`). The same matrix against the real hosted API with a
funded agent: a dust round-trip swap, the refusal probes (transfer, wrong address/chain, unlisted
asset, over-cap), a small real withdrawal with idempotent replay + conflict, the owner-veto
cancel (mainnet only — Tidepool has no timelock), and optionally a revoked-grant lockout
(`CHAOS_REVOKE=1`). Every probe reports PASS/FAIL/WARN/SKIP; unmatched *inferred* error codes
are WARNs, everything else must match or the recipe exits non-zero.

## What the policy enforces

One signed policy is the entire discipline (`src/policy/policy.ts`):

| Rule | Enforced by |
|---|---|
| Withdraw only to the safe address | `destinations: { mode: "only" }` |
| At most the principal per withdrawal | `limits.per_transaction` |
| A veto window on money moves | `timelock_ms` |
| Only stake + risk assets | `assets` + `max_actions_per_hour` |

Refusals surface as `AgentApiError` codes (`policy_destination_denied`, `policy_limit_exceeded`,
…) — see `tests/` for the full matrix.

## Structure

```
src/
  agent-api/    real SDK client (owner intents, grant calls) + NEAR owner signer
  policy/       the house-money policy builder
  risk/         fail-closed micro-USD pricing + principal trigger
  strategy/     the Strategy seam, TrendStrategy, the Trader (quote → swap, cash-first)
  runner/       the principal exit (exactly-once, sealable), file store, event log
  loop.ts       runTradingLoop — the wrapper
  config.ts     .env + network switch       state.ts — provision state + owner wiring
scripts/        00_provision (agent + policy + grant + deposit address), 01_check (read-only)
recipes/        1 trend loop · 2 + principal exit · 3 your strategy (template) · 4 chaos probes
tests/          vitest: policy, pricing, trigger, runner, real client vs fake network,
                + scenario harness (price paths, refusal matrix, financial edge cases)
```

## Scripts

| Command | What it does |
|---|---|
| `npm run provision` | Mint key (tidepool), create agent, sign policy, issue grant, print deposit address |
| `npm run check` | Read-only: network status, token catalog, key/quota |
| `npm run recipe:1/2/3` | The trading use case, three ways |
| `npm run recipe:4` | Live chaos recipe: refusals + idempotency + veto on the real API |
| `npm test` / `npm run typecheck` | vitest suite (incl. scenario harness) / strict typecheck |

## Notes & limitations

- Deployment differences handled for you: tidepool mints free keys, reports balances only from
  the `intents` source, and **rejects `timelock_ms`** (the veto window is a mainnet feature —
  provision enforces 0 there). Owner intents sign locally with an ed25519 NEAR key; on tidepool
  provisioning generates a throwaway implicit key (nothing to fund), on mainnet use a dedicated,
  low-value account and never commit its key.
- Grants expire (24h); re-run `npm run provision` to re-issue — it re-uses the same agent and tenant.
- The trend strategy has only ever seen scripted price paths; size `HOUSE_TIMELOCK_MS` to the
  market's move over that window or swaps fail their min-output check (swaps are re-priced when
  the timelock releases them).
- Exactly-once for the principal exit is enforced by the runner unless `HOUSE_SEAL=1`, which
  drops `withdraw` from the policy after settlement (subject to the API's 10-minute edit cooldown).
