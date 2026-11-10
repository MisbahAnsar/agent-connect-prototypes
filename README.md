# agent-api-prototypes

Prototypes and experiments for the **NEAR Intents Agent API** — wallets that AI
agents can use, bounded by human-signed policy.

Each directory is a self-contained prototype against the same contract:

| Prototype | What it shows |
|---|---|
| [`hermes/`](./hermes) | **Hermes Agent** executing policy-bound swaps through the Agent API over MCP — owner signs policy + grant, the LLM agent only ever holds a scoped token, the API enforces the rules |
| [`house-money/`](./house-money) | **House Money** trading use case — deposit → run your strategy → repeat, and the stake banks itself the moment gains cover it (exactly-once withdraw to a safe address under policy). Plug-in `Strategy` seam, offline scenario harness (64 tests), live chaos recipe |
| [`nearmerch-agent-pay/`](./nearmerch-agent-pay) | **nearmerch + Agent Connect + Ping Agent Pay** — an agent buys merch on nearmerch.com over x402 near-intents: Ping quotes a Base deposit address, Agent Connect withdraws USDC to it over MCP, Ping settles to the store's NEAR recipient. Read-only `check`, `pay --confirm` (mainnet), offline fake-backed tests |

## Setup

Each prototype is self-contained:

```bash
# Hermes — policy-bound swaps via an LLM agent over MCP
cd hermes
npm install
npm run provision     # testnet: free key + agent wallet + grant + faucet
npm run recipe:1      # run the demo
npm test              # e2e tiers (API / MCP / full agent)

# House Money — plug-in trading loop with principal protection
cd house-money
npm install
npm run provision     # testnet: free key + agent + house-money policy + deposit address
npm run recipe:1      # trend trading loop (2: + principal exit · 3: your strategy · 4: chaos probes)
npm test              # unit + scenario harness (64 tests, offline)

# nearmerch Agent Pay — buy merch via x402 near-intents (Ping) with an Agent Connect wallet
cd nearmerch-agent-pay
npm install
npm run check         # read-only: catalog, pay route, Ping discovery, wallet + policy
npm run pay -- --confirm   # ⚠ mainnet: real order + real USDC (capped by MAX_USDC)
npm test              # offline: fake nearmerch + fake Ping + fake Agent Connect
```

Full walkthroughs: [`hermes/README.md`](./hermes/README.md) ·
[`house-money/README.md`](./house-money/README.md) ·
[`nearmerch-agent-pay/README.md`](./nearmerch-agent-pay/README.md).

## Relevant links

- **Agent API docs (official)** — https://docs.agentsonintents.com/integration/agent-api/overview
- **Contract reference** (networks, intents, policy model, error codes) — [`docs/agent-api.md`](./docs/agent-api.md)
- **Tidepool testnet** (free sandbox impl of the Agent API) — https://www.usetidepool.tech/docs/guides/agent-api
- **Official TypeScript SDK** — `@near-intents-agent-api/sdk` (npm, Node ≥ 24)
- **Hermes Agent** — https://github.com/NousResearch/hermes-agent
- **NEAR AI Cloud** (OpenAI-compatible inference) — https://docs.near.ai
- **NEAR Intents** (swaps, verifier, explorer) — https://explorer.near-intents.org/
- **Ping Agent Pay — Pay with Agent Connect** — https://pingpay.gitbook.io/docs/pingpay-api/agent-pay-facilitator/pay-with-agent-connect
- **Agent Connect MCP tools** — https://agent-connect-app-production.up.railway.app/docs/mcp-tools
- **x402 near-intents scheme** (spec PR #3370) — https://github.com/x402-foundation/x402/pull/3370

## Safety model

Prototypes here follow the same split everywhere:

- **Owner authority** — a human key signs the policy and grant once, up front
- **Agent execution** — the agent holds only a scoped grant token (`ngt_…`)
- **Enforcement** — the Agent API (attested TEE) refuses anything outside the policy

Testnet by default (Tidepool, tokens have no value); mainnet is a `baseUrl`
toggle away and moves real funds.
