import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./db";
import { BASE_DOMAIN, PRIVATE_DOMAIN } from "./inventory";

// The gateway's signed identity assertion. `/internal/auth` mints a short-lived
// EdDSA JWT per request; nginx forwards it as `X-Kunguru-Identity`. Apps that
// verify it (public key from /api/identity-key, or the value provisioned into
// the kunguru-sites skill) get an unforgeable identity: unlike the
// Remote-User header, it cannot be spoofed by another local process.
//
// The token is audience-bound to the requested host, so a token captured by one
// tenant app cannot be replayed against a different app. It expires in a minute
// and is minted per request (no token store, no revocation list).
//
// The signing key is per instance, generated on first use and stored 0600 in
// the app's data directory (next to the database). The public key is not a
// secret and is served at GET /api/identity-key.

export const IDENTITY_TOKEN_HEADER = "X-Kunguru-Identity";
export const IDENTITY_TTL_SECONDS = 60;

export interface IdentityClaims {
  /** Issuer: the auth app's own origin. */
  iss: string;
  /** Audience: the exact hostname the request was for. */
  aud: string;
  /** The signed-in username. */
  sub: string;
  /** The user's group names. */
  grp: string[];
  iat: number;
  exp: number;
  jti: string;
}

export interface IdentitySigner {
  kid: string;
  /** PEM (SPKI) public key, for humans/tools. */
  publicKeyPem: string;
  /** Base64 SPKI DER, single line (env/skill friendly). */
  publicKeyDer: string;
  sign(claims: { aud: string; sub: string; grp: string[] }): string;
}

const KEY_PATH = join(DATA_DIR, "identity-key.pem");
let cached: IdentitySigner | null = null;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function loadOrCreateKey(): KeyObject {
  if (existsSync(KEY_PATH)) {
    return createPrivateKey(readFileSync(KEY_PATH, "utf8"));
  }
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  writeFileSync(KEY_PATH, pem, { mode: 0o600 });
  return privateKey;
}

export function getIdentitySigner(): IdentitySigner {
  if (cached) return cached;
  const privateKey = loadOrCreateKey();
  const publicKey = createPublicKey(privateKey);
  const der = publicKey.export({ type: "spki", format: "der" });
  const kid = createHash("sha256").update(der).digest("base64url").slice(0, 12);
  const publicKeyPem = publicKey.export({
    type: "spki",
    format: "pem",
  }) as string;
  const publicKeyDer = der.toString("base64");
  const issuer = `https://${PRIVATE_DOMAIN || BASE_DOMAIN}`;

  cached = {
    kid,
    publicKeyPem,
    publicKeyDer,
    sign({ aud, sub, grp }) {
      const now = Math.floor(Date.now() / 1000);
      const header = { alg: "EdDSA", typ: "JWT", kid };
      const payload: IdentityClaims = {
        iss: issuer,
        aud,
        sub,
        grp,
        iat: now,
        exp: now + IDENTITY_TTL_SECONDS,
        jti: randomBytes(9).toString("base64url"),
      };
      const signingInput = `${b64url(JSON.stringify(header))}.${b64url(
        JSON.stringify(payload),
      )}`;
      const signature = cryptoSign(null, Buffer.from(signingInput), privateKey);
      return `${signingInput}.${b64url(signature)}`;
    },
  };
  return cached;
}

function toPublicKey(publicKey: KeyObject | string): KeyObject {
  if (typeof publicKey !== "string") return publicKey;
  return publicKey.includes("BEGIN")
    ? createPublicKey(publicKey)
    : createPublicKey({
        key: Buffer.from(publicKey, "base64"),
        format: "der",
        type: "spki",
      });
}

/**
 * Verify a token's signature and expiry. Does not check `aud`/`iss` — the app
 * must compare `aud` with its own hostname (and may check `iss`). Returns null
 * for anything invalid.
 */
export function verifyIdentityToken(
  token: string,
  publicKey: KeyObject | string,
): IdentityClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  let header: { alg?: string };
  let claims: IdentityClaims;
  try {
    header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "EdDSA") return null;
  let ok = false;
  try {
    ok = cryptoVerify(
      null,
      Buffer.from(`${headerPart}.${payloadPart}`),
      toPublicKey(publicKey),
      Buffer.from(signaturePart, "base64url"),
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  if (typeof claims.exp !== "number" || claims.exp <= Date.now() / 1000) {
    return null;
  }
  return claims;
}
