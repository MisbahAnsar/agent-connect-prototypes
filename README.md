# agent-connect-prototypes

Prototypes and experiments for the **NEAR Intents Agent API** — wallets that AI
agents can use, bounded by human-signed policy.

Each directory is a self-contained prototype against the same contract:

| Prototype | What it shows |
|---|---|
| [`hermes/`](./hermes) | **Hermes Agent** executing policy-bound swaps through the Agent API over MCP — owner signs policy + grant, the LLM agent only ever holds a scoped token, the API enforces the rules |

## Setup

```bash
cd hermes
npm install
npm run provision     # testnet: free key + agent wallet + grant + faucet
npm run recipe:1      # run the demo
npm test              # e2e tiers (API / MCP / full agent)
```

See [`hermes/README.md`](./hermes/README.md) for the full walkthrough.

## Relevant links

- **Agent API docs (official)** — https://docs.agentsonintents.com/integration/agent-api/overview
- **Contract reference** (networks, intents, policy model, error codes) — [`docs/agent-api.md`](./docs/agent-api.md)
- **Tidepool testnet** (free sandbox impl of the Agent API) — https://www.usetidepool.tech/docs/guides/agent-api
- **Official TypeScript SDK** — `@near-intents-agent-api/sdk` (npm, Node ≥ 24)
- **Hermes Agent** — https://github.com/NousResearch/hermes-agent
- **NEAR AI Cloud** (OpenAI-compatible inference) — https://docs.near.ai
- **NEAR Intents** (swaps, verifier, explorer) — https://explorer.near-intents.org/

## Safety model

Prototypes here follow the same split everywhere:

- **Owner authority** — a human key signs the policy and grant once, up front
- **Agent execution** — the agent holds only a scoped grant token (`ngt_…`)
- **Enforcement** — the Agent API (attested TEE) refuses anything outside the policy

Testnet by default (Tidepool, tokens have no value); mainnet is a `baseUrl`
toggle away and moves real funds.
