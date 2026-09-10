import { createHash, createHmac, createPublicKey, timingSafeEqual, verify as verifyEd25519 } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An in-process stand-in for the published listener.
 *
 * It is not a stub. It rebuilds the canonical string from the request as it
 * arrived and refuses a signature that does not verify over it, exactly as
 * apps/api/internal/apikeys does — which is the only way a test of a signing
 * client can tell you anything. A stub that records headers would pass while the
 * client signed the wrong path.
 *
 * It also does the two things the real public listener does before routing: it
 * refuses a request with no X-Key-Id, and it drops any Authorization header.
 */

export type RecordedRequest = {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly body: string;
  readonly headers: Record<string, string>;
};

export type Route = {
  status?: number;
  body?: unknown;
  /** Set to answer with something other than JSON, e.g. an HTML error page. */
  raw?: string;
  /** Extra response headers, e.g. the edge's x-ratelimit-* counters. */
  headers?: Record<string, string>;
};

export type FakeApi = {
  readonly url: string;
  readonly requests: RecordedRequest[];
  /** Answers for "METHOD /v1/path"; anything unrouted is a 404. */
  route(key: string, route: Route): void;
  close(): Promise<void>;
};

const MAX_SKEW_SECONDS = 30;

export async function startFakeApi(credentials: {
  keyId: string;
  /** Base64 SPKI, as the dashboard shows an Ed25519 public key. */
  publicKey?: string;
  /** The DECODED HMAC secret. */
  secret?: Buffer;
  /** Scopes the key was granted; an endpoint outside them answers 403. */
  scopes?: readonly string[];
}): Promise<FakeApi> {
  const routes = new Map<string, Route>();
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const raw = req.url ?? "/";
      const questionMark = raw.indexOf("?");
      const path = questionMark === -1 ? raw : raw.slice(0, questionMark);
      const query = questionMark === -1 ? "" : raw.slice(questionMark + 1);

      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[name.toLowerCase()] = value;
      }
      requests.push({ method: req.method ?? "", path, query, body: body.toString("utf8"), headers });

      const fail = (status: number, error: string) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error }));
      };

      // The public listener admits a request only if it carries X-Key-Id, and
      // deletes any Authorization header before passing it on — so a leaked
      // browser token is inert here.
      const keyId = headers["x-key-id"];
      if (!keyId) return fail(401, "a signed request must carry X-Key-Id, X-Timestamp, X-Nonce and X-Signature");
      if (headers["authorization"]) return fail(500, "the listener should have deleted Authorization");
      if (keyId !== credentials.keyId) return fail(401, "no key with that id");

      const timestamp = headers["x-timestamp"] ?? "";
      const nonce = headers["x-nonce"] ?? "";
      const signature = headers["x-signature"] ?? "";
      if (!timestamp || !nonce || !signature) {
        return fail(401, "a signed request must carry X-Key-Id, X-Timestamp, X-Nonce and X-Signature");
      }
      const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
      if (!Number.isFinite(skew) || skew > MAX_SKEW_SECONDS) return fail(401, "X-Timestamp is outside the accepted skew");

      const canonical = Buffer.from(
        [
          (req.method ?? "").toUpperCase(),
          path,
          query,
          timestamp,
          nonce,
          createHash("sha256").update(body).digest("hex"),
        ].join("\n"),
        "utf8",
      );

      if (!verifySignature(canonical, signature, credentials)) {
        return fail(401, "X-Signature does not verify");
      }

      const key = `${req.method} ${path}`;
      const route = routes.get(key);
      if (!route) return fail(404, "not found");

      const status = route.status ?? 200;
      const extra = route.headers ?? {};
      if (status === 204) {
        res.writeHead(204, extra);
        return res.end();
      }
      if (route.raw !== undefined) {
        res.writeHead(status, { "content-type": "text/html", ...extra });
        return res.end(route.raw);
      }
      res.writeHead(status, { "content-type": "application/json", ...extra });
      res.end(JSON.stringify(route.body ?? {}));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    route: (key, route) => routes.set(key, route),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function verifySignature(
  canonical: Buffer,
  signature: string,
  credentials: { publicKey?: string; secret?: Buffer },
): boolean {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  if (credentials.secret) {
    const expected = createHmac("sha256", credentials.secret).update(canonical).digest();
    return decoded.length === expected.length && timingSafeEqual(decoded, expected);
  }
  if (credentials.publicKey) {
    const key = createPublicKey({ key: Buffer.from(credentials.publicKey, "base64"), format: "der", type: "spki" });
    return verifyEd25519(null, canonical, key, decoded);
  }
  return false;
}
