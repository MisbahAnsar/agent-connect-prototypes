/**
 * Tier 2 — MCP bridge e2e: spawns the real MCP stdio server exactly as Hermes
 * would (node dist/mcp-server/index.js + grant-token env) and exercises the
 * tools over the MCP protocol. Requires `npm run build` first.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "./helpers/fixture.js";
import type { ProvisionResult } from "../scripts/lib/provision.js";

const SERVER_PATH = path.resolve(import.meta.dirname, "../dist/mcp-server/index.js");

let ctx: ProvisionResult;
let mcp: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  if (!existsSync(SERVER_PATH)) {
    throw new Error(`${SERVER_PATH} not found — run \`npm run build\` before the MCP tests.`);
  }
  ctx = await fixture();
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      AGENT_API_URL: ctx.config.baseUrl,
      AGENT_API_KEY: ctx.config.apiKey ?? ctx.state.api_key ?? "",
      AGENT_GRANT_TOKEN: ctx.state.grant_token ?? "",
      AGENT_ID: ctx.state.agent_id ?? "",
    },
  });
  mcp = new Client({ name: "hermes-demo-tests", version: "0.1.0" });
  await mcp.connect(transport);
}, 300000);

afterAll(async () => {
  await mcp?.close().catch(() => {});
});

function parse(result: any): any {
  expect(result.content?.[0]?.type).toBe("text");
  return JSON.parse(result.content[0].text);
}

describe("agent_api MCP server", () => {
  it("registers the expected tools", async () => {
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        "list_tokens",
        "get_balances",
        "get_policy",
        "get_quote",
        "execute_swap",
        "get_status",
      ]),
    );
  });

  it("get_balances returns the funded balance", async () => {
    const result = await mcp.callTool({ name: "get_balances", arguments: {} });
    const data = parse(result);
    const funded = data.balances.find((b: any) => b.asset_id === ctx.state.assets!.funded);
    expect(funded).toBeTruthy();
    expect(funded.available).toBeTruthy();
  });

  it("get_policy exposes the owner-signed rules", async () => {
    const result = await mcp.callTool({ name: "get_policy", arguments: {} });
    const data = parse(result);
    expect(data.status).toBe("APPLIED");
    expect(data.policy.assets).toContain(ctx.state.assets!.funded);
    expect(data.policy.budget.daily_usd).toBe("50");
  });

  it("get_quote returns a dry quote for an allowed pair", async () => {
    const assets = ctx.state.assets!;
    const result = await mcp.callTool({
      name: "get_quote",
      arguments: {
        origin_asset: assets.funded,
        destination_asset: assets.second,
        amount: "1000000",
      },
    });
    const data = parse(result);
    expect(data.dry).toBe(true);
    expect(data.quote).toBeTruthy();
  });

  it("execute_swap over the policy limit returns a structured policy error", async () => {
    const assets = ctx.state.assets!;
    const amount = (BigInt(ctx.state.per_transaction_limit_raw!) + 10_000_000n).toString();
    const result = await mcp.callTool({
      name: "execute_swap",
      arguments: {
        origin_asset: assets.funded,
        destination_asset: assets.second,
        amount,
      },
    });
    expect(result.isError).toBe(true);
    const data = parse(result);
    expect(data.error.code).toBe("policy_transaction_limit_exceeded");
    expect(data.error.layer).toBe("policy");
    expect(data.error.hint).toBeTruthy();
  });

  it("execute_swap into a disallowed asset returns policy_asset_denied", async () => {
    const assets = ctx.state.assets!;
    const result = await mcp.callTool({
      name: "execute_swap",
      arguments: {
        origin_asset: assets.funded,
        destination_asset: assets.blocked,
        amount: "1000000",
      },
    });
    expect(result.isError).toBe(true);
    const data = parse(result);
    expect(data.error.code).toBe("policy_asset_denied");
    expect(data.error.layer).toBe("policy");
  });
});
