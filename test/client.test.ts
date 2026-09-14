import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { endpointNamed, ENDPOINTS, type Endpoint } from "../src/catalogue.ts";
import { call, prepare, RateLimitedLocally, RequestError } from "../src/client.ts";
import { DEFAULT_BASE_URL, type Config } from "../src/config.ts";
import { BUCKETS, Limiter } from "../src/ratelimits.ts";
import { hmacSigner } from "../src/signing.ts";
import { startFakeApi, type FakeApi } from "./fake-api.ts";

const KEY_ID = "ak_klzcmzngbqjnfciylwkq52ebgy";
const SECRET = randomBytes(32);

let api: FakeApi;
let config: Config;

beforeEach(async () => {
  api = await startFakeApi({ keyId: KEY_ID, secret: SECRET });
  config = {
    baseUrl: api.url,
    keyId: KEY_ID,
    signer: hmacSigner(SECRET.toString("base64")),
    timeoutMs: 5_000,
    readOnly: false,
  };
});

afterEach(async () => {
  await api.close();
});

/** The endpoint by tool name, or a failure naming it — the catalogue is the fixture. */
function endpoint(name: string): Endpoint {
  const found = endpointNamed(name);
  if (!found) throw new Error(`no endpoint named ${name}`);
  return found;
}

describe("prepare", () => {
  it("fills path parameters and leaves the rest to query and body", () => {
    const prepared = prepare(endpoint("get_ticker"), { venue: "binance_spot", symbol: "BTCUSDT" });
    expect(prepared).toEqual({
      method: "GET",
      path: "/v1/trade/venues/binance_spot/ticker",
      query: "symbol=BTCUSDT",
      body: new Uint8Array(0),
    });
  });

  it("escapes a path parameter rather than letting it address another route", () => {
    // A bot name is the caller's text. An unescaped "/" would silently dial a
    // different path than the arguments describe — and sign that one too.
    const prepared = prepare(endpoint("get_bot_config"), { name: "a/b" });
    expect(prepared.path).toBe("/v1/bots/a%2Fb/config");
  });

  it("refuses a missing path parameter instead of dialling undefined", () => {
    expect(() => prepare(endpoint("stop_bot"), {})).toThrow(/needs name/);
  });

  it("drops absent query arguments rather than sending them empty", () => {
    const prepared = prepare(endpoint("cancel_orders"), { origin: "manual", symbol: undefined });
    expect(prepared.query).toBe("origin=manual");
  });

  it("puts only body arguments in the body", () => {
    const prepared = prepare(endpoint("update_bot_config"), { name: "alpha", config: { size: 2 } });
    expect(prepared.path).toBe("/v1/bots/alpha/config");
    expect(JSON.parse(new TextDecoder().decode(prepared.body))).toEqual({ config: { size: 2 } });
  });

  it("sends update_script's name in the path and the body, which the API refuses without", () => {
    const prepared = prepare(endpoint("update_script"), { name: "BTC Grid", script: "return 1" });
    expect(prepared.path).toBe("/v1/scripts/BTC%20Grid");
    expect(JSON.parse(new TextDecoder().decode(prepared.body))).toEqual({ name: "BTC Grid", script: "return 1" });
  });
});

