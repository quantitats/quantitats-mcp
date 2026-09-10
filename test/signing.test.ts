import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";

import { bodyHash, canonical, decodeSecret, ed25519Signer, hmacSigner, signedHeaders } from "../src/signing.ts";

/**
 * The signing scheme is published as much as it is implemented, and this client
 * is one more restatement of it. A build stays green while this file says five
 * lines and the server wants six, and the person who finds out is whoever has
 * had a signature refused for an afternoon with no way to tell which side is
 * wrong.
 *
 * So the figures below are the ones apps/api/internal/apikeys/published_test.go
 * pins, copied deliberately rather than derived. If one of these fails, either
 * this client is wrong or the scheme changed and every published client — the
 * docs page, the bash, Python and Node examples — changed with it.
 */
const published = {
  method: "POST",
  path: "/v1/trade/orders",
  query: "",
  timestamp: "1757404800",
  nonce: "b3f1c0a29d7e4f16",
  body: '{"exchange":"binance_spot","symbol":"BTCUSDT","side":"buy","type":"limit","quantity":"0.001","price":"60000"}',
  // Example key material, published on purpose and worth nothing to anybody.
  secret: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=",
  // The public half of the example keypair. Only this half was ever published —
  // which is the point of the algorithm — so the Ed25519 assertion below
  // verifies the published signature rather than reproducing it. It pins the
  // same thing: a signature verifies only over the exact canonical string, so
  // one that verifies here proves this client builds the string the server does.
  publicKey: "MCowBQYDK2VwAyEAebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=",
  ed25519Signature:
    "vronm/nAUrMiCgTf2yTExxAw8Z7eTNlrPqwDghSL84DQwiNoHkZMMqOM6D624CXmRIIQxl+KkZqinglsjjXMCg==",
  hmacSignature: "jfgoSyacKjrAm0BwV7Wl0ctbt1JYOvPZL4hCawHLobM=",
} as const;

const publishedCanonical = canonical(
  published.method,
  published.path,
  published.query,
  published.timestamp,
  published.nonce,
  Buffer.from(published.body, "utf8"),
);

describe("the published worked example", () => {
  it("hashes the body to the published digest", () => {
    expect(bodyHash(Buffer.from(published.body, "utf8"))).toBe(
      "8076ab7412cdc9a3b1f99bed3067dbe69a55988ae331c6b96cf911729ad7ba60",
    );
  });

  it("builds a canonical string of the published length", () => {
    expect(published.body.length).toBe(109);
    expect(publishedCanonical.length).toBe(115);
  });

  it("builds the canonical string the docs print, byte for byte", () => {
    // Spelled out so a failure shows the shape as well as the length: six
    // lines, five separators, an empty third line where the query would be, and
    // nothing at the end.
    expect(publishedCanonical.toString("utf8")).toBe(
      "POST\n/v1/trade/orders\n\n1757404800\nb3f1c0a29d7e4f16\n" +
        "8076ab7412cdc9a3b1f99bed3067dbe69a55988ae331c6b96cf911729ad7ba60",
    );
  });

  it("digests to the value a caller is told to compare against first", () => {
    // The load-bearing one: it isolates the canonical string from every question
    // about key material. A caller whose digest matches has one problem left.
    expect(createHash("sha256").update(publishedCanonical).digest("hex")).toBe(
      "0890c49d3324d100597fa124e7b4fcfd2cd0fbb607ab6802c16c1884f9723727",
    );
  });

  it("produces the published HMAC-SHA256 signature", () => {
    expect(hmacSigner(published.secret).sign(publishedCanonical)).toBe(published.hmacSignature);
  });

  it("builds the string the published Ed25519 signature verifies over", () => {
    const publicKey = createPublicKey({
      key: Buffer.from(published.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    expect(
      verify(null, publishedCanonical, publicKey, Buffer.from(published.ed25519Signature, "base64")),
    ).toBe(true);
  });
});

describe("the HMAC signing key", () => {
  it("is the decoded bytes, not the base64 text", () => {
    // The single most common way to have a signature refused with everything
    // else correct. Signing the text produces a different value, and this pins
    // that the client does not.
    const decoded = decodeSecret(published.secret);
    expect(decoded).toHaveLength(32);
    expect([...decoded.subarray(0, 4)]).toEqual([1, 2, 3, 4]);
  });

  it("refuses a secret that is not base64", () => {
    expect(() => decodeSecret("not base64 at all!!")).toThrow(/not valid base64/);
  });
});

describe("ed25519Signer", () => {
  it("produces a signature that verifies under the matching public key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signature = ed25519Signer(privateKey).sign(publishedCanonical);
    expect(verify(null, publishedCanonical, publicKey, Buffer.from(signature, "base64"))).toBe(true);
  });

  it("refuses a key of the wrong type rather than signing with it", () => {
    const rsa =
      "-----BEGIN PRIVATE KEY-----\n" +
      "MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEAvJhLTNMLLGqmSt4a\n" +
      "-----END PRIVATE KEY-----\n";
    expect(() => ed25519Signer(rsa)).toThrow();
  });
});

describe("signedHeaders", () => {
  it("carries all four headers, with the timestamp in whole seconds", () => {
    const headers = signedHeaders(
      hmacSigner(published.secret),
      "ak_klzcmzngbqjnfciylwkq52ebgy",
      "GET",
      "/v1/bots",
      "",
      new Uint8Array(0),
      () => 1_757_404_800_500,
      "abc123",
    );
    expect(headers).toEqual({
      "X-Key-Id": "ak_klzcmzngbqjnfciylwkq52ebgy",
      "X-Timestamp": "1757404800",
      "X-Nonce": "abc123",
      "X-Signature": expect.stringMatching(/^[A-Za-z0-9+/]+=*$/),
    });
  });

  it("signs the empty body's hash when there is no body", () => {
    const emptyHash = createHash("sha256").update(new Uint8Array(0)).digest("hex");
    expect(canonical("GET", "/v1/bots", "", "1", "n", new Uint8Array(0)).toString("utf8")).toBe(
      `GET\n/v1/bots\n\n1\nn\n${emptyHash}`,
    );
  });

  it("uppercases the method and touches nothing else", () => {
    // No sorting of the query, no re-escaping of the path — whatever is sent is
    // what is signed, because that is the only version the caller can be sure of.
    const line = canonical("get", "/v1/trade/venues/binance_spot/ticker", "b=2&a=1", "1", "n", new Uint8Array(0));
    const lines = line.toString("utf8").split("\n");
    expect(lines[0]).toBe("GET");
    expect(lines[1]).toBe("/v1/trade/venues/binance_spot/ticker");
    expect(lines[2]).toBe("b=2&a=1");
  });
});
