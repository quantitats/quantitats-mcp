import { z } from "zod";

import { BUCKETS, type Bucket } from "./ratelimits.ts";

/**
 * Every endpoint an API key can reach, as a tool.
 *
 * This file is the whole surface. It is declarative on purpose: one entry names
 * a method, the public path it is dialled at, the scope it costs and the shape
 * of its arguments, and client.ts turns any entry into a signed request. Adding
 * an endpoint here is the only thing adding an endpoint requires.
 *
 * The scopes are the ones the server actually mounts. They are pinned against
 * the published endpoint reference by test/catalogue.test.ts, because a client
 * that advertises a tool the key cannot reach costs a caller more than no tool
 * at all — the model spends a call to learn what the manifest could have said.
 *
 * What is deliberately absent: stored venue keys, API keys themselves, plan and
 * billing, and administration. No scope grants those, by design — a key can use
 * stored venue keys to trade and can never read or replace one, so a leaked key
 * cannot re-point an account at somebody else's venue account.
 */

/** The scopes a key can be granted, in the order the server lists them. */
export const SCOPES = [
  "bots:read",
  "bots:write",
  "scripts:read",
  "scripts:write",
  "trade:read",
  "trade:write",
  "portfolio:read",
  "market:read",
] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * The venue ids, which are the bot runtime's own spelling rather than a
 * convention invented here. The market half of the name is not decoration and
 * the near misses resolve to nothing at all, so they are enumerated rather than
 * left as free text — a model that guesses `binance` gets a schema error back
 * instead of a silent 404.
 */
export const VENUES = [
  "binance_spot",
  "binance_perpetual",
  "bybit_spot",
  "bybit_perpetual",
  "okx_spot",
  "okx_perpetual",
  "kraken_spot",
  "kraken_futures",
  "kucoin_spot",
  "kucoin_futures",
  "coinbase_advanced",
] as const;

const venue = z.enum(VENUES).describe("Venue id, e.g. binance_spot. The market half of the name is part of it.");
const symbol = z.string().min(1).describe("Instrument symbol as the venue lists it, e.g. BTCUSDT.");
const botName = z.string().min(1).describe("The bot's name.");
const scriptName = z.string().min(1).describe("The script's name.");

/** Shared order-history filters. Every field narrows; all are optional. */
const orderFilters = {
  status: z.string().optional().describe("Order status to filter by."),
  symbol: z.string().optional().describe("Only orders for this symbol."),
  side: z.enum(["buy", "sell"]).optional().describe("Only orders on this side."),
  exchange: z.enum(VENUES).optional().describe("Only orders on this venue."),
  bot: z.string().optional().describe("Only orders placed by this bot."),
  origin: z.enum(["manual", "bot"]).optional().describe("Placed by hand, or by a strategy."),
  since: z.string().optional().describe("RFC 3339 lower bound on placement time."),
  until: z.string().optional().describe("RFC 3339 upper bound on placement time."),
  before: z.number().int().optional().describe("Cursor from a previous page's nextBefore."),
  limit: z.number().int().positive().optional().describe("Page size."),
};

/**
 * One endpoint.
 *
 * `path` is a template over the argument names; `query` and `body` name which
 * arguments travel where. An argument named in neither is a path parameter, and
 * client.ts checks that rather than trusting it.
 */
export type Endpoint = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly scope: Scope | "any";
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  /** Public path, with {braces} naming path parameters. Signed exactly as written. */
  readonly path: string;
  readonly input: z.ZodRawShape;
  /** Argument names that travel in the query string. */
  readonly query?: readonly string[];
  /** Argument names that travel in the JSON body. */
  readonly body?: readonly string[];
  /** True for anything that changes state — hidden in read-only mode. */
  readonly write?: boolean;
  /**
   * Which of the edge's rate-limit buckets this path falls into.
   *
   * Stated per endpoint rather than derived from the path, because the edge's
   * rules are not derivable from one: the same /v1/bots prefix is metered at 30
   * a minute for a write and 600 for a read, and GET /v1/trade/venues sits in
   * the default bucket while GET /v1/trade/venues/{venue}/ticker does not.
   * Guessing that from a path is how a client ends up confidently wrong about
   * its own budget.
   */
  readonly bucket: Bucket;
};

