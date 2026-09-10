import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ConfigError, DEFAULT_TIMEOUT_MS, ENV, loadConfig } from "../src/config.ts";

const SECRET = randomBytes(32).toString("base64");
const { privateKey } = generateKeyPairSync("ed25519");
const PEM = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

/** A minimal working environment, which each test then breaks in one way. */
function env(overrides: Record<string, string | undefined> = {}) {
  return {
    [ENV.baseUrl]: "https://api.example.com",
    [ENV.keyId]: "ak_klzcmzngbqjnfciylwkq52ebgy",
    [ENV.secret]: SECRET,
    ...overrides,
  };
}

function tempFile(name: string, contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "quantitats-mcp-")), name);
  writeFileSync(path, contents);
  return path;
}

describe("loadConfig", () => {
  it("reads a working HMAC configuration", () => {
    const config = loadConfig(env());
    expect(config.baseUrl).toBe("https://api.example.com");
    expect(config.keyId).toBe("ak_klzcmzngbqjnfciylwkq52ebgy");
    expect(config.signer.alg).toBe("HMAC-SHA256");
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(config.readOnly).toBe(false);
    expect(config.scopes).toBeUndefined();
  });

  it("infers Ed25519 from a private key alone", () => {
    const config = loadConfig(env({ [ENV.secret]: undefined, [ENV.privateKey]: PEM }));
    expect(config.signer.alg).toBe("Ed25519");
  });

  it("reads key material from a file the environment points at", () => {
    // Better than the inline form: a private key in an env block is readable by
    // anything that can see the process, and turns up in whatever launched it.
    const config = loadConfig(
      env({ [ENV.secret]: undefined, [ENV.privateKeyFile]: tempFile("api-key.pem", PEM) }),
    );
    expect(config.signer.alg).toBe("Ed25519");
  });

  it("reads an HMAC secret from a file too", () => {
    const config = loadConfig(env({ [ENV.secret]: undefined, [ENV.secretFile]: tempFile("secret", SECRET) }));
    expect(config.signer.alg).toBe("HMAC-SHA256");
  });

  it("asks which to use when both kinds of key material are present", () => {
    expect(() => loadConfig(env({ [ENV.privateKey]: PEM }))).toThrow(/name the one to use/);
  });

  it("settles that ambiguity from the declared algorithm", () => {
    expect(loadConfig(env({ [ENV.privateKey]: PEM, [ENV.alg]: "Ed25519" })).signer.alg).toBe("Ed25519");
    expect(loadConfig(env({ [ENV.privateKey]: PEM, [ENV.alg]: "HMAC-SHA256" })).signer.alg).toBe("HMAC-SHA256");
  });

  it("says what to set when there is no key material at all", () => {
    expect(() => loadConfig(env({ [ENV.secret]: undefined }))).toThrow(/no key material/);
  });

  it("refuses an inline value and a file for the same thing", () => {
    expect(() => loadConfig(env({ [ENV.secretFile]: tempFile("s", SECRET) }))).toThrow(/not both/);
  });

  it("names the file when it cannot be read", () => {
    expect(() =>
      loadConfig(env({ [ENV.secret]: undefined, [ENV.secretFile]: "/nowhere/at/all" })),
    ).toThrow(/\/nowhere\/at\/all/);
  });

  it("rejects an unusable private key with a message naming the variable", () => {
    expect(() => loadConfig(env({ [ENV.secret]: undefined, [ENV.privateKey]: "not a pem" }))).toThrow(
      new RegExp(ENV.privateKey),
    );
  });

  it("rejects a secret that is not base64", () => {
    expect(() => loadConfig(env({ [ENV.secret]: "not base64!!" }))).toThrow(/not usable/);
  });
});

describe("the base URL", () => {
  it("is required", () => {
    expect(() => loadConfig(env({ [ENV.baseUrl]: undefined }))).toThrow(new RegExp(ENV.baseUrl));
  });

  it("is normalised to an origin", () => {
    expect(loadConfig(env({ [ENV.baseUrl]: "https://api.example.com/" })).baseUrl).toBe("https://api.example.com");
  });

  it("refuses a base carrying a path", () => {
    // A path here would put a segment in the dialled URL that is not in the
    // signed string, so this is a message at startup rather than a signature
    // that never verifies.
    expect(() => loadConfig(env({ [ENV.baseUrl]: "https://api.example.com/v1" }))).toThrow(/no path/);
  });

  it("refuses a scheme that is not http or https", () => {
    expect(() => loadConfig(env({ [ENV.baseUrl]: "ws://api.example.com" }))).toThrow(/http or https/);
  });

  it("refuses text that is not a URL", () => {
    expect(() => loadConfig(env({ [ENV.baseUrl]: "api.example.com" }))).toThrow(/not a URL/);
  });
});

describe("the optional narrowings", () => {
  it("reads read-only mode from any of the usual spellings", () => {
    for (const value of ["true", "1", "yes", "on", "TRUE"]) {
      expect(loadConfig(env({ [ENV.readOnly]: value })).readOnly).toBe(true);
    }
    for (const value of ["false", "0", "no", "off"]) {
      expect(loadConfig(env({ [ENV.readOnly]: value })).readOnly).toBe(false);
    }
  });

  it("refuses a value that is neither", () => {
    expect(() => loadConfig(env({ [ENV.readOnly]: "maybe" }))).toThrow(/must be true or false/);
  });

  it("splits scopes on commas or spaces", () => {
    expect(loadConfig(env({ [ENV.scopes]: "bots:read, trade:read" })).scopes).toEqual(["bots:read", "trade:read"]);
    expect(loadConfig(env({ [ENV.scopes]: "bots:read trade:read" })).scopes).toEqual(["bots:read", "trade:read"]);
  });

  it("names a scope it does not recognise, and the catalogue", () => {
    expect(() => loadConfig(env({ [ENV.scopes]: "bots:read,bots:admin" }))).toThrow(
      /"bots:admin".*the catalogue is bots:read/s,
    );
  });

  it("treats an empty list as unstated, which advertises everything", () => {
    expect(loadConfig(env({ [ENV.scopes]: "  " })).scopes).toBeUndefined();
  });
});

describe("the timeout", () => {
  it("takes a positive number of milliseconds", () => {
    expect(loadConfig(env({ [ENV.timeout]: "5000" })).timeoutMs).toBe(5000);
  });

  it("refuses zero, a negative and a non-number", () => {
    for (const value of ["0", "-1", "soon"]) {
      expect(() => loadConfig(env({ [ENV.timeout]: value }))).toThrow(/positive number/);
    }
  });
});

describe("a configuration failure", () => {
  it("is a ConfigError, so the entrypoint can print it without a stack", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });
});
