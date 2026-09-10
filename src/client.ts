import type { Endpoint } from "./catalogue.ts";
import type { Config } from "./config.ts";
import { signedHeaders } from "./signing.ts";

/**
 * The signed HTTP client.
 *
 * One function's worth of real work: turn an endpoint and its arguments into a
 * method, a path, a query and a body; sign exactly those; send exactly those.
 * The order matters and is the whole contract — the bytes that are hashed are
 * the bytes that are sent, because re-serialising a body between signing it and
 * sending it is the classic way to break a signature.
 */

/** What one endpoint's arguments resolve to before anything is signed. */
export type PreparedRequest = {
  readonly method: string;
  /** The public path, dialled and signed identically. */
  readonly path: string;
  /** The raw query string, without the "?", exactly as it will be sent. */
  readonly query: string;
  readonly body: Uint8Array;
};

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly url: string,
  ) {
    super(detail);
  }
}

/**
 * Fills an endpoint's path template and splits the rest of the arguments into
 * query and body.
 *
 * Path parameters are the arguments named in neither `query` nor `body`, and a
 * template placeholder with no argument is a bug in the catalogue rather than a
 * request to send — so it throws instead of dialling "/v1/bots/undefined".
 */
export function prepare(endpoint: Endpoint, args: Record<string, unknown>): PreparedRequest {
  const queryNames = new Set(endpoint.query ?? []);
  const bodyNames = new Set(endpoint.body ?? []);

  const path = endpoint.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = args[name];
    if (value === undefined || value === null || value === "") {
      throw new RequestError(0, `${endpoint.name} needs ${name}`, endpoint.path);
    }
    // Encoded because a name is the caller's text and a path is a signed line:
    // an unescaped "/" would silently address a different route than the one the
    // arguments describe.
    return encodeURIComponent(String(value));
  });

  const query = new URLSearchParams();
  for (const name of queryNames) {
    const value = args[name];
    if (value === undefined || value === null || value === "") continue;
    query.set(name, String(value));
  }

  let body = new Uint8Array(0);
  if (bodyNames.size > 0) {
    const payload: Record<string, unknown> = {};
    for (const name of bodyNames) {
      const value = args[name];
      if (value !== undefined) payload[name] = value;
    }
    if (Object.keys(payload).length > 0 || endpoint.method === "POST" || endpoint.method === "PUT") {
      body = new TextEncoder().encode(JSON.stringify(payload));
    }
  }

  return { method: endpoint.method, path, query: query.toString(), body };
}

/** What an endpoint answered with, decoded if it was JSON. */
export type Response = { readonly status: number; readonly data: unknown };

export type Fetch = typeof globalThis.fetch;

/**
 * Calls one endpoint.
 *
 * `fetchImpl` is injected so the tests can drive a real in-process server rather
 * than a stub — the point of testing a signing client is that the signature
 * verifies on the other side, which a stub cannot tell you.
 */
export async function call(
  config: Config,
  endpoint: Endpoint,
  args: Record<string, unknown>,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<Response> {
  const prepared = prepare(endpoint, args);
  const headers: Record<string, string> = signedHeaders(
    config.signer,
    config.keyId,
    prepared.method,
    prepared.path,
    prepared.query,
    prepared.body,
  );
  if (prepared.body.length > 0) headers["Content-Type"] = "application/json";

  const url = config.baseUrl + prepared.path + (prepared.query ? "?" + prepared.query : "");

  let response: Awaited<ReturnType<Fetch>>;
  try {
    response = await fetchImpl(url, {
      method: prepared.method,
      headers,
      ...(prepared.body.length > 0 ? { body: prepared.body } : {}),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    const cause = err as Error;
    const detail =
      cause.name === "TimeoutError" || cause.name === "AbortError"
        ? `the request timed out after ${config.timeoutMs}ms`
        : `the request could not be sent: ${cause.message}`;
    throw new RequestError(0, detail, url);
  }

  // 204 is the shape a cancel answers with, and has no body to parse.
  const text = response.status === 204 ? "" : await response.text();
  let data: unknown = text === "" ? null : text;
  if (text !== "") {
    try {
      data = JSON.parse(text);
    } catch {
      // Left as text. An HTML error page from something in front of the API is
      // worth showing verbatim rather than replacing with a parse error.
    }
  }

  if (!response.ok) {
    throw new RequestError(response.status, explain(response.status, data), url);
  }
  return { status: response.status, data };
}

/**
 * Turns a failure into a sentence a model can act on.
 *
 * The server's own message leads, because it is the specific one — it names the
 * plan limit that was reached, or the field that was rejected. The added line
 * explains the status where the status alone is misleading: a 403 here is
 * usually a scope the key was never granted rather than anything to do with what
 * the account is allowed to do, and a 404 is as often an endpoint this
 * deployment does not serve as it is a missing bot.
 */
function explain(status: number, data: unknown): string {
  const server =
    data !== null && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
      ? (data as { error: string }).error
      : typeof data === "string" && data.trim() !== ""
        ? data.trim()
        : "";

  const hint = (() => {
    switch (status) {
      case 400:
        return "the request was rejected as malformed";
      case 401:
        return "the signature was not accepted — check the key id, the clock, and that an HMAC secret is decoded from base64 before signing";
      case 403:
        return "the key is missing the scope this endpoint needs, or the endpoint cannot be used with an API key at all";
      case 404:
        return "no such resource, or this deployment does not serve that endpoint";
      case 409:
        return "that name is already in use";
      case 429:
        return "too many requests";
      default:
        return status >= 500 ? "the server failed to handle the request" : `the request failed with status ${status}`;
    }
  })();

  return server ? `${server} (HTTP ${status}: ${hint})` : `HTTP ${status}: ${hint}`;
}
