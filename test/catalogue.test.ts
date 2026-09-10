import { describe, expect, it } from "vitest";

import { ENDPOINTS, SCOPES, VENUES, visibleEndpoints, type Endpoint } from "../src/catalogue.ts";

/**
 * The catalogue is the published contract restated on this side, and the tests
 * below are what stop it drifting from the server's.
 *
 * The table in "the published endpoint reference" is copied from the docs page
 * on purpose rather than derived from the catalogue — a test that reads the same
 * file it checks proves nothing. When a guard moves in the API, this table is
 * where the disagreement shows up.
 */

/** Method, public path and scope, exactly as the endpoint reference publishes them. */
const published: readonly (readonly [string, string, string])[] = [
  ["GET", "/v1/bots", "bots:read"],
  ["POST", "/v1/bots", "bots:write"],
  ["DELETE", "/v1/bots/{name}", "bots:write"],
  ["GET", "/v1/bots/{name}/config", "bots:read"],
  ["PUT", "/v1/bots/{name}/config", "bots:write"],
  ["GET", "/v1/bots/{name}/orders", "bots:read"],
  ["GET", "/v1/bots/{name}/analytics", "bots:read"],
  ["GET", "/v1/trade/venues/{venue}/instruments", "market:read"],
  ["GET", "/v1/trade/venues/{venue}/ticker", "market:read"],
  ["GET", "/v1/trade/venues", "trade:read"],
  ["GET", "/v1/trade/venues/{venue}/open-orders", "trade:read"],
  ["GET", "/v1/trade/orders/open", "trade:read"],
  ["GET", "/v1/trade/orders", "trade:read"],
  ["POST", "/v1/trade/orders", "trade:write"],
  ["DELETE", "/v1/trade/orders/{clientOrderId}", "trade:write"],
  ["DELETE", "/v1/trade/orders", "trade:write"],
  ["GET", "/v1/scripts", "scripts:read"],
  ["POST", "/v1/scripts", "scripts:write"],
  ["GET", "/v1/scripts/{name}", "scripts:read"],
  ["GET", "/v1/scripts/{name}/config", "scripts:read"],
  ["PUT", "/v1/scripts/{name}", "scripts:write"],
  ["DELETE", "/v1/scripts/{name}", "scripts:write"],
  ["GET", "/v1/balances", "portfolio:read"],
  ["GET", "/v1/balances/{venue}", "portfolio:read"],
  ["GET", "/v1/positions", "portfolio:read"],
  ["GET", "/v1/ws", "any"],
];

const signature = (e: Endpoint) => [e.method, e.path, e.scope].join(" ");

describe("the published endpoint reference", () => {
  it("has a tool for every endpoint a key can reach", () => {
    const have = new Set(ENDPOINTS.map(signature));
    const missing = published.filter(([m, p, s]) => !have.has([m, p, s].join(" ")));
    expect(missing).toEqual([]);
  });

  it("has no tool for anything the reference does not publish", () => {
    // The other direction, and the one that matters more: a tool for a path no
    // key can reach spends a call to learn what the manifest could have said.
    const want = new Set(published.map(([m, p, s]) => [m, p, s].join(" ")));
    expect(ENDPOINTS.map(signature).filter((s) => !want.has(s))).toEqual([]);
  });

  it("never names an endpoint a key is refused by design", () => {
    // Stored venue keys, API keys themselves, plan and billing, and
    // administration. No scope grants any of them: a key can use stored venue
    // keys to trade and can never read or replace one, so a leaked key cannot
    // re-point the account at somebody else's venue account.
    const forbidden = ["/v1/credentials", "/v1/api-keys", "/v1/billing", "/v1/plans", "/v1/admin", "/v1/bot-access"];
    for (const path of forbidden) {
      expect(ENDPOINTS.filter((e) => e.path.startsWith(path))).toEqual([]);
    }
  });
});

