# Hermes Agent × NEAR Intents Agent API

A working prototype of **Hermes Agent** executing swaps through the **NEAR Intents
Agent API**, with authority split the way it should be:

- **Owner Authority** — a human (or their key) signs the *policy* and a *grant* once, up front.
- **Agent Execution** — Hermes holds only a scoped grant token (`ngt_…`) and calls the
  Agent API through MCP. It can never exceed the owner-signed policy, because the API
  is the attested policy engine — not Hermes.

The Agent API enforces the policy on every action: allowed actions and assets, a
per-transaction cap, a daily USD budget, and destinations funds may leave to.

```
        owner key (stays here, in .state/)          Hermes (LLM agent)
                │  signs policy + grant                    │  holds only ngt_… grant token
                ▼                                          ▼
        ┌────────────────────────────┐   MCP (stdio)   ┌──────────────┐
        │  NEAR Intents Agent API    │◄────────────────│  mcp-server/ │
        │  attested policy engine    │  REST + grant   └──────────────┘
        │  (Tidepool testnet / main) │
        └────────────────────────────┘
                     │ intents
                     ▼
              solver bus → settlement
```

## Repository layout

```
hermes/
├── .env.example                  # config template (AGENT_API_URL toggle, keys)
├── profile/                      # isolated HERMES_HOME for the demo
│   ├── config.yaml               # NEAR AI Cloud model + agent_api MCP server
│   └── SOUL.md                   # Hermes' system prompt / operating rules
├── mcp-server/index.ts           # MCP stdio bridge: tools → Agent API REST
├── scripts/
│   ├── 00_provision_grant.ts     # owner signs policy & mints the grant
│   └── lib/                      # API client, NEP-413 signing, policy, state
├── bin/hermes-run                # runs `hermes chat --oneshot` against profile/
├── recipes/
│   ├── hermes_client.ts          # headless Hermes client
│   ├── 01_swap_allowed.ts        # within-limits swap → SUCCESS
│   ├── 02_blocked_limit.ts       # over per-transaction cap → 403 policy_transaction_limit_exceeded
│   └── 03_blocked_asset.ts       # disallowed asset → 403 policy_asset_denied
└── tests/                        # real e2e against the live API (3 tiers)
```

## Quickstart

Prereqs: **Node ≥ 22** and **Docker** (for the agent sandbox). Recipes and the
full-agent tier run Hermes inside the **official `nousresearch/hermes-agent`
image** — nothing is installed on your machine.

```bash
npm install
npm run provision     # owner signs policy → agent wallet → grant → testnet faucet
npm run recipe:1      # allowed swap, settles SUCCESS
npm run recipe:2      # over the cap → policy_transaction_limit_exceeded
npm run recipe:3      # disallowed asset → policy_asset_denied
npm test              # e2e: tier 1 (API) + tier 2 (MCP); tier 3 (Hermes) if enabled
```

`npm run provision` writes `.env` and `profile/.env` (agent id, grant token, asset
ids) and caches state in `.state/` so re-runs reuse the same agent. `--force`
provisions a fresh one.

### Enable tier 3 (real Hermes)

