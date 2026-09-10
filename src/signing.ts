import { createHash, createHmac, createPrivateKey, randomBytes, sign as signWithKey } from "node:crypto";
import type { KeyObject } from "node:crypto";

/**
 * The signing scheme, restated for this client.
 *
 * The server's own implementation is apps/api/internal/apikeys/canonical.go, and
 * the numbers below are pinned against the worked example that package publishes
 * (see test/signing.test.ts). A signature verifies only if this file agrees with
 * that one byte for byte, so nothing here normalises, re-encodes or reformats
 * anything: whatever is sent is what is signed, because that is the only version
 * of the request the caller can be sure of.
 */

/** The four headers a signed request carries. All four are required. */
export const HEADER_KEY_ID = "X-Key-Id";
export const HEADER_TIMESTAMP = "X-Timestamp";
export const HEADER_NONCE = "X-Nonce";
export const HEADER_SIGNATURE = "X-Signature";

/** What a caller dials and signs. Never the internal prefix. */
export const PUBLIC_PREFIX = "/v1";

/** The two primitives the server verifies with, spelled as it spells them. */
export const ALGORITHMS = ["Ed25519", "HMAC-SHA256"] as const;
export type Alg = (typeof ALGORITHMS)[number];

/** Lowercase hex SHA-256 of the raw body. An absent body hashes as an empty one. */
export function bodyHash(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * The string a request's signature is taken over: six lines joined with "\n",
 * no trailing newline.
 *
 *   <METHOD, uppercased>
 *   <URL path, exactly as dialled>
 *   <raw query string, exactly as sent, "" when there is none>
 *   <X-Timestamp>
 *   <X-Nonce>
 *   <hex SHA-256 of the raw body>
 *
 * The method is uppercased and nothing else is touched. In particular the query
 * is not sorted and the path is not re-escaped — doing either would produce a
 * string the server does not build.
 */
export function canonical(
  method: string,
  path: string,
  query: string,
  timestamp: string,
  nonce: string,
  body: Uint8Array,
): Buffer {
  return Buffer.from(
    [method.toUpperCase(), path, query, timestamp, nonce, bodyHash(body)].join("\n"),
    "utf8",
  );
}

/** Turns a canonical string into the base64 X-Signature value. */
export type Signer = { readonly alg: Alg; sign(canonicalString: Buffer): string };

/**
 * An Ed25519 signer from a PEM private key.
 *
 * `sign(null, ...)` is correct and not an oversight: Ed25519 hashes internally,
 * so naming a digest algorithm there is an error rather than an improvement.
 */
export function ed25519Signer(pem: string | KeyObject): Signer {
  const key = typeof pem === "string" ? createPrivateKey(pem) : pem;
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`the private key is ${key.asymmetricKeyType ?? "not an asymmetric key"}, and Ed25519 is required`);
  }
  return { alg: "Ed25519", sign: (canon) => signWithKey(null, canon, key).toString("base64") };
}

/**
 * An HMAC-SHA256 signer from the base64 secret the dashboard showed once.
 *
 * The signing key is the DECODED bytes, not the base64 text — signing the text
 * is the single most common way to get a signature refused with everything else
 * correct, so the decode happens here and the caller never sees the choice.
 */
export function hmacSigner(secretBase64: string): Signer {
  const secret = decodeSecret(secretBase64);
  return { alg: "HMAC-SHA256", sign: (canon) => createHmac("sha256", secret).update(canon).digest("base64") };
}

/**
 * Decodes the base64 secret, and refuses text that is not base64 rather than
 * silently signing with whatever Buffer.from salvaged from it.
 */
export function decodeSecret(secretBase64: string): Buffer {
  const trimmed = secretBase64.trim();
  const secret = Buffer.from(trimmed, "base64");
  if (secret.length === 0 || secret.toString("base64").replace(/=+$/, "") !== trimmed.replace(/=+$/, "")) {
    throw new Error("the shared secret is not valid base64");
  }
  return secret;
}

/** A fresh nonce: 16 hex characters, well inside the 64 the server allows. */
export function newNonce(): string {
  return randomBytes(8).toString("hex");
}

/** Whole seconds since the epoch, which is what X-Timestamp carries. */
export function nowSeconds(clock: () => number = Date.now): string {
  return Math.floor(clock() / 1000).toString();
}

/** The four headers for one request, ready to merge into a fetch init. */
export function signedHeaders(
  signer: Signer,
  keyId: string,
  method: string,
  path: string,
  query: string,
  body: Uint8Array,
  clock: () => number = Date.now,
  nonce: string = newNonce(),
): Record<string, string> {
  const timestamp = nowSeconds(clock);
  return {
    [HEADER_KEY_ID]: keyId,
    [HEADER_TIMESTAMP]: timestamp,
    [HEADER_NONCE]: nonce,
    [HEADER_SIGNATURE]: signer.sign(canonical(method, path, query, timestamp, nonce, body)),
  };
}