describe("the address a request is dialled at", () => {
  /** The URL this client builds, assembled the way call() assembles it. */
  function address(name: string, args: Record<string, unknown> = {}): string {
    const prepared = prepare(endpoint(name), args);
    return DEFAULT_BASE_URL + prepared.path + (prepared.query ? "?" + prepared.query : "");
  }

  it("is the published one", () => {
    expect(address("list_bots")).toBe("https://api.quantitats.com/v1/bots");
    expect(address("list_positions")).toBe("https://api.quantitats.com/v1/positions");
    expect(address("get_bot_config", { name: "alpha" })).toBe("https://api.quantitats.com/v1/bots/alpha/config");
    expect(address("get_ticker", { venue: "binance_spot", symbol: "BTCUSDT" })).toBe(
      "https://api.quantitats.com/v1/trade/venues/binance_spot/ticker?symbol=BTCUSDT",
    );
  });

  it("puts every endpoint under /v1 and nothing under /api", () => {
    // /api is the internal prefix and is never what a caller dials or signs.
    for (const endpoint of ENDPOINTS) {
      const dialled = DEFAULT_BASE_URL + endpoint.path;
      expect(dialled, endpoint.name).toMatch(/^https:\/\/api\.quantitats\.com\/v1\//);
      expect(dialled, endpoint.name).not.toContain("/api/");
    }
  });

  it("signs the same path it dials", async () => {
    // The two are one string here, which is the property the whole scheme rests
    // on: the fake rebuilds the canonical string from the path it received, so a
    // mismatch is a refused signature rather than a passing test.
    api.route("GET /v1/bots/alpha/analytics", { body: { realized: "0" } });
    await call(config, endpoint("get_bot_analytics"), { name: "alpha" });
    expect(api.requests.at(-1)?.path).toBe("/v1/bots/alpha/analytics");
  });
});

describe("call", () => {
  it("signs a GET that the server verifies", async () => {
    api.route("GET /v1/bots", { body: { bots: [{ name: "alpha" }] } });
    const response = await call(config, endpoint("list_bots"), {});
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ bots: [{ name: "alpha" }] });
  });

  it("signs the exact bytes it sends for a POST", async () => {
    // The property worth having: the server rebuilds the canonical string from
    // the body it received, so a body re-serialised between signing and sending
    // would be refused here rather than passing quietly.
    api.route("POST /v1/trade/orders", { body: { clientOrderId: "c-1" } });
    const response = await call(config, endpoint("place_order"), {
      exchange: "binance_spot",
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      quantity: "0.001",
      price: "60000",
    });
    expect(response.data).toEqual({ clientOrderId: "c-1" });

    const sent = api.requests.at(-1);
    expect(sent?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(sent?.body ?? "")).toEqual({
      exchange: "binance_spot",
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      quantity: "0.001",
      price: "60000",
    });
  });

  it("signs the query string it dials", async () => {
    api.route("GET /v1/trade/orders", { body: { orders: [] } });
    await call(config, endpoint("list_orders"), { symbol: "BTCUSDT", limit: 10 });
    const sent = api.requests.at(-1);
    expect(sent?.query).toBe("symbol=BTCUSDT&limit=10");
  });

  it("signs a time window on one bot's analytics, which the API reads", async () => {
    api.route("GET /v1/bots/alpha/analytics", { body: { summary: {}, series: [] } });
    await call(config, endpoint("get_bot_analytics"), {
      name: "alpha",
      since: "2026-09-01T00:00:00Z",
      until: "2026-09-08T00:00:00Z",
    });
    const sent = api.requests.at(-1);
    expect(Object.fromEntries(new URLSearchParams(sent?.query))).toEqual({
      since: "2026-09-01T00:00:00Z",
      until: "2026-09-08T00:00:00Z",
    });
  });

  it("sends no Content-Type when there is no body", async () => {
    api.route("DELETE /v1/bots/alpha", { status: 204 });
    await call(config, endpoint("stop_bot"), { name: "alpha" });
    expect(api.requests.at(-1)?.headers["content-type"]).toBeUndefined();
  });

  it("answers a 204 with no data rather than a parse failure", async () => {
    api.route("DELETE /v1/trade/orders/c-1", { status: 204 });
    const response = await call(config, endpoint("cancel_order"), { clientOrderId: "c-1" });
    expect(response).toEqual({ status: 204, data: null });
  });

  it("uses a fresh nonce for every request", async () => {
    api.route("GET /v1/bots", { body: {} });
    await call(config, endpoint("list_bots"), {});
    await call(config, endpoint("list_bots"), {});
    const [first, second] = api.requests;
    expect(first?.headers["x-nonce"]).not.toBe(second?.headers["x-nonce"]);
  });

  it("is refused when the key material is wrong", async () => {
    const wrong: Config = { ...config, signer: hmacSigner(randomBytes(32).toString("base64")) };
    api.route("GET /v1/bots", { body: {} });
    await expect(call(wrong, endpoint("list_bots"), {})).rejects.toThrow(/does not verify/);
  });
});

