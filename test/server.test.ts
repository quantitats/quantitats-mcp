import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ENDPOINTS } from "../src/catalogue.ts";
import type { Config } from "../src/config.ts";
import { buildServer } from "../src/server.ts";
import { hmacSigner } from "../src/signing.ts";
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

async function connect(cfg: Config = config()): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([buildServer(cfg).connect(serverTransport), client.connect(clientTransport)]);
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
        side: "sell",
        type: "limit",
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

describe("what the server tells the model up front", () => {
  it("says prices are strings and that writes move real money", async () => {
    const client = await connect();
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/decimal strings/);
    expect(instructions).toMatch(/real money/);
  });
});
