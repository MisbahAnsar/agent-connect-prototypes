/**
 * MCP stdio server exposing the NEAR Intents Agent API to Hermes.
 *
 * This is the piece the upstream ecosystem doesn't ship yet (there is no
 * @near-intents-agent-api/mcp-server on npm). It holds ONLY the scoped grant
 * token — never the owner key — and every spending call it makes is checked
 * against the owner-signed policy by the Agent API.
 *
 * Configuration (via env, resolved from Hermes' ${VAR} substitution):
 *   AGENT_API_URL      e.g. https://www.usetidepool.tech
 *   AGENT_API_KEY      naa_… partner key
 *   AGENT_GRANT_TOKEN  ngt_… scoped grant (required for spending actions)
 *   AGENT_ID           agent id
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AgentApiClient, AgentApiError, type TokenInfo } from "../scripts/lib/api.js";
import { randomUUID } from "node:crypto";

const AGENT_API_URL = process.env.AGENT_API_URL ?? "https://www.usetidepool.tech";
const AGENT_API_KEY = process.env.AGENT_API_KEY ?? "";
const AGENT_GRANT_TOKEN = process.env.AGENT_GRANT_TOKEN ?? "";
const AGENT_ID = process.env.AGENT_ID ?? "";

const client = new AgentApiClient(AGENT_API_URL, AGENT_API_KEY);

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorText(err: unknown) {
  if (err instanceof AgentApiError) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              error: {
                http_status: err.httpStatus,
                code: err.code,
                layer: err.layer,
                title: err.errors[0]?.title,
                detail: err.errors[0]?.detail,
                retryable: err.errors[0]?.meta?.retryable ?? false,
                hint: "The owner-signed policy refused this action. Do not retry; explain the breached rule to the user.",
              },
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: "text" as const, text: `Unexpected error: ${String(err)}` }],
    isError: true,
  };
}

function requireAgentId(): string {
  if (!AGENT_ID) throw new Error("AGENT_ID env var is not set — run `npm run provision` first.");
  return AGENT_ID;
}

function requireGrant(): string {
  if (!AGENT_GRANT_TOKEN) throw new Error("AGENT_GRANT_TOKEN env var is not set — run `npm run provision` first.");
  return AGENT_GRANT_TOKEN;
}

const tokenSummary = (t: TokenInfo) => ({
  asset_id: t.asset_id,
  symbol: t.symbol,
  blockchain: t.blockchain,
  decimals: t.decimals,
  price_usd: t.price ?? null,
});

const server = new McpServer({ name: "near-intents-agent-api", version: "0.1.0" });

server.tool(
  "list_tokens",
  "List every asset the agent can hold or trade on NEAR Intents, with asset ids used by other tools.",
  {},
  async () => {
    try {
      const tokens = await client.tokens();
      return text({ tokens: tokens.map(tokenSummary) });
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "get_balances",
  "Read the agent wallet's current balances (atomic units and human amounts).",
  {},
  async () => {
    try {
      const b = await client.getBalances(requireAgentId());
      return text({
        near_account_id: b.near_account_id,
        balances: b.balances.map((x) => ({
          asset_id: x.asset_id,
          symbol: x.symbol,
          balance: x.balance,
          available: x.available,
        })),
      });
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "get_policy",
  "Read the owner-signed policy currently in force: allowed actions and assets, per-transaction limits, daily USD budget, destinations.",
  {},
  async () => {
    try {
      const p = await client.getPolicy(requireAgentId());
      return text({
        status: p.status,
        revision: p.revision,
        policy: p.policy,
        usage: p.usage,
      });
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "get_quote",
  "Request a swap quote without executing (dry run). Returns price/route and `warnings` for any policy rule the live swap would hit. Never moves funds.",
  {
    origin_asset: z.string().describe("Source asset id from list_tokens, e.g. nep141:…"),
    destination_asset: z.string().describe("Target asset id from list_tokens"),
    amount: z.string().describe("Amount in atomic units (see decimals in list_tokens), as a string"),
  },
  async ({ origin_asset, destination_asset, amount }) => {
    try {
      const res = await client.action(
        "swap",
        requireAgentId(),
        { origin_asset, destination_asset, amount, dry: true },
      );
      return text(res);
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "execute_swap",
  "Execute a real swap from the agent wallet under the owner-signed policy. The Agent API enforces assets, limits, budget and destinations before submitting; policy refusals come back as structured errors (code + layer).",
  {
    origin_asset: z.string().describe("Source asset id from list_tokens"),
    destination_asset: z.string().describe("Target asset id from list_tokens"),
    amount: z.string().describe("Amount in atomic units, as a string"),
    min_amount_out: z.string().optional().describe("Optional slippage floor in atomic units"),
  },
  async ({ origin_asset, destination_asset, amount, min_amount_out }) => {
    try {
      const res = await client.action(
        "swap",
        requireAgentId(),
        {
          origin_asset,
          destination_asset,
          amount,
          ...(min_amount_out ? { min_amount_out } : {}),
        },
        { grant: requireGrant(), idempotencyKey: `hermes-${randomUUID()}` },
      );
      const settled = await client.settle(res.correlation_id, 120000);
      return text({
        correlation_id: settled.correlation_id,
        status: settled.status,
        amount_out: settled.details?.amount_out,
        tx_hash: settled.details?.tx_hash,
      });
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "get_status",
  "Poll the execution status of a previous action by correlation_id.",
  {
    correlation_id: z.string().describe("The correlation_id returned by execute_swap or another action"),
  },
  async ({ correlation_id }) => {
    try {
      return text(await client.status(correlation_id, 30000));
    } catch (err) {
      return errorText(err);
    }
  },
);

await server.connect(new StdioServerTransport());
