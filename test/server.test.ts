import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ENDPOINTS } from "../src/catalogue.ts";
import type { Config } from "../src/config.ts";
import { BUCKETS, Limiter } from "../src/ratelimits.ts";
import { buildServer } from "../src/server.ts";
import { hmacSigner } from "../src/signing.ts";
import { VERSION } from "../src/version.ts";
import { startFakeApi, type FakeApi } from "./fake-api.ts";

/**
 * The whole path, end to end: a real MCP client calls a tool, the server signs a
 * request, and a server that really verifies signatures answers it. Nothing in
 * between is stubbed, so this is the test that would catch a tool whose schema
 * describes a request the client does not send.
 */

const KEY_ID = "ak_klzcmzngbqjnfciylwkq52ebgy";
const SECRET = randomBytes(32);

let api: FakeApi;

function config(overrides: Partial<Config> = {}): Config {
  return {
    baseUrl: api.url,
    keyId: KEY_ID,
    signer: hmacSigner(SECRET.toString("base64")),
    timeoutMs: 5_000,
    readOnly: false,
    ...overrides,
  };
}

async function connect(cfg: Config = config(), limiter?: Limiter): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([
    buildServer(cfg, globalThis.fetch, limiter).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

/**
 * The text of a tool result, which is where both answers and failures land.
 *
 * Typed loosely because callTool's result is a union that still carries the
 * legacy `toolResult` shape; narrowing it here keeps every call site readable.
 */
function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c as { text?: string }).text ?? "").join("\n");
}

beforeEach(async () => {
  api = await startFakeApi({ keyId: KEY_ID, secret: SECRET });
});

afterEach(async () => {
  await api.close();
});

describe("the tool manifest", () => {
  it("lists one tool per endpoint", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(ENDPOINTS.map((e) => e.name).sort());
  });

  it("gives every tool a schema, a title and the scope it costs", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.inputSchema, tool.name).toBeDefined();
      expect(tool.description, tool.name).toMatch(/Requires the/);
    }
  });

  it("spells every schema out inline, with no $ref a client would have to resolve", async () => {
    // One schema instance used twice in a tool is converted once and referenced
    // after that — a loss limit described as "#/properties/sim" — and not every
    // client follows a reference.
    const client = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain("$ref");
    }
  });

  it("marks reads as read-only and destructive writes as destructive", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("list_bots")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("place_order")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("cancel_orders")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("stop_bot")?.annotations?.destructiveHint).toBe(true);
    // A create makes a second thing rather than removing one.
    expect(byName.get("create_bot")?.annotations?.destructiveHint).toBe(false);
  });

  it("hides every write in read-only mode", async () => {
    const client = await connect(config({ readOnly: true }));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_bots");
    expect(names).not.toContain("place_order");
    expect(names).not.toContain("stop_bot");
    expect(names).not.toContain("cancel_orders");
  });

  it("advertises only what the stated scopes reach", async () => {
    const client = await connect(config({ scopes: ["portfolio:read"] }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["get_venue_balances", "list_balances", "list_positions", "list_streams"].sort(),
    );
  });
});