describe("the catalogue", () => {
  it("grants only scopes the server knows", () => {
    for (const endpoint of ENDPOINTS) {
      if (endpoint.scope === "any") continue;
      expect(SCOPES).toContain(endpoint.scope);
    }
  });

  it("names every tool once", () => {
    expect(new Set(ENDPOINTS.map((e) => e.name)).size).toBe(ENDPOINTS.length);
  });

  it("marks exactly the endpoints that change state as writes", () => {
    for (const endpoint of ENDPOINTS) {
      expect(endpoint.write ?? false).toBe(endpoint.method !== "GET");
    }
  });

  it("gives every write endpoint a write scope", () => {
    for (const endpoint of ENDPOINTS.filter((e) => e.write)) {
      expect(endpoint.scope).toMatch(/:write$/);
    }
  });

  it("declares an argument for every path placeholder", () => {
    for (const endpoint of ENDPOINTS) {
      for (const [, name] of endpoint.path.matchAll(/\{(\w+)\}/g)) {
        expect(Object.keys(endpoint.input), `${endpoint.name} needs ${name}`).toContain(name);
      }
    }
  });

  it("routes every argument to a path, a query or a body", () => {
    // An argument in none of the three is silently dropped, which is worse than
    // a schema error: the call succeeds and does not do what was asked.
    for (const endpoint of ENDPOINTS) {
      const placeholders = new Set([...endpoint.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
      for (const name of Object.keys(endpoint.input)) {
        const routed =
          placeholders.has(name) || (endpoint.query ?? []).includes(name) || (endpoint.body ?? []).includes(name);
        expect(routed, `${endpoint.name}.${name} goes nowhere`).toBe(true);
      }
    }
  });

  it("describes every tool", () => {
    for (const endpoint of ENDPOINTS) {
      expect(endpoint.description.length, endpoint.name).toBeGreaterThan(20);
      expect(endpoint.title.length, endpoint.name).toBeGreaterThan(0);
    }
  });

  it("dials only public paths", () => {
    // /api is internal and is never what a caller signs.
    for (const endpoint of ENDPOINTS) {
      expect(endpoint.path.startsWith("/v1/"), endpoint.name).toBe(true);
    }
  });
});

describe("the venue ids", () => {
  it("are the runtime's own spelling, including the ones that break the pattern", () => {
    // A near miss resolves to nothing at all, silently — the same string is the
    // venue's id everywhere it appears. These three are not _spot/_perpetual
    // because that is not what those venues call their own products.
    expect(VENUES).toContain("kraken_futures");
    expect(VENUES).toContain("kucoin_futures");
    expect(VENUES).toContain("coinbase_advanced");
    expect(VENUES).not.toContain("kraken_perpetual");
    expect(VENUES).not.toContain("coinbase_spot");
  });

  it("carries the market half on every id that has one", () => {
    for (const venue of VENUES) {
      expect(venue, `${venue} has no market half`).toMatch(/_(spot|perpetual|futures|advanced)$/);
    }
  });
});

describe("visibleEndpoints", () => {
  it("advertises everything by default", () => {
    expect(visibleEndpoints({})).toHaveLength(ENDPOINTS.length);
  });

  it("drops every write in read-only mode", () => {
    const visible = visibleEndpoints({ readOnly: true });
    expect(visible.every((e) => !e.write)).toBe(true);
    expect(visible.length).toBeLessThan(ENDPOINTS.length);
  });

  it("keeps only what the stated scopes reach", () => {
    const visible = visibleEndpoints({ scopes: ["bots:read"] });
    expect(visible.map((e) => e.name).sort()).toEqual(
      ["get_bot_analytics", "get_bot_config", "list_bot_orders", "list_bots", "list_streams"].sort(),
    );
  });

  it("keeps the scope-free tool whatever is stated", () => {
    expect(visibleEndpoints({ scopes: ["market:read"] }).map((e) => e.name)).toContain("list_streams");
  });

  it("applies both narrowings together", () => {
    const visible = visibleEndpoints({ readOnly: true, scopes: ["trade:read", "trade:write"] });
    expect(visible.every((e) => !e.write)).toBe(true);
    expect(visible.map((e) => e.name)).not.toContain("place_order");
    expect(visible.map((e) => e.name)).toContain("list_open_orders");
  });
});
