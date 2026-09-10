import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ENDPOINTS } from "../src/catalogue.ts";
import { BUCKETS, describeLimit, Limiter, windowEnd, windowSeconds, type Bucket } from "../src/ratelimits.ts";

/**
 * The limits this client believes in are the ones the edge enforces.
 *
 * Two independent checks. The first reads the deployed policy itself, so a figure
 * changed at the gateway and not here is a failing test rather than a model that
 * plans against a budget it does not have. The second pins the path-to-bucket
 * mapping, which is the part that cannot be derived: the same /v1/bots prefix is
 * metered at 30 a minute for a write and 600 for a read.
 */

/** The gateway policy, when this package is still inside the parent repository. */
function gatewayPolicy(): string | undefined {
  const path = join(import.meta.dirname, "..", "..", "deploy", "gateway", "ratelimit-api.yaml");
  try {
    return readFileSync(path, "utf8");
  } catch {
    // Absent once this package is its own repository. The table below still
    // pins every figure; it just cannot cross-check them from here.
    return undefined;
  }
}

describe("the buckets", () => {
  it("carry the figures the gateway enforces", () => {
    const expected: readonly [Bucket, number, string][] = [
      [BUCKETS.tradeWrite, 932, "Minute"],
      [BUCKETS.venuePublic, 60, "Hour"],
      [BUCKETS.venuePrivate, 60, "Minute"],
      [BUCKETS.controlPlane, 30, "Minute"],
      [BUCKETS.wsTicket, 60, "Hour"],
      [BUCKETS.default, 600, "Minute"],
    ];
    for (const [bucket, limit, unit] of expected) {
      expect(bucket.limit, bucket.name).toBe(limit);
      expect(bucket.window, bucket.name).toBe(unit.toLowerCase());
    }
  });

  it("agree with the deployed policy, when it can be read", () => {
    const policy = gatewayPolicy();
    if (policy === undefined) return;

    // The per-key rule for each bucket, read out of the policy by the name the
    // BackendTrafficPolicy carries. The five-times figure beside it is the
    // source-address rule, which is flood control between accounts rather than
    // something one client paces itself against.
    for (const bucket of Object.values(BUCKETS)) {
      const section = policy.split(`name: ratelimit-${bucket.name}\n`)[1];
      expect(section, `no policy named ratelimit-${bucket.name}`).toBeDefined();
      const perKey = /requests: (\d+)\s*\n\s*unit: (Minute|Hour)/.exec(section ?? "");
      expect(perKey, `${bucket.name} has no per-key limit`).not.toBeNull();
      expect(Number(perKey?.[1]), `${bucket.name} limit`).toBe(bucket.limit);
      expect(perKey?.[2]?.toLowerCase(), `${bucket.name} window`).toBe(bucket.window);
    }
  });

  it("explains what to do instead of pushing at each one", () => {
    for (const bucket of Object.values(BUCKETS)) {
      expect(bucket.guidance.length, bucket.name).toBeGreaterThan(40);
    }
  });
});

describe("which bucket each endpoint falls into", () => {
  /**
   * The gateway's routes, restated. Derived from deploy/gateway/httproute-api.yaml:
   * an exact or regular-expression route wins over the /v1 prefix that catches
   * everything else, so the specific rows below are the ones that matter and
   * `default` is what is left.
   */
  const expected: Record<string, string> = {
    // POST and DELETE on /v1/trade/orders.
    place_order: "trade-write",
    cancel_order: "trade-write",
    cancel_orders: "trade-write",
    // ^/v1/trade/venues/[^/]+/(instruments|ticker)$ — cached, and public at the venue.
    list_instruments: "venue-public",
    get_ticker: "venue-public",
    // Reaches a venue with the caller's own key: open-orders, balances, positions.
    list_venue_open_orders: "venue-private",
    list_balances: "venue-private",
    get_venue_balances: "venue-private",
    list_positions: "venue-private",
    // Writes on /v1/bots and /v1/scripts, whatever the method.
    create_bot: "control-plane",
    stop_bot: "control-plane",
    update_bot_config: "control-plane",
    create_script: "control-plane",
    update_script: "control-plane",
    delete_script: "control-plane",
    // Exact /v1/ws, with no method restriction — so listing the streams shares
    // the bucket that meters opening one.
    list_streams: "ws-ticket",
    // Everything else: reads of this deployment's own records.
    list_bots: "default",
    get_bot_config: "default",
    list_bot_orders: "default",
    get_bot_analytics: "default",
    list_venues: "default",
    list_open_orders: "default",
    list_orders: "default",
    list_scripts: "default",
    get_script: "default",
    get_script_config: "default",
  };

  it("is stated for every endpoint", () => {
    expect(Object.keys(expected).sort()).toEqual(ENDPOINTS.map((e) => e.name).sort());
  });

  it("matches the gateway's routes", () => {
    for (const endpoint of ENDPOINTS) {
      expect(endpoint.bucket.name, endpoint.name).toBe(expected[endpoint.name]);
    }
  });

  it("never meters a write in the read bucket", () => {
    // A write is either a trade or a configuration change, and both are metered
    // far more tightly than a read. One landing in `default` would mean this
    // client planning against 600 a minute where the edge allows 30.
    for (const endpoint of ENDPOINTS.filter((e) => e.write)) {
      expect(["trade-write", "control-plane"], endpoint.name).toContain(endpoint.bucket.name);
    }
  });

  it("puts GET /v1/trade/venues in the read bucket, not the market-data one", () => {
    // The regular-expression route matches only /venues/{venue}/instruments and
    // /ticker. The bare list is not in it, and treating it as though it were
    // would have this client refusing calls at a sixtieth of the real allowance.
    const venues = ENDPOINTS.find((e) => e.name === "list_venues");
    expect(venues?.bucket.name).toBe("default");
  });
});

