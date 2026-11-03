import assert from "node:assert/strict";
import { test } from "vitest";
import type { GenerateIntentResponse } from "@near-intents-agent-api/sdk";
import { KeyPair, type KeyPairEd25519 } from "near-api-js";
import { NearOwnerSigner, nearOwnerFromEnv } from "../src/agent-api/near-signer";

const kp = KeyPair.fromRandom("ed25519") as KeyPairEd25519;
const pub = kp.getPublicKey().toString();
const make = () => new NearOwnerSigner({ accountId: "owner.near", privateKey: kp.toString(), accessKey: async () => ({ nonce: 41n, blockHeight: 1000n }) });
const generated = (intent: unknown, over: Record<string, unknown> = {}) =>
  ({ type: "policy_update", correlation_id: "c1", agent_id: "a", intent, signer: { type: "near", account_id: "owner.near", public_key: pub, ...over } }) as unknown as GenerateIntentResponse;

test("nep413: returns the key, a 64-byte signature and the unchanged intent", async () => {
  const intent = { standard: "nep413", payload: { message: "hello", recipient: "intents.near", nonce: Buffer.alloc(32, 7).toString("base64") } };
  const out = (await make().sign(generated(intent))) as unknown as Record<string, unknown>;
  assert.equal(out.standard, "nep413");
  assert.equal(out.public_key, pub);
  assert.equal(Buffer.from(out.signature as string, "base64").length, 64);
  assert.deepEqual(out.payload, intent.payload);
});

test("nep413 signing is deterministic for the same payload", async () => {
  const intent = { standard: "nep413", payload: { message: "m", recipient: "r", nonce: Buffer.alloc(32, 1).toString("base64") } };
  const a = (await make().sign(generated(intent))) as unknown as { signature: string };
  const b = (await make().sign(generated(intent))) as unknown as { signature: string };
  assert.equal(a.signature, b.signature);
});

test("nep366: builds a signed delegate using the owner's access-key nonce", async () => {
  const intent = { standard: "nep366", payload: { receiverId: "intents.near", actions: [{ type: "FunctionCall", params: { methodName: "add_public_key", args: { a: 1 }, gas: "1000", deposit: "0" } }] } };
  const out = (await make().sign(generated(intent))) as unknown as { signed_delegate: string };
  assert.ok(Buffer.from(out.signed_delegate, "base64").length > 64);
});

test("refuses an intent for a different owner or key", async () => {
  const intent = { standard: "nep413", payload: { message: "m", recipient: "r", nonce: Buffer.alloc(32).toString("base64") } };
  await assert.rejects(make().sign(generated(intent, { account_id: "evil.near" })), /owner_account_mismatch/);
  await assert.rejects(make().sign(generated(intent, { public_key: KeyPair.fromRandom("ed25519").getPublicKey().toString() })), /owner_account_mismatch/);
});

test("refuses signing standards it does not implement", async () => {
  await assert.rejects(make().sign(generated({ standard: "eip712", payload: {} })), /near_signing_standard_required/);
});

test("a mismatched implicit account is rejected at construction", () => {
  assert.throws(() => new NearOwnerSigner({ accountId: "a".repeat(64), privateKey: kp.toString() }), /does not match/);
});

test("nearOwnerFromEnv requires both variables", () => {
  assert.throws(() => nearOwnerFromEnv({}), /NEAR_OWNER_ACCOUNT_ID/);
  assert.equal(nearOwnerFromEnv({ NEAR_OWNER_ACCOUNT_ID: "owner.near", NEAR_OWNER_PRIVATE_KEY: kp.toString() }).publicKey, pub);
});