Add your [NEAR AI Cloud](https://cloud.near.ai) key (`API Keys` page) to `hermes/.env`:

```bash
NEAR_AI_API_KEY=…
RUN_HERMES=1
```

Then:

```bash
npm run sandbox:pull          # docker pull nousresearch/hermes-agent (first time only)
npm run test:hermes           # the 3 recipes through the real agent
# or drive the agent directly:
npm run sandbox:chat -- "Swap 5 USDC to wNEAR"
```

Hermes runs inside the official image with our `profile/` mounted at
`/opt/data` (its `config.yaml` points at `https://cloud-api.near.ai/v1`,
model `zai-org/GLM-5.1-FP8`; `SOUL.md` carries the operating rules). Only
`dist/` and `node_modules/` are visible to the container — the owner key
(`.state/`) and repo secrets never enter the agent's filesystem.

**Backends** (`HERMES_BACKEND=auto|docker|host`): auto prefers docker and
falls back to a local `hermes` install (`HERMES_HOME=profile/`). A local
install works too, but Docker is the sanctioned zero-footprint path.

## The policy the owner signs

Defined in `scripts/lib/policy.ts`, signed at `agent_create`:

| Rule | Demo value |
|---|---|
| actions | `swap`, `transfer`, `withdraw` (deposits are always allowed) |
| assets | testnet USDC + wNEAR only |
| per-transaction limit | 20 USDC on the funded asset |
| budget | 50 USD/day across everything |
| destinations | only the owner's own account |

Recipes 2 and 3 breach the limit and asset rules; the API refuses them before
anything reaches the solver bus (nothing is charged). Dry-run quotes still
succeed but carry `warnings` — the gate is at execution, not pricing.

## Testnet ↔ mainnet toggle

Everything talks to the same contract; the network is one env var:

```bash
# Testnet (default): free, self-serve key, faucet-funded, tokens are worthless.
AGENT_API_URL=https://www.usetidepool.tech

# Mainnet: real partner key (naa_…) + a NEAR account you control.
AGENT_API_URL=https://api.agentsonintents.com
AGENT_API_KEY=naa_…
OWNER_ACCOUNT_ID=you.near
OWNER_PRIVATE_KEY=<32-byte seed of a full-access key, hex or base64>
```

Notes for mainnet:
- The owner key in `.env` is a **full-access key** — prefer signing in a UI via
  `@hot-labs/near-connect` / NEAR Connect rather than a raw env var for anything real.
- `agent_create` on mainnet may return NEP-366 (delegate action) signing instead of
  NEP-413; this demo signs NEP-413 and will tell you so (see `scripts/lib/provision.ts`).
- Recipe 1 executes **real** swaps with **real** funds.
- The official `@near-intents-agent-api/sdk` (Node ≥ 24) is a drop-in replacement for
  the thin `scripts/lib/api.ts` fetch client used here.

## MCP tools exposed to Hermes

| Tool | Auth | Notes |
|---|---|---|
| `list_tokens` | API key | asset ids, symbols, prices |
| `get_balances` | API key | atomic + human amounts |
| `get_policy` | API key | the owner-signed rules + usage |
| `get_quote` | API key | dry run; never refuses for policy — returns `warnings` |
| `execute_swap` | grant token | real swap; policy refusals come back as structured errors |
| `get_status` | API key | poll any action by `correlation_id` |

Policy violations surface to Hermes as
`{error: {code, layer, title, detail, retryable, hint}}` — the `SOUL.md` instructs
it to explain the breached rule instead of retrying.

## Tests (3 tiers, all real)

- **Tier 1 — `tests/api.e2e.test.ts`**: the recipes at the API level. Deterministic
  assertions: allowed swap settles `SUCCESS`; 403 `policy_transaction_limit_exceeded`;
  403 `policy_asset_denied`; quotes pass with warnings. One small real swap per run.
- **Tier 2 — `tests/mcp.e2e.test.ts`**: spawns the MCP stdio server exactly as Hermes
  does and exercises every tool over the MCP protocol.
- **Tier 3 — `tests/hermes.e2e.test.ts`**: the three recipes through the real Hermes
  agent (loose assertions — LLM output is nondeterministic). Gated behind `RUN_HERMES=1`.

`.github/workflows/hermes-e2e.yml` runs tiers 1+2 on push.

## Operational notes

- Tidepool quotas: 600 req/min per key, 25 agents per key, 5 new keys per IP/24 h —
  the provisioner caches the key and agent in `.state/` to stay well inside them.
- An agent runs one money action at a time; concurrent actions return 409 `wallet_busy`.
- If an action ever reads `UNCERTAIN`, keep polling the same `correlation_id` — never
  resend with a new key (it may have executed).
- The daily USD budget is shared across runs; if a swap is refused with
  `policy_budget_exceeded`, wait for the daily window to reset.
- The testnet faucet tops the agent back up automatically when its balance runs low.
