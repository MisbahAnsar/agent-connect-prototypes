# NEAR Intents Agent API — contract reference

Verified against the live docs (2026-11) and exercised by the prototypes in
this repository. Authoritative source:
https://docs.agentsonintents.com/integration/agent-api/overview

## Networks

| Network | Base URL | Notes |
|---|---|---|
| Testnet (Tidepool) | `https://www.usetidepool.tech` | Free, self-serve; `POST /v1/keys` mints a `naa_…` partner key without signup; faucet funds agents; tokens have no value |
| Mainnet | `https://api.agentsonintents.com` | Real partner key + real NEAR account as owner; swaps move real funds |

The official SDK (`@near-intents-agent-api/sdk`, Node ≥ 24) takes `baseUrl` —
the network toggle is one env var.

## Auth model

| Credential | Shape | Sent as | Created by |
|---|---|---|---|
| Partner API key | `naa_…` | `Authorization: Bearer` or `X-API-Key` | Owner of the integration (testnet: self-serve) |
| Grant token | `ngt_…` | `X-Grant-Token` | Client generates (`ngt_` + 32 random bytes, base64url); owner signs only its SHA-256 commitment via `grant_issue` |

Actions need all three: API key + grant token + `Idempotency-Key`. Quotes and
deposits need no grant.

## Owner intents (human signs, backend submits)

`POST /v1/generate-intent` → sign `intent.payload` **exactly as returned** →
`POST /v1/submit-intent` → poll `GET /v1/status?correlation_id=…&wait_ms=30000`.

Intent types: `agent_create`, `grant_issue`, `grant_revoke`, `policy_update`,
`agent_freeze`, `agent_unfreeze`.

Signing standards by owner type (read `intent.standard`):

- `nep413` — message signing (ed25519): sha256 over borsh
  `{tag 2^31+413, message, nonce[32], recipient, variant 0}`; Tidepool testnet
  uses this for everything, including `agent_create` with implicit accounts
  (`account_id` = hex of the ed25519 public key — no on-chain account needed)
- `nep366` — signed delegate actions (mainnet NEAR accounts)
- `eip712` / `webauthn` — EVM / passkey owners

## Agent actions

`POST /v1/agents/{id}/{swap|transfer|withdraw|deposit}` → `202` +
`correlation_id` → poll status. `dry: true` returns a `200` quote instead
(never refuses for policy; rule breaches surface in `warnings`).

Status lifecycle: `QUEUED`, `PROCESSING`, `PENDING_DEPOSIT`,
`PENDING_APPROVAL`, `SUCCESS`, `FAILED`, `REFUNDED`, `UNCERTAIN`,
`NEEDS_REVIEW`. `UNCERTAIN` means the outcome is unproven — keep polling the
same `correlation_id`, never resend with a new key.

## Policy (owner-signed, enforced by the API)

```jsonc
{
  "frozen": false,
  "actions": ["swap", "transfer", "withdraw"],   // deposits always allowed
  "confidential": false,
  "owner_approval": false,
  "assets": ["nep141:…"],                        // or "any"
  "limits": { "per_transaction": { "ASSET_ID": "50000000" }, "daily": {}, "hourly": {}, "monthly": {} },
  "max_actions_per_hour": null,
  "destinations": { "mode": "only", "list": [ /* action/chain/address entries */ ] },
  "budget": { "daily_usd": "50", "weekly_usd": null, "monthly_usd": null },
  "timelock_ms": 0
}
```

Check order: frozen → action → asset → destination → per-transaction limit →
USD budget → cumulative limits → actions-per-hour. Violations are HTTP `403`,
`layer: "policy"`, with codes: `policy_action_denied`,
`policy_asset_denied`, `policy_destination_denied`,
`policy_transaction_limit_exceeded`, `policy_budget_exceeded`,
`policy_action_limit_exceeded`. Frozen agent → `409 wallet_frozen`; revoked
grant → `403 grant_revoked`.

Errors are JSON:API-shaped: `{"errors":[{status, code, layer, title, detail,
source, meta:{retryable}}], "meta":{"request_id"}}`.

## Quotas (Tidepool testnet)

600 req/min per key · 25 agents per key · 5 new keys per IP / 24 h. Grants up
to 50 live per agent; TTL 1–365 days. An agent runs one money action at a
time (`409 wallet_busy` on overlap).

## Trust & verification

The API runs in an attested TEE; every execution has a checkable proof.
See https://docs.agentsonintents.com/integration/agent-api/tee.