export const ENDPOINTS: readonly Endpoint[] = [
  // --- Bots ----------------------------------------------------------------
  {
    name: "list_bots",
    bucket: BUCKETS.default,
    title: "List bots",
    description:
      "Every bot on the account: its state and run mode, the script it runs, and a summary of the fleet. " +
      "Also returns the scripts and run modes a new bot can be created with.",
    scope: "bots:read",
    method: "GET",
    path: "/v1/bots",
    input: {},
  },
  {
    name: "create_bot",
    bucket: BUCKETS.controlPlane,
    title: "Create a bot",
    description:
      "Creates and starts a bot running one of the account's scripts. Answers 409 if the name is taken and 403 " +
      "if the plan's bot limit is reached, naming the limit. Mode defaults to paper; sim settings are refused on " +
      "a live bot rather than ignored.",
    scope: "bots:write",
    method: "POST",
    path: "/v1/bots",
    write: true,
    input: {
      name: z.string().min(1).describe("Name for the new bot. Must be unused."),
      script: scriptName,
      exchanges: z.array(venue).min(1).describe("Venues this bot trades on."),
      mode: z.enum(["paper", "live"]).optional().describe("Paper simulates; live trades real funds. Defaults to paper."),
      config: z
        .record(z.unknown())
        .optional()
        .describe("Overrides for the script's own settings, for this bot only. Checked against the script."),
      sim: z
        .record(z.unknown())
        .optional()
        .describe("Simulator settings, for a paper bot only. Refused on a live bot."),
      killSwitch: z
        .record(z.unknown())
        .optional()
        .describe("Per-market loss limit. The first market to exceed its limit ends the run for good."),
    },
    body: ["name", "script", "exchanges", "mode", "config", "sim", "killSwitch"],
  },
  {
    name: "stop_bot",
    bucket: BUCKETS.controlPlane,
    title: "Stop a bot",
    description:
      "Stops the bot and retires it. Its orders and analytics remain readable afterwards. This does not cancel " +
      "orders the bot already has resting at a venue — use cancel_orders for that.",
    scope: "bots:write",
    method: "DELETE",
    path: "/v1/bots/{name}",
    write: true,
    input: { name: botName },
  },
  {
    name: "get_bot_config",
    bucket: BUCKETS.default,
    title: "Read a bot's settings",
    description:
      "That bot's settings: the fields its script declares, the values this bot overrides, its run mode, its " +
      "simulator settings if it is a paper bot, and its loss limit.",
    scope: "bots:read",
    method: "GET",
    path: "/v1/bots/{name}/config",
    input: { name: botName },
  },
  {
    name: "update_bot_config",
    bucket: BUCKETS.controlPlane,
    title: "Replace a bot's settings",
    description:
      "Replaces the overrides — a full replacement, not a merge, so send every override the bot should keep — " +
      "and RESTARTS the bot. Orders already resting at a venue are not cancelled by this.",
    scope: "bots:write",
    method: "PUT",
    path: "/v1/bots/{name}/config",
    write: true,
    input: {
      name: botName,
      config: z.record(z.unknown()).describe("The complete set of overrides. Anything absent reverts to the script's value."),
      sim: z.record(z.unknown()).optional().describe("Simulator settings, for a paper bot only."),
      killSwitch: z.record(z.unknown()).optional().describe("Per-market loss limit. Omit or zero to switch it off."),
    },
    body: ["config", "sim", "killSwitch"],
  },
  {
    name: "list_bot_orders",
    bucket: BUCKETS.default,
    title: "List one bot's orders",
    description: "Every order that bot has placed, open and historic. Readable even for a bot that has been stopped.",
    scope: "bots:read",
    method: "GET",
    path: "/v1/bots/{name}/orders",
    input: {
      name: botName,
      status: orderFilters.status,
      symbol: orderFilters.symbol,
      side: orderFilters.side,
      before: orderFilters.before,
      limit: orderFilters.limit,
    },
    query: ["status", "symbol", "side", "before", "limit"],
  },
  {
    name: "get_bot_analytics",
    bucket: BUCKETS.default,
    title: "Read one bot's performance",
    description: "That bot's realized profit and loss and its fill statistics.",
    scope: "bots:read",
    method: "GET",
    path: "/v1/bots/{name}/analytics",
    input: { name: botName },
  },

  // --- Market data ---------------------------------------------------------
  {
    name: "list_instruments",
    bucket: BUCKETS.venuePublic,
    title: "List a venue's instruments",
    description:
      "Every symbol that venue lists, with its tick and lot rules. Public market structure — read this before " +
      "placing an order, because a price or quantity off the venue's grid is refused by the venue.",
    scope: "market:read",
    method: "GET",
    path: "/v1/trade/venues/{venue}/instruments",
    input: { venue },
  },
  {
    name: "get_ticker",
    bucket: BUCKETS.venuePublic,
    title: "Get the current price",
    description: "The current price for one symbol on one venue.",
    scope: "market:read",
    method: "GET",
    path: "/v1/trade/venues/{venue}/ticker",
    input: { venue, symbol },
    query: ["symbol"],
  },

  // --- Trading -------------------------------------------------------------
  {
    name: "list_venues",
    bucket: BUCKETS.default,
    title: "List venues",
    description:
      "The venue list and, for each, whether the account has keys stored for it and whether the plan permits it. " +
      "That is account state, which is why it costs trade:read rather than market:read.",
    scope: "trade:read",
    method: "GET",
    path: "/v1/trade/venues",
    input: {},
  },
  {
    name: "list_open_orders",
    bucket: BUCKETS.default,
    title: "List open orders",
    description:
      "Every order across the account that can still trade, from bots and from manual placement alike, each " +
      "one carrying which bot placed it. This is the account's own view of the book.",
    scope: "trade:read",
    method: "GET",
    path: "/v1/trade/orders/open",
    input: {
      status: orderFilters.status,
      symbol: orderFilters.symbol,
      side: orderFilters.side,
      exchange: orderFilters.exchange,
      bot: orderFilters.bot,
      origin: orderFilters.origin,
    },
    query: ["status", "symbol", "side", "exchange", "bot", "origin"],
  },
  {
    name: "list_orders",
    bucket: BUCKETS.default,
    title: "List order history",
    description:
      "The account's order history, filtered and paged. Page with the nextBefore the response carries.",
    scope: "trade:read",
    method: "GET",
    path: "/v1/trade/orders",
    input: { ...orderFilters },
    query: Object.keys(orderFilters),
  },
  {
    name: "list_venue_open_orders",
    bucket: BUCKETS.venuePrivate,
    title: "List what a venue says is open",
    description:
      "One venue's own view of the account's resting orders, including any placed from the venue's own app. " +
      "Deliberately separate from list_open_orders: comparing the two is how a disagreement becomes visible.",
    scope: "trade:read",
    method: "GET",
    path: "/v1/trade/venues/{venue}/open-orders",
    input: { venue, symbol: z.string().optional().describe("Narrow to one symbol.") },
    query: ["symbol"],
  },
  {
    name: "place_order",
    bucket: BUCKETS.tradeWrite,
    title: "Place an order",
    description:
      "Submits one order and answers with it as the venue acknowledged it. Quantities and prices are decimal " +
      "STRINGS, not numbers, so nothing is lost to floating point. A limit order needs a price. Check " +
      "list_instruments first: a price or size off the venue's grid is refused.",
    scope: "trade:write",
    method: "POST",
    path: "/v1/trade/orders",
    write: true,
    input: {
      exchange: venue,
      symbol,
      side: z.enum(["buy", "sell"]),
      type: z.enum(["market", "limit"]).describe("Order type."),
      quantity: z.string().optional().describe("Size in the base asset, as a decimal string."),
      quoteQuantity: z.string().optional().describe("Size in the quote asset, as a decimal string. An alternative to quantity."),
      price: z.string().optional().describe("Limit price, as a decimal string. Required for a limit order."),
      stopPrice: z.string().optional().describe("Trigger price, as a decimal string."),
      timeInForce: z.string().optional().describe("How long the order stands, e.g. GTC or IOC."),
      reduceOnly: z.boolean().optional().describe("Only meaningful on a derivative venue."),
    },
    body: ["exchange", "symbol", "side", "type", "quantity", "quoteQuantity", "price", "stopPrice", "timeInForce", "reduceOnly"],
  },
  {
    name: "cancel_order",
    bucket: BUCKETS.tradeWrite,
    title: "Cancel one order",
    description:
      "Withdraws one resting order, addressed by the client order id it has carried since it was filed — which " +
      "is the identifier it has before the venue has answered at all.",
    scope: "trade:write",
    method: "DELETE",
    path: "/v1/trade/orders/{clientOrderId}",
    write: true,
    input: { clientOrderId: z.string().min(1).describe("The order's client order id.") },
  },
  {
    name: "cancel_orders",
    bucket: BUCKETS.tradeWrite,
    title: "Cancel many orders",
    description:
      "Withdraws every open order matching the filter, and answers with what happened to each one. WITH NO " +
      "FILTER THIS CANCELS EVERYTHING ON THE ACCOUNT, including orders the account's bots are working — pass " +
      "origin=manual to spare those. Narrow it before calling it.",
    scope: "trade:write",
    method: "DELETE",
    path: "/v1/trade/orders",
    write: true,
    input: {
      exchange: z.enum(VENUES).optional().describe("Only orders on this venue."),
      symbol: z.string().optional().describe("Only orders for this symbol."),
      origin: z.enum(["manual", "bot"]).optional().describe("Only orders placed by hand, or only those placed by a strategy."),
      bot: z.string().optional().describe("Only orders placed by this bot."),
    },
    query: ["exchange", "symbol", "origin", "bot"],
  },

  // --- Scripts -------------------------------------------------------------
  {
    name: "list_scripts",
    bucket: BUCKETS.default,
    title: "List scripts",
    description: "The account's strategy scripts, with the limits the editor enforces on them.",
    scope: "scripts:read",
    method: "GET",
    path: "/v1/scripts",
    input: {},
  },
  {
    name: "get_script",
    bucket: BUCKETS.default,
    title: "Read a script",
    description: "One script's source, with when it was created and last changed.",
    scope: "scripts:read",
    method: "GET",
    path: "/v1/scripts/{name}",
    input: { name: scriptName },
  },
  {
    name: "get_script_config",
    bucket: BUCKETS.default,
    title: "Read a script's settings",
    description:
      "The settings that script declares — each field's name, type, default and hint — which is what a bot " +
      "running it may override.",
    scope: "scripts:read",
    method: "GET",
    path: "/v1/scripts/{name}/config",
    input: { name: scriptName },
  },
  {
    name: "create_script",
    bucket: BUCKETS.controlPlane,
    title: "Create a script",
    description: "Stores a new strategy script. Answers 409 if the name is already in use.",
    scope: "scripts:write",
    method: "POST",
    path: "/v1/scripts",
    write: true,
    input: {
      name: z.string().min(1).describe("Name for the new script. Must be unused."),
      script: z.string().describe("The script source."),
    },
    body: ["name", "script"],
  },
  {
    name: "update_script",
    bucket: BUCKETS.controlPlane,
    title: "Replace a script",
    description:
      "Replaces a script's source. Bots already running it keep running the version they started with until " +
      "they are restarted.",
    scope: "scripts:write",
    method: "PUT",
    path: "/v1/scripts/{name}",
    write: true,
    input: { name: scriptName, script: z.string().describe("The new source, replacing what is stored.") },
    body: ["script"],
  },
  {
    name: "delete_script",
    bucket: BUCKETS.controlPlane,
    title: "Delete a script",
    description: "Removes a script from the account's library.",
    scope: "scripts:write",
    method: "DELETE",
    path: "/v1/scripts/{name}",
    write: true,
    input: { name: scriptName },
  },

  // --- Portfolio -----------------------------------------------------------
  {
    name: "list_balances",
    bucket: BUCKETS.venuePrivate,
    title: "List balances",
    description: "Balances across every venue the account holds keys for.",
    scope: "portfolio:read",
    method: "GET",
    path: "/v1/balances",
    input: {},
  },
  {
    name: "get_venue_balances",
    bucket: BUCKETS.venuePrivate,
    title: "List one venue's balances",
    description: "Balances at one venue.",
    scope: "portfolio:read",
    method: "GET",
    path: "/v1/balances/{venue}",
    input: { venue },
  },
  {
    name: "list_positions",
    bucket: BUCKETS.venuePrivate,
    title: "List open positions",
    description: "Open derivative positions across the account.",
    scope: "portfolio:read",
    method: "GET",
    path: "/v1/positions",
    input: {},
  },

  // --- Streams -------------------------------------------------------------
  {
    name: "list_streams",
    bucket: BUCKETS.wsTicket,
    title: "List live streams",
    description:
      "The live streams this deployment serves and the scope each needs. Discovery only — a stream is a long-" +
      "lived connection and cannot be read through a tool call, so use this to find out what exists and read " +
      "the same data through the list tools.",
    scope: "any",
    method: "GET",
    path: "/v1/ws",
    input: {},
  },
];

/** One endpoint by tool name. */
export function endpointNamed(name: string): Endpoint | undefined {
  return ENDPOINTS.find((e) => e.name === name);
}

/**
 * The endpoints a given configuration should advertise.
 *
 * Two independent narrowings, both off by default. `readOnly` drops everything
 * that changes state. `scopes`, when given, drops everything the key was not
 * granted — the key's own scopes are not discoverable from any endpoint, so this
 * is stated rather than fetched, and stating nothing advertises everything and
 * lets the server refuse.
 */
export function visibleEndpoints(opts: { readOnly?: boolean; scopes?: readonly string[] }): readonly Endpoint[] {
  return ENDPOINTS.filter((e) => {
    if (opts.readOnly && e.write) return false;
    if (opts.scopes && e.scope !== "any" && !opts.scopes.includes(e.scope)) return false;
    return true;
  });
}
