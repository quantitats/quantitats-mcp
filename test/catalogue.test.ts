import { describe, expect, it } from "vitest";

import { endpointNamed, ENDPOINTS, SCOPES, VENUES, visibleEndpoints, type Endpoint } from "../src/catalogue.ts";

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

/**
 * The argument schemas against what the API's handlers accept.
 *
 * Every case here is a request the catalogue once described and the API refused
 * or ignored — a 400 for a lower-case filter, a 204 that stopped nothing, a
 * filter silently dropped. The accepted vocabularies are copied by hand from the
 * endpoint reference for the same reason the table above is: reading them back
 * out of the catalogue would prove only that the catalogue agrees with itself.
 */
describe("what the API accepts", () => {
  const named = (name: string): Endpoint => {
    const endpoint = endpointNamed(name);
    if (!endpoint) throw new Error(`no tool ${name}`);
    return endpoint;
  };
  const described = (endpoint: Endpoint, arg: string) =>
    (endpoint.input[arg] as { description?: string } | undefined)?.description ?? "";

  it("sends update_script's name in the body too, which the API requires", () => {
    // The API reads the name a script should end up with from the body and
    // refuses a body without one ("a script needs a name"); the path only says
    // which script. So the one argument fills the placeholder and the body both.
    const update = named("update_script");
    expect(update.path).toBe("/v1/scripts/{name}");
    expect(update.body).toEqual(["name", "script"]);
  });

  it("puts no other argument in two places", () => {
    const twice = new Set(["update_script.name"]);
    for (const endpoint of ENDPOINTS) {
      const placeholders = new Set([...endpoint.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
      for (const name of Object.keys(endpoint.input)) {
        const places = [placeholders.has(name), (endpoint.query ?? []).includes(name), (endpoint.body ?? []).includes(name)];
        const where = `${endpoint.name}.${name}`;
        expect(places.filter(Boolean).length, where).toBe(twice.has(where) ? 2 : 1);
      }
    }
  });

  it("spells side BUY or SELL everywhere, as the order filters and the reference do", () => {
    const withSide = ENDPOINTS.filter((e) => e.input.side);
    expect(withSide.map((e) => e.name).sort()).toEqual(["list_bot_orders", "list_orders", "place_order"]);
    for (const endpoint of withSide) {
      const side = endpoint.input.side;
      expect(side?.safeParse("BUY").success, endpoint.name).toBe(true);
      expect(side?.safeParse("SELL").success, endpoint.name).toBe(true);
      expect(side?.safeParse("buy").success, endpoint.name).toBe(false);
    }
  });

  it("filters status on the API's exact list and nothing else", () => {
    const statuses = ["NEW", "PARTIALLY_FILLED", "FILLED", "CANCELED", "PENDING_CANCEL", "REJECTED", "EXPIRED", "EXPIRED_IN_MATCH", "LOST"];
    for (const name of ["list_orders", "list_bot_orders"]) {
      // Optional, so the enum's list is one wrapper in.
      const status = named(name).input.status as unknown as {
        unwrap(): { options: readonly string[] };
        safeParse(v: unknown): { success: boolean };
      };
      expect([...status.unwrap().options], name).toEqual(statuses);
      expect(status.safeParse("filled").success, name).toBe(false);
      expect(status.safeParse("OPEN").success, name).toBe(false);
      expect(status.safeParse(undefined).success, name).toBe(true);
    }
  });

  it("takes no arguments on list_open_orders, whose route reads no query, and says where the filters are", () => {
    const open = named("list_open_orders");
    expect(Object.keys(open.input)).toEqual([]);
    expect(open.query).toBeUndefined();
    expect(open.description).toMatch(/filter the result yourself, or use list_orders/);
  });

  it("offers since and until on one bot's orders and analytics, which the API reads", () => {
    for (const name of ["list_bot_orders", "get_bot_analytics"]) {
      const endpoint = named(name);
      expect(endpoint.query, name).toEqual(expect.arrayContaining(["since", "until"]));
      expect(Object.keys(endpoint.input), name).toEqual(expect.arrayContaining(["since", "until"]));
      expect(described(endpoint, "since"), name).toMatch(/RFC 3339/);
    }
  });

  it("accepts a loss limit as a bare number or the object form, and names max_loss", () => {
    for (const name of ["create_bot", "update_bot_config"]) {
      const killSwitch = named(name).input.killSwitch;
      expect(described(named(name), "killSwitch"), name).toMatch(/max_loss/);
      expect(killSwitch?.safeParse(250).success, name).toBe(true);
      expect(killSwitch?.safeParse(0).success, name).toBe(true);
      expect(killSwitch?.safeParse({ currency: "USDT", max_loss: 250, limits: { "binance_spot:BTCUSDT": 100 } }).success, name).toBe(true);
      expect(killSwitch?.safeParse(undefined).success, name).toBe(true);
      expect(killSwitch?.safeParse("250").success, name).toBe(false);
    }
    expect(named("get_bot_config").description).toMatch(/max_loss/);
  });

  it("offers every order type the reference publishes, in its spelling, so stopPrice has an order to go on", () => {
    // Copied by hand from the reference page's place-order `type` row.
    const types = ["LIMIT", "MARKET", "LIMIT_MAKER", "STOP_LOSS", "STOP_LOSS_LIMIT", "TAKE_PROFIT", "TAKE_PROFIT_LIMIT"];
    const place = named("place_order");
    const type = place.input.type as unknown as { options: readonly string[]; safeParse(v: unknown): { success: boolean } };
    expect([...type.options]).toEqual(types);
    expect(type.safeParse("market").success).toBe(false);

    expect(described(place, "stopPrice")).toMatch(/Required for STOP_LOSS, STOP_LOSS_LIMIT, TAKE_PROFIT and TAKE_PROFIT_LIMIT/);
    expect(described(place, "price")).toMatch(/Required for LIMIT, LIMIT_MAKER, STOP_LOSS_LIMIT and TAKE_PROFIT_LIMIT/);
    expect(described(place, "quoteQuantity")).toMatch(/only with MARKET/);

    const timeInForce = place.input.timeInForce;
    for (const t of ["GTC", "IOC", "FOK", undefined]) expect(timeInForce?.safeParse(t).success, String(t)).toBe(true);
    expect(timeInForce?.safeParse("DAY").success).toBe(false);
  });

  it("puts a bot's name in a path as the API stores it: trimmed and lower-cased", () => {
    // The API lower-cases a bot's name when it creates one and derives the
    // workload from exactly what the path says, so "Alpha" addresses nothing and
    // a stop answers 204 while the bot keeps trading.
    const botPaths = ENDPOINTS.filter((e) => e.path.startsWith("/v1/bots/{name}"));
    expect(botPaths.map((e) => e.name).sort()).toEqual(
      ["get_bot_analytics", "get_bot_config", "list_bot_orders", "stop_bot", "update_bot_config"].sort(),
    );
    for (const endpoint of botPaths) {
      const name = endpoint.input.name;
      expect(name?.parse(" Alpha "), endpoint.name).toBe("alpha");
      expect(name?.safeParse("   ").success, endpoint.name).toBe(false);
    }
  });

  it("filters orders by a bot's name as the API stores it", () => {
    // The API matches the filter exactly against the lower-cased name, so "Alpha"
    // would list no history and cancel nothing.
    const filtered = ENDPOINTS.filter((e) => e.input.bot !== undefined);
    expect(filtered.map((e) => e.name).sort()).toEqual(["cancel_orders", "list_orders"]);
    for (const endpoint of filtered) {
      expect(endpoint.input.bot?.parse(" Alpha "), endpoint.name).toBe("alpha");
      expect(endpoint.input.bot?.parse(undefined), endpoint.name).toBeUndefined();
    }
  });

  it("leaves a script's name as typed, because the API keeps its case", () => {
    for (const endpoint of ENDPOINTS.filter((e) => e.path.startsWith("/v1/scripts/{name}"))) {
      expect(endpoint.input.name?.parse("BTC Grid"), endpoint.name).toBe("BTC Grid");
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
