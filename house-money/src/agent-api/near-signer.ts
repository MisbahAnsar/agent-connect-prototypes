import { createHash } from "node:crypto";
import type { GenerateIntentResponse, SignedData } from "@near-intents-agent-api/sdk";
import {
  actions,
  encodeDelegateAction,
  encodeSignedDelegate,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  Signature,
  type KeyPairEd25519,
  type KeyPairString,
} from "near-api-js";
import type { OwnerSigner } from "./live";

export type NearOwnerOptions = {
  accountId: string;
  /** `ed25519:...` secret key of the owner's access key. Keep it out of the repo; load it from the environment. */
  privateKey: string;
  /** Used for `nep366` (gasless delegate action): the owner's current access-key nonce and block height. */
  rpcUrl?: string;
  /** Injected for tests; defaults to a `viewAccessKey` call against `rpcUrl`. */
  accessKey?: (accountId: string, publicKey: string) => Promise<{ nonce: bigint; blockHeight: bigint }>;
};

/**
 * Owner signer for a plain ed25519 NEAR key. It signs `generated.intent` exactly as returned: the
 * payload is never rebuilt, hashed or reordered. Use a dedicated owner account holding little value.
 */
export class NearOwnerSigner implements OwnerSigner {
  private readonly keyPair: KeyPairEd25519;
  readonly publicKey: string;

  constructor(private readonly opts: NearOwnerOptions) {
    this.keyPair = KeyPair.fromString(opts.privateKey as KeyPairString) as KeyPairEd25519;
    this.publicKey = this.keyPair.getPublicKey().toString();
    const implicit = Buffer.from(this.keyPair.getPublicKey().data).toString("hex");
    if (/^[0-9a-f]{64}$/.test(opts.accountId) && opts.accountId !== implicit)
      throw new Error("Implicit owner account does not match the private key");
  }

  /** The `owner` object for `createAgent`-style calls. */
  get owner() {
    return { type: "near" as const, account_id: this.opts.accountId, public_key: this.publicKey };
  }

  async sign(generated: GenerateIntentResponse): Promise<SignedData> {
    const { intent, signer } = generated;
    if (signer.type !== "near" || signer.public_key !== this.publicKey || signer.account_id !== this.opts.accountId)
      throw new Error("owner_account_mismatch");

    if (intent.standard === "nep413") {
      const keySigner = KeyPairSigner.fromSecretKey(this.keyPair.toString());
      const { signature } = await keySigner.signNep413Message("owner.near", {
        ...intent.payload,
        nonce: Buffer.from(intent.payload.nonce, "base64"),
      });
      return { ...intent, public_key: this.publicKey, signature: Buffer.from(signature).toString("base64") };
    }

    if (intent.standard !== "nep366") throw new Error("near_signing_standard_required");
    const { nonce, blockHeight } = await this.accessKey(signer.account_id, signer.public_key);
    const delegateAction = {
      senderId: signer.account_id,
      receiverId: intent.payload.receiverId,
      publicKey: this.keyPair.getPublicKey(),
      nonce: nonce + 1n,
      maxBlockHeight: blockHeight + 120n,
      actions: intent.payload.actions.map(({ params }) =>
        actions.functionCall(params.methodName, Buffer.from(JSON.stringify(params.args)), BigInt(params.gas), BigInt(params.deposit)),
      ),
    };
    const digest = createHash("sha256").update(encodeDelegateAction(delegateAction)).digest();
    return {
      ...intent,
      signed_delegate: Buffer.from(
        encodeSignedDelegate({ delegateAction, signature: new Signature({ keyType: 0, data: this.keyPair.sign(digest).signature }) }),
      ).toString("base64"),
    };
  }

  private async accessKey(accountId: string, publicKey: string) {
    if (this.opts.accessKey) return this.opts.accessKey(accountId, publicKey);
    if (!this.opts.rpcUrl) throw new Error("rpcUrl is required to sign a nep366 intent");
    const access = await new JsonRpcProvider({ url: this.opts.rpcUrl }).viewAccessKey({
      accountId,
      publicKey,
      finalityQuery: { finality: "final" },
    });
    return { nonce: access.nonce, blockHeight: BigInt(access.block_height) };
  }
}

/** Reads `NEAR_OWNER_ACCOUNT_ID`, `NEAR_OWNER_PRIVATE_KEY` and `NEAR_RPC_URL` (default: mainnet RPC). */
export function nearOwnerFromEnv(env: Record<string, string | undefined> = process.env): NearOwnerSigner {
  const accountId = env.NEAR_OWNER_ACCOUNT_ID;
  const privateKey = env.NEAR_OWNER_PRIVATE_KEY;
  if (!accountId || !privateKey) throw new Error("Set NEAR_OWNER_ACCOUNT_ID and NEAR_OWNER_PRIVATE_KEY");
  return new NearOwnerSigner({ accountId, privateKey, rpcUrl: env.NEAR_RPC_URL ?? "https://rpc.mainnet.near.org" });
}
