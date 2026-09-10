import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { endpointNamed, type Endpoint } from "../src/catalogue.ts";
import { call, prepare, RequestError } from "../src/client.ts";
import type { Config } from "../src/config.ts";
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
      side: "buy",
      type: "limit",
      quantity: "0.001",
      price: "60000",
    });
    expect(response.data).toEqual({ clientOrderId: "c-1" });

    const sent = api.requests.at(-1);
    expect(sent?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(sent?.body ?? "")).toEqual({
      exchange: "binance_spot",
      symbol: "BTCUSDT",
      side: "buy",
      type: "limit",
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
