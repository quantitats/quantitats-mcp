import { readFileSync } from "node:fs";

import { ALGORITHMS, ed25519Signer, hmacSigner, type Alg, type Signer } from "./signing.ts";
import { SCOPES } from "./catalogue.ts";

/**
 * The server's whole configuration, read from the environment.
 *
 * Credentials never reach a command line: an argv is readable by every process
 * on the machine and lands in shell history, while an MCP client launches this
 * process with an env block of its own. So the key material is read from the
 * environment or, better, from a file the environment points at.
 */
export type Config = {
  readonly baseUrl: string;
  readonly keyId: string;
  readonly signer: Signer;
  readonly timeoutMs: number;
  readonly readOnly: boolean;
  /** Undefined advertises every tool and lets the server refuse what the key cannot reach. */
  readonly scopes?: readonly string[];
};

export const ENV = {
  baseUrl: "QUANTITATS_API_URL",
  keyId: "QUANTITATS_API_KEY_ID",
  alg: "QUANTITATS_API_ALG",
  privateKey: "QUANTITATS_API_PRIVATE_KEY",
  privateKeyFile: "QUANTITATS_API_PRIVATE_KEY_FILE",
  secret: "QUANTITATS_API_SECRET",
  secretFile: "QUANTITATS_API_SECRET_FILE",
  timeout: "QUANTITATS_API_TIMEOUT_MS",
  readOnly: "QUANTITATS_MCP_READ_ONLY",
  scopes: "QUANTITATS_MCP_SCOPES",
} as const;

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The hosted API, which is where a request goes unless told otherwise.
 *
 * An origin, not an address: every endpoint hangs off /v1, so what is actually
 * dialled and signed is https://api.quantitats.com/v1/bots and the rest. A
 * self-hosted or staging deployment sets QUANTITATS_API_URL to its own origin.
 */
export const DEFAULT_BASE_URL = "https://api.quantitats.com";

/** A configuration problem, phrased so the fix is in the message. */
export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function read(env: Env, name: string): string | undefined {
  const raw = env[name];
  const value = raw?.trim();
  return value ? value : undefined;
}

/**
 * Reads a value that may be given inline or as a path to a file holding it.
 * The file wins nothing over the inline form; naming both is a mistake worth
 * reporting rather than a precedence rule worth remembering.
 */
function readMaybeFile(env: Env, inlineVar: string, fileVar: string): string | undefined {
  const inline = read(env, inlineVar);
  const path = read(env, fileVar);
  if (inline && path) {
    throw new ConfigError(`set ${inlineVar} or ${fileVar}, not both`);
  }
  if (!path) return inline;
  try {
    const contents = readFileSync(path, "utf8").trim();
    if (!contents) throw new ConfigError(`${fileVar} points at ${path}, which is empty`);
    return contents;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`${fileVar} points at ${path}, which could not be read: ${(err as Error).message}`);
  }
}

/**
 * Chooses the signing primitive from what was supplied.
 *
 * Inferred when only one kind of key material is present, which is the ordinary
 * case; QUANTITATS_API_ALG settles it when both are, rather than this picking
 * one and leaving the caller to wonder which key is in use.
 */
function buildSigner(env: Env): Signer {
  const privateKey = readMaybeFile(env, ENV.privateKey, ENV.privateKeyFile);
  const secret = readMaybeFile(env, ENV.secret, ENV.secretFile);
  const declared = read(env, ENV.alg);

  if (declared && !(ALGORITHMS as readonly string[]).includes(declared)) {
    throw new ConfigError(`${ENV.alg} must be ${ALGORITHMS.map((a) => `"${a}"`).join(" or ")}`);
  }
  const alg = declared as Alg | undefined;

  if (!privateKey && !secret) {
    throw new ConfigError(
      `no key material: set ${ENV.privateKey} (or ${ENV.privateKeyFile}) for an Ed25519 key, ` +
        `or ${ENV.secret} (or ${ENV.secretFile}) for an HMAC key`,
    );
  }
  if (privateKey && secret && !alg) {
    throw new ConfigError(
      `both an Ed25519 private key and an HMAC secret are set; name the one to use in ${ENV.alg}`,
    );
  }

  const chosen: Alg = alg ?? (privateKey ? "Ed25519" : "HMAC-SHA256");
  if (chosen === "Ed25519") {
    if (!privateKey) throw new ConfigError(`${ENV.alg} is "Ed25519" but no ${ENV.privateKey} is set`);
    try {
      return ed25519Signer(privateKey);
    } catch (err) {
      throw new ConfigError(`${ENV.privateKey} is not a usable Ed25519 private key: ${(err as Error).message}`);
    }
  }
  if (!secret) throw new ConfigError(`${ENV.alg} is "HMAC-SHA256" but no ${ENV.secret} is set`);
  try {
    return hmacSigner(secret);
  } catch (err) {
    throw new ConfigError(`${ENV.secret} is not usable: ${(err as Error).message}`);
  }
}

function parseBoolean(raw: string | undefined, name: string): boolean {
  if (raw === undefined) return false;
  const value = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new ConfigError(`${name} must be true or false, not ${JSON.stringify(raw)}`);
}

function parseScopes(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const scopes = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (scopes.length === 0) return undefined;
  const unknown = scopes.filter((s) => !(SCOPES as readonly string[]).includes(s));
  if (unknown.length > 0) {
    throw new ConfigError(
      `${ENV.scopes} names ${unknown.map((s) => JSON.stringify(s)).join(", ")}, ` +
        `which ${unknown.length === 1 ? "is not a scope" : "are not scopes"} — the catalogue is ${SCOPES.join(", ")}`,
    );
  }
  return scopes;
}

/**
 * The base URL, normalised to an origin with no trailing slash. Absent means the
 * hosted API.
 *
 * The path is signed exactly as dialled, so a base carrying a path of its own
 * would put a segment in the URL that is not in the signed string — including
 * the /v1 the endpoints already carry. Refusing it here turns that into a
 * message at startup rather than a signature that never verifies.
 */
function parseBaseUrl(raw: string | undefined): string {
  if (!raw) return DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${ENV.baseUrl} is not a URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`${ENV.baseUrl} must be http or https, not ${url.protocol}`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new ConfigError(
      `${ENV.baseUrl} must be an origin with no path, e.g. ${DEFAULT_BASE_URL} — every endpoint already ` +
        `hangs off /v1, and a path here would not be part of the string a request is signed over`,
    );
  }
  return url.origin;
}

/** Reads and validates the whole configuration, or explains what is missing. */
export function loadConfig(env: Env = process.env): Config {
  const baseUrl = parseBaseUrl(read(env, ENV.baseUrl));

  const keyId = read(env, ENV.keyId);
  if (!keyId) throw new ConfigError(`${ENV.keyId} is required — the key id shown when the key was created`);

  const rawTimeout = read(env, ENV.timeout);
  const timeoutMs = rawTimeout === undefined ? DEFAULT_TIMEOUT_MS : Number(rawTimeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError(`${ENV.timeout} must be a positive number of milliseconds`);
  }

  const config: Config = {
    baseUrl,
    keyId,
    signer: buildSigner(env),
    timeoutMs,
    readOnly: parseBoolean(read(env, ENV.readOnly), ENV.readOnly),
  };
  const scopes = parseScopes(read(env, ENV.scopes));
  return scopes ? { ...config, scopes } : config;
}