describe("describeLimit", () => {
  it("states the figure, the window and the group it is shared with", () => {
    expect(describeLimit(BUCKETS.venuePublic)).toBe(
      "60 requests per hour for your key, shared across every tool in the `venue-public` group.",
    );
  });
});

describe("windowEnd", () => {
  it("aligns to the wall clock, as the edge's fixed windows do", () => {
    // 12:00:30 -> the minute ends at 12:01:00, not 60s from now.
    const at = Date.UTC(2026, 8, 10, 12, 0, 30);
    expect(windowEnd("minute", at)).toBe(Date.UTC(2026, 8, 10, 12, 1, 0));
    expect(windowEnd("hour", at)).toBe(Date.UTC(2026, 8, 10, 13, 0, 0));
  });

  it("knows how long each window is", () => {
    expect(windowSeconds("minute")).toBe(60);
    expect(windowSeconds("hour")).toBe(3600);
  });
});

describe("the local counter", () => {
  /** A clock the test moves by hand, so nothing here waits on real time. */
  function fixedClock(start: number) {
    let now = start;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  }

  it("allows a bucket's whole allowance and refuses the next", () => {
    const clock = fixedClock(Date.UTC(2026, 8, 10, 12, 0, 0));
    const limiter = new Limiter(clock.now);
    for (let i = 0; i < BUCKETS.controlPlane.limit; i++) {
      expect(limiter.take(BUCKETS.controlPlane).allowed, `request ${i + 1}`).toBe(true);
    }
    const refused = limiter.take(BUCKETS.controlPlane);
    expect(refused.allowed).toBe(false);
  });

  it("says how long to wait, rounded up so the wait lands in the next window", () => {
    const clock = fixedClock(Date.UTC(2026, 8, 10, 12, 0, 0) + 30_500);
    const limiter = new Limiter(clock.now);
    for (let i = 0; i < BUCKETS.controlPlane.limit; i++) limiter.take(BUCKETS.controlPlane);
    const refused = limiter.take(BUCKETS.controlPlane);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      // 29.5s remain; waiting 29 would land short of the boundary.
      expect(refused.retryAfterSeconds).toBe(30);
    }
  });

  it("refills at the window boundary", () => {
    const clock = fixedClock(Date.UTC(2026, 8, 10, 12, 0, 0));
    const limiter = new Limiter(clock.now);
    for (let i = 0; i < BUCKETS.controlPlane.limit; i++) limiter.take(BUCKETS.controlPlane);
    expect(limiter.take(BUCKETS.controlPlane).allowed).toBe(false);
    clock.advance(60_000);
    expect(limiter.take(BUCKETS.controlPlane).allowed).toBe(true);
  });

  it("counts each bucket separately", () => {
    const clock = fixedClock(Date.UTC(2026, 8, 10, 12, 0, 0));
    const limiter = new Limiter(clock.now);
    for (let i = 0; i < BUCKETS.controlPlane.limit; i++) limiter.take(BUCKETS.controlPlane);
    expect(limiter.take(BUCKETS.controlPlane).allowed).toBe(false);
    // Spending the configuration budget must not stop a read.
    expect(limiter.take(BUCKETS.default).allowed).toBe(true);
  });

  it("shares one bucket across every tool that maps to it", () => {
    // The edge counts per key and per bucket, not per path, so two tools in the
    // same group draw down the same allowance.
    const clock = fixedClock(Date.UTC(2026, 8, 10, 12, 0, 0));
    const limiter = new Limiter(clock.now);
    const instruments = ENDPOINTS.find((e) => e.name === "list_instruments");
    const ticker = ENDPOINTS.find((e) => e.name === "get_ticker");
    for (let i = 0; i < BUCKETS.venuePublic.limit; i++) limiter.take(instruments!.bucket);
    expect(limiter.take(ticker!.bucket).allowed).toBe(false);
  });

  it("reports what is left, and a full bucket before anything is spent", () => {
    const clock = fixedClock(Date.UTC(2026, 8, 10, 12, 0, 0));
    const limiter = new Limiter(clock.now);
    expect(limiter.remaining(BUCKETS.venuePublic)).toBe(60);
    limiter.take(BUCKETS.venuePublic);
    limiter.take(BUCKETS.venuePublic);
    expect(limiter.remaining(BUCKETS.venuePublic)).toBe(58);
    clock.advance(3_600_000);
    expect(limiter.remaining(BUCKETS.venuePublic)).toBe(60);
  });
});
