/**
 * Tier 3 — full-agent e2e: the three recipes through the real Hermes agent
 * (NEAR AI Cloud model + agent_api MCP tools). LLM output is nondeterministic,
 * so assertions stay loose (does the agent report success / name the breached
 * rule). Gated behind RUN_HERMES=1 because it needs:
 *   - `hermes` on PATH
 *   - NEAR_AI_API_KEY in .env
 *   - `npm run provision` + `npm run build` done
 */
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "../scripts/lib/config.js";
import { fixture } from "./helpers/fixture.js";
import { queryHermes, detectBackend, type HermesReply } from "../recipes/hermes_client.js";
import type { ProvisionResult } from "../scripts/lib/provision.js";

const DEMO_ROOT = path.resolve(import.meta.dirname, "..");
loadEnvFile(path.join(DEMO_ROOT, ".env"));

const backend = detectBackend();
const enabled =
  process.env.RUN_HERMES === "1" &&
  !!process.env.NEAR_AI_API_KEY &&
  existsSync(path.join(DEMO_ROOT, "profile", ".env")) &&
  backend !== null;

const maybe = enabled ? describe : describe.skip;
if (!enabled) {
  console.log(
    "[tier 3] skipped — set RUN_HERMES=1, provide NEAR_AI_API_KEY (host hermes or docker required), run provision+build. " +
      `checks: RUN_HERMES=${process.env.RUN_HERMES} key=${!!process.env.NEAR_AI_API_KEY} backend=${backend}`,
  );
}

let ctx: ProvisionResult;

beforeAll(async () => {
  ctx = await fixture();
}, 300000);

function assertReply(reply: HermesReply): string {
  expect(reply.output, "hermes produced output").toBeTruthy();
  return reply.output;
}

maybe("hermes agent end-to-end", () => {
  it(
    "recipe 1: executes an allowed swap and reports success",
    async () => {
      const a = ctx.state.assets!;
      const reply = await queryHermes(`Swap 5 ${a.fundedSymbol} to ${a.secondSymbol}.`);
      const out = assertReply(reply);
      expect(out).toMatch(/success|completed|swapped|tx|hash|amount_out/i);
      expect(out).not.toMatch(/policy_asset_denied|policy_transaction_limit_exceeded/i);
    },
    300000,
  );

  it(
    "recipe 2: reports the per-transaction limit refusal without retrying",
    async () => {
      const a = ctx.state.assets!;
      const cap = Number(ctx.state.per_transaction_limit_raw) / 1e6;
      const reply = await queryHermes(`Swap ${Math.ceil(cap * 1.5)} ${a.fundedSymbol} to ${a.secondSymbol}.`);
      const out = assertReply(reply);
      expect(out).toMatch(/policy_transaction_limit_exceeded|per[- ]transaction|limit/i);
    },
    300000,
  );

  it(
    "recipe 3: reports the disallowed-asset refusal",
    async () => {
      const a = ctx.state.assets!;
      const reply = await queryHermes(`Swap 10 ${a.fundedSymbol} to ${a.blockedSymbol}.`);
      const out = assertReply(reply);
      expect(out).toMatch(/policy_asset_denied|not (?:allowed|permitted|supported)|not in (?:the )?(?:policy|allow)/i);
    },
    300000,
  );
});