describe("calling a tool", () => {
  it("returns the endpoint's JSON", async () => {
    api.route("GET /v1/bots", { body: { bots: [{ name: "alpha", mode: "paper" }], summary: { live: 0 } } });
    const client = await connect();
    const result = await client.callTool({ name: "list_bots", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({ bots: [{ name: "alpha", mode: "paper" }], summary: { live: 0 } });
  });

  it("signs a request the server accepts, with the arguments in the right places", async () => {
    api.route("POST /v1/trade/orders", { body: { clientOrderId: "c-1", status: "open" } });
    const client = await connect();
    const result = await client.callTool({
      name: "place_order",
      arguments: {
        exchange: "binance_perpetual",
        symbol: "BTCUSDT",
        side: "SELL",
        type: "LIMIT",
        quantity: "0.5",
        price: "61000",
        reduceOnly: true,
      },
    });
    expect(result.isError).toBeFalsy();

    const sent = api.requests.at(-1);
    expect(sent?.method).toBe("POST");
    expect(sent?.path).toBe("/v1/trade/orders");
    expect(JSON.parse(sent?.body ?? "")).toMatchObject({ exchange: "binance_perpetual", reduceOnly: true });
  });

  it("places an order that needs a trigger price, which market and limit alone could not", async () => {
    api.route("POST /v1/trade/orders", { status: 201, body: { order: { clientOrderId: "c-2" } } });
    const client = await connect();
    const result = await client.callTool({
      name: "place_order",
      arguments: {
        exchange: "binance_spot",
        symbol: "BTCUSDT",
        side: "SELL",
        type: "STOP_LOSS_LIMIT",
        quantity: "0.01",
        price: "58000",
        stopPrice: "58500",
        timeInForce: "GTC",
      },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(api.requests.at(-1)?.body ?? "")).toMatchObject({
      type: "STOP_LOSS_LIMIT",
      stopPrice: "58500",
      timeInForce: "GTC",
    });
  });

  it("refuses a lower-case side before dialling, rather than sending one a filter would 400", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "list_orders", arguments: { side: "buy" } });
    expect(result.isError).toBe(true);
    expect(api.requests).toHaveLength(0);
  });

  it("stops a bot by the name the API stores, whatever spelling the model used", async () => {
    // The API answers a stop for a name it cannot form with 204 and does nothing,
    // so the spelling a model typed would report success on a bot still trading.
    api.route("DELETE /v1/bots/alpha", { status: 204 });
    const client = await connect();
    const result = await client.callTool({ name: "stop_bot", arguments: { name: " Alpha " } });
    expect(result.isError).toBeFalsy();
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["DELETE /v1/bots/alpha"]);
  });

  it("sends update_script's name in the body as well as the path", async () => {
    api.route("PUT /v1/scripts/grid", { body: { name: "grid" } });
    const client = await connect();
    const result = await client.callTool({ name: "update_script", arguments: { name: "grid", script: "return 1" } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(api.requests.at(-1)?.body ?? "")).toEqual({ name: "grid", script: "return 1" });
  });

  it("sends no filters to list_open_orders, whose route reads none", async () => {
    api.route("GET /v1/trade/orders/open", { body: { orders: [] } });
    const client = await connect();
    const result = await client.callTool({ name: "list_open_orders", arguments: { symbol: "BTCUSDT", side: "BUY" } });
    expect(result.isError).toBeFalsy();
    expect(api.requests.at(-1)?.query).toBe("");
  });

  it("sends a time window on one bot's orders", async () => {
    api.route("GET /v1/bots/alpha/orders", { body: { orders: [] } });
    const client = await connect();
    const result = await client.callTool({
      name: "list_bot_orders",
      arguments: { name: "alpha", status: "FILLED", since: "2026-09-01T00:00:00Z", until: "2026-09-08T00:00:00Z" },
    });
    expect(result.isError).toBeFalsy();
    expect(Object.fromEntries(new URLSearchParams(api.requests.at(-1)?.query))).toEqual({
      status: "FILLED",
      since: "2026-09-01T00:00:00Z",
      until: "2026-09-08T00:00:00Z",
    });
  });

  it("accepts a loss limit as a bare number, which the API takes as well as the object form", async () => {
    api.route("PUT /v1/bots/alpha/config", { body: { killSwitch: 250 } });
    const client = await connect();
    const result = await client.callTool({
      name: "update_bot_config",
      arguments: { name: "alpha", config: {}, killSwitch: 250 },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(api.requests.at(-1)?.body ?? "")).toEqual({ config: {}, killSwitch: 250 });
  });

  it("reports a 204 as done rather than as empty JSON", async () => {
    api.route("DELETE /v1/bots/alpha", { status: 204 });
    const client = await connect();
    const result = await client.callTool({ name: "stop_bot", arguments: { name: "alpha" } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/stop_bot: done \(HTTP 204\)/);
  });

  it("turns a refusal into an error the model can read, not a thrown exception", async () => {
    api.route("POST /v1/bots", { status: 403, body: { error: "your plan allows 2 live bots" } });
    const client = await connect();
    const result = await client.callTool({
      name: "create_bot",
      arguments: { name: "beta", script: "s", exchanges: ["binance_spot"], mode: "live" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/your plan allows 2 live bots/);
  });

  it("refuses a venue id that is not one, before dialling anything", async () => {
    // A near miss resolves to nothing at all, silently, so the schema catches it
    // here rather than letting the request go and reading a 404.
    const client = await connect();
    const result = await client.callTool({ name: "get_ticker", arguments: { venue: "binance", symbol: "BTCUSDT" } });
    expect(result.isError).toBe(true);
    expect(api.requests).toHaveLength(0);
  });

  it("refuses a tool that read-only mode hid", async () => {
    const client = await connect(config({ readOnly: true }));
    const result = await client.callTool({ name: "place_order", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/place_order not found/);
    expect(api.requests).toHaveLength(0);
  });

  it("sends no Authorization header — a browser token is inert on this path", async () => {
    api.route("GET /v1/bots", { body: {} });
    const client = await connect();
    await client.callTool({ name: "list_bots", arguments: {} });
    expect(api.requests.at(-1)?.headers["authorization"]).toBeUndefined();
  });
});

describe("what a model is told about rate limits", () => {
  it("states every tool's own limit in its description", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? ""]));
    // Three orders of magnitude apart, and a model that has to guess which tool
    // is which will guess wrong about the tightest one.
    expect(byName.get("get_ticker")).toMatch(/60 requests per hour/);
    expect(byName.get("place_order")).toMatch(/932 requests per minute/);
    expect(byName.get("create_bot")).toMatch(/30 requests per minute/);
    expect(byName.get("list_bots")).toMatch(/600 requests per minute/);
    for (const tool of tools) {
      expect(tool.description, tool.name).toMatch(/Rate limit: \d+ requests per (minute|hour)/);
    }
  });

  it("says what to do instead of pushing at a limit", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const ticker = tools.find((t) => t.name === "get_ticker")?.description ?? "";
    expect(ticker).toMatch(/read the venue's own public API/);
  });

  it("warns in the instructions that the limits differ, so nothing is polled", async () => {
    const client = await connect();
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/rate limited per key/);
    expect(instructions).toMatch(/do not poll/);
  });

  it("appends what is left of the window when it is worth acting on", async () => {
    api.route("GET /v1/bots", {
      body: { bots: [] },
      headers: { "x-ratelimit-limit": "600", "x-ratelimit-remaining": "9", "x-ratelimit-reset": "12" },
    });
    const client = await connect();
    const result = await client.callTool({ name: "list_bots", arguments: {} });
    expect(textOf(result)).toMatch(/9 of 600 left in this window for the default group, resetting in 12s/);
  });

  it("stays quiet while there is plenty left", async () => {
    // A note on every call trains a reader to skip the line, and then the one
    // that matters is skipped too.
    api.route("GET /v1/bots", {
      body: { bots: [] },
      headers: { "x-ratelimit-limit": "600", "x-ratelimit-remaining": "580" },
    });
    const client = await connect();
    expect(textOf(await client.callTool({ name: "list_bots", arguments: {} }))).not.toMatch(/Rate limit:/);
  });

  it("refuses locally, saying nothing was spent and how long to wait", async () => {
    api.route("GET /v1/trade/venues/binance_spot/instruments", { body: { instruments: [] } });
    const limiter = new Limiter();
    for (let i = 0; i < BUCKETS.venuePublic.limit; i++) limiter.take(BUCKETS.venuePublic);

    const client = await connect(config(), limiter);
    const result = await client.callTool({ name: "list_instruments", arguments: { venue: "binance_spot" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/was not sent.*Nothing was spent/s);
    expect(api.requests).toHaveLength(0);
  });

  it("shares one budget across the tools the edge meters together", async () => {
    api.route("GET /v1/trade/venues/binance_spot/ticker", { body: { last: "1" } });
    const limiter = new Limiter();
    for (let i = 0; i < BUCKETS.venuePublic.limit; i++) limiter.take(BUCKETS.venuePublic);

    const client = await connect(config(), limiter);
    // Spent by list_instruments above; get_ticker is metered in the same bucket.
    const result = await client.callTool({
      name: "get_ticker",
      arguments: { venue: "binance_spot", symbol: "BTCUSDT" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/venue-public/);
  });
});

describe("what the server tells the model up front", () => {
  it("reports the build's version, not a hardcoded one", async () => {
    const client = await connect();
    expect(client.getServerVersion()?.version).toBe(VERSION);
    expect(client.getServerVersion()?.name).toBe("quantitats");
  });

  it("says prices are strings and that writes move real money", async () => {
    const client = await connect();
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/decimal strings/);
    expect(instructions).toMatch(/real money/);
  });
});
