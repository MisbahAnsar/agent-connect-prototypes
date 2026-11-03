import crypto from "node:crypto";

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(buf: Buffer): string {
  let n = BigInt("0x" + buf.toString("hex"));
  let s = "";
  while (n > 0n) {
    s = B58_ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b) break;
    s = "1" + s;
  }
  return s;
}

export interface OwnerKey {
  privateKey: crypto.KeyObject;
  /** Implicit-account id: the hex of the raw ed25519 public key (testnet needs no on-chain account). */
  account_id: string;
  /** "ed25519:<base58 pub key>" */
  public_key: string;
}

export interface OwnerJwk {
  kty: "OKP";
  crv: "Ed25519";
  d: string;
  x: string;
}

function ownerFromKeyObject(privateKey: crypto.KeyObject): OwnerKey {
  const pubJwk = crypto.createPublicKey(privateKey).export({ format: "jwk" }) as { x: string };
  const raw = Buffer.from(pubJwk.x, "base64url");
  return {
    privateKey,
    account_id: raw.toString("hex"),
    public_key: "ed25519:" + base58(raw),
  };
}

export function generateOwner(): OwnerKey {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  return ownerFromKeyObject(privateKey);
}

export function ownerToJwk(owner: OwnerKey): OwnerJwk {
  return owner.privateKey.export({ format: "jwk" }) as OwnerJwk;
}

export function ownerFromJwk(jwk: OwnerJwk): OwnerKey {
  const privateKey = crypto.createPrivateKey({
    key: jwk as unknown as crypto.JsonWebKey,
    format: "jwk",
  });
  return ownerFromKeyObject(privateKey);
}

/**
 * Build an owner from a raw 32-byte ed25519 seed (mainnet mode).
 * Accepts hex (64 chars) or base64/base64url. The account id must be provided
 * separately for named accounts; for implicit accounts it is the hex pubkey.
 */
export function ownerFromSeed(seed: string, accountId?: string): OwnerKey {
  let raw: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(seed)) {
    raw = Buffer.from(seed, "hex");
  } else {
    raw = Buffer.from(seed.replaceAll("-", "+").replaceAll("_", "/"), "base64");
  }
  if (raw.length !== 32) throw new Error(`OWNER_PRIVATE_KEY must be 32 bytes, got ${raw.length}`);
  const privateKey = crypto.createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: raw.toString("base64url"), x: "" } as crypto.JsonWebKey,
    format: "jwk",
  });
  const owner = ownerFromKeyObject(privateKey);
  if (accountId) owner.account_id = accountId;
  return owner;
}

/**
 * Sign a NEP-413 message payload with the owner key.
 * Payload = sha256( borsh(u32 tag 2^31+413, message, nonce[32], recipient, variant 0) ), EdDSA-signed.
 * This mirrors the reference implementation in Tidepool's /v1/e2e.js.
 */
export function signNep413(
  owner: OwnerKey,
  payload: { message: string; nonce: string; recipient: string },
): string {
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const bstr = (s: string): Buffer => {
    const x = Buffer.from(s, "utf8");
    return Buffer.concat([u32(x.length), x]);
  };
  const nonce = Buffer.from(payload.nonce, "base64");
  if (nonce.length !== 32) throw new Error(`NEP-413 nonce must be 32 bytes, got ${nonce.length}`);
  const hash = crypto
    .createHash("sha256")
    .update(
      Buffer.concat([
        u32(2 ** 31 + 413),
        bstr(payload.message),
        nonce,
        bstr(payload.recipient),
        Buffer.from([0]),
      ]),
    )
    .digest();
  return crypto.sign(null, hash, owner.privateKey).toString("base64");
}