describe("rate limits", () => {
  it("reports what the edge said is left of the window", async () => {
    api.route("GET /v1/bots", {
      body: { bots: [] },
      headers: { "x-ratelimit-limit": "600", "x-ratelimit-remaining": "12", "x-ratelimit-reset": "37" },
    });
    const response = await call(config, endpoint("list_bots"), {});
    expect(response.rateLimit).toEqual({ limit: 600, remaining: 12, resetSeconds: 37 });
  });

  it("says nothing when the route is not metered", async () => {
    api.route("GET /v1/bots", { body: { bots: [] } });
    expect((await call(config, endpoint("list_bots"), {})).rateLimit).toBeUndefined();
  });

  it("drops an unparseable header rather than reporting it as zero", async () => {
    // "0 remaining" would tell a model to stop for a reason that is not true.
    api.route("GET /v1/bots", { body: {}, headers: { "x-ratelimit-remaining": "soon" } });
    expect((await call(config, endpoint("list_bots"), {})).rateLimit).toBeUndefined();
  });

  it("tells a 429 how long to wait", async () => {
    api.route("GET /v1/trade/venues/binance_spot/ticker", {
      status: 429,
      body: { error: "too many market-data requests — this endpoint serves a cached copy" },
      headers: { "x-ratelimit-reset": "1800" },
    });
    await expect(
      call(config, endpoint("get_ticker"), { venue: "binance_spot", symbol: "BTCUSDT" }),
    ).rejects.toThrow(/serves a cached copy.*window resets in 1800s/s);
  });

  it("refuses locally once its own budget is spent, without sending anything", async () => {
    api.route("GET /v1/trade/venues/binance_spot/instruments", { body: { instruments: [] } });
    const limiter = new Limiter();
    for (let i = 0; i < BUCKETS.venuePublic.limit; i++) {
      await call(config, endpoint("list_instruments"), { venue: "binance_spot" }, globalThis.fetch, limiter);
    }
    const sentSoFar = api.requests.length;
    expect(sentSoFar).toBe(BUCKETS.venuePublic.limit);

    const failure = await call(
      config,
      endpoint("list_instruments"),
      { venue: "binance_spot" },
      globalThis.fetch,
      limiter,
    ).catch((e) => e);
    expect(failure).toBeInstanceOf(RateLimitedLocally);
    expect((failure as RateLimitedLocally).bucket).toBe("venue-public");
    expect((failure as RateLimitedLocally).retryAfterSeconds).toBeGreaterThan(0);
    // Nothing was spent: the whole point of counting locally.
    expect(api.requests).toHaveLength(sentSoFar);
  });

  it("counts a tool against the bucket its own path is metered in", async () => {
    // list_venues is in the read bucket, so exhausting the market-data one must
    // not stop it — the two are different rules at the edge.
    api.route("GET /v1/trade/venues", { body: { venues: [] } });
    const limiter = new Limiter();
    for (let i = 0; i < BUCKETS.venuePublic.limit; i++) limiter.take(BUCKETS.venuePublic);
    const response = await call(config, endpoint("list_venues"), {}, globalThis.fetch, limiter);
    expect(response.status).toBe(200);
  });
});

describe("errors", () => {
  it("leads with the server's own message and explains the status", async () => {
    api.route("POST /v1/bots", { status: 403, body: { error: "your plan allows 2 live bots" } });
    await expect(
      call(config, endpoint("create_bot"), { name: "b", script: "s", exchanges: ["binance_spot"] }),
    ).rejects.toThrow(/your plan allows 2 live bots \(HTTP 403: the key is missing the scope/);
  });

  it("distinguishes a 404 from a refusal", async () => {
    await expect(call(config, endpoint("list_positions"), {})).rejects.toThrow(
      /HTTP 404: .*deployment does not serve that endpoint/,
    );
  });

  it("says a deployment with no stream list has no list, not that a stream is missing", async () => {
    // The list is only mounted where live streams are offered to keys, so there
    // is no resource behind it to be "not found".
    const failure = await call(config, endpoint("list_streams"), {}).catch((e) => e);
    expect(failure).toBeInstanceOf(RequestError);
    expect((failure as RequestError).message).toBe("not found (HTTP 404: no stream list is available on this deployment)");
  });

  it("carries the status on the error for a caller that wants to branch", async () => {
    api.route("POST /v1/scripts", { status: 409, body: { error: "that name is taken" } });
    const failure = await call(config, endpoint("create_script"), { name: "s", script: "x" }).catch((e) => e);
    expect(failure).toBeInstanceOf(RequestError);
    expect((failure as RequestError).status).toBe(409);
  });

  it("shows a non-JSON body verbatim rather than replacing it with a parse error", async () => {
    // An HTML error page from something in front of the API is worth seeing.
    api.route("GET /v1/bots", { status: 502, raw: "<html>gateway</html>" });
    await expect(call(config, endpoint("list_bots"), {})).rejects.toThrow(/<html>gateway<\/html>/);
  });

  it("reports a timeout as one", async () => {
    const slow: Config = { ...config, timeoutMs: 1 };
    api.route("GET /v1/bots", { body: {} });
    await expect(
      call(slow, endpoint("list_bots"), {}, ((...args: Parameters<typeof fetch>) =>
        new Promise((_, reject) => {
          const signal = (args[1] as RequestInit).signal;
          signal?.addEventListener("abort", () => reject(signal.reason));
        })) as typeof fetch),
    ).rejects.toThrow(/timed out after 1ms/);
  });
});
