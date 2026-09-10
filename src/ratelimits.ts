/**
 * What one key may do per window, mirrored from the edge that enforces it.
 *
 * The gateway meters the published API in six buckets, keyed on the API key that
 * signed the request. The figures below are that configuration restated — see
 * test/ratelimits.test.ts, which pins them against the deployed policy — and
 * they are here for two reasons:
 *
 *   1. A model reads them in the tool description, before it calls anything.
 *      "60 an hour" changes how a model plans; a 429 only tells it that it has
 *      already got the plan wrong.
 *   2. The client counts its own requests against them and refuses locally
 *      rather than spending the real allowance on a call it can predict will be
 *      refused. A refusal that costs nothing is one a caller can recover from
 *      inside the same window.
 *
 * Windows are FIXED, not sliding: a bucket refills at the top of the minute or
 * the hour. So the whole allowance can be spent at once and then waited out, and
 * the local counter aligns to the same wall-clock boundaries the edge uses —
 * which is what keeps the two from disagreeing about which window it is.
 *
 * There is a second rule at the edge keyed on the source address, set at five
 * times each figure below, which stops one host minting keys to multiply its
 * allowance. It is not modelled here: it is flood control between accounts,
 * not something one well-behaved client can pace itself against.
 */

export type Window = "minute" | "hour";

export type Bucket = {
  readonly name: string;
  readonly limit: number;
  readonly window: Window;
  /** Why the figure is what it is, and what to do instead of pushing at it. */
  readonly guidance: string;
};

export const BUCKETS = {
  /**
   * The mean of what the eleven supported venues each allow one account, so a
   * caller cannot use this API to exceed what the venues themselves would have
   * given them. Derived rather than chosen; the table is in the API's own
   * internal/venuelimits.
   */
  tradeWrite: {
    name: "trade-write",
    limit: 932,
    window: "minute",
    guidance:
      "This is the average of what the supported venues themselves allow one account, so it is not a figure to design around — a strategy that needs more than this needs the venue directly.",
  },
  /**
   * Deliberately, visibly small. Neither endpoint reaches a venue: an instrument
   * list is held for an hour and a ticker only while a feed carries it, so an
   * allowance big enough to poll would invite traffic this design refuses, for
   * data that is public and authoritative one hop away.
   */
  venuePublic: {
    name: "venue-public",
    limit: 60,
    window: "hour",
    guidance:
      "Sixty an hour, because this serves a cached copy and the cache is good for the hour. Read an instrument list once and keep it. For prices more often than this, read the venue's own public API — it is free, authoritative, and answers far more often than this will.",
  },
  /**
   * One a second sustained. Every one of these reaches a venue with the caller's
   * own key and nothing caches it, so the allowance spent here is also the
   * caller's allowance AT the venue — and a balances read naming no venue is one
   * request here and up to eleven there.
   */
  venuePrivate: {
    name: "venue-private",
    limit: 60,
    window: "minute",
    guidance:
      "Each of these calls the venue with your own key and spends your allowance there as well as here, so do not poll it. Name a venue when you only need one. For anything you would otherwise poll for, follow the order stream, which reports a fill when it happens instead of being asked whether one has.",
  },
  /**
   * Thirty a minute. Starting a bot or storing a script is real work somewhere
   * slower than this API, and none of it is something a correct client does in a
   * loop — a client that trips this is retrying.
   */
  controlPlane: {
    name: "control-plane",
    limit: 30,
    window: "minute",
    guidance:
      "Changing configuration is metered far more tightly than reading it. Creating, reconfiguring, stopping and deleting all share this budget, so make one considered change rather than a sequence of adjustments.",
  },
  /**
   * Sixty an hour — a reconnection a minute sustained, which is already a client
   * in trouble. It is also the only ceiling on how many streams one key can hold
   * open, so it does more work than its size suggests.
   */
  wsTicket: {
    name: "ws-ticket",
    limit: 60,
    window: "hour",
    guidance: "Listing the streams shares a budget with opening one. Read it once; it does not change while a key lives.",
  },
  /**
   * Everything left: reads of this deployment's own records, which are cheap and
   * priced like it. This is the bucket an ordinary client lands in, so it is the
   * one that must not be the reason anybody meets a 429.
   */
  default: {
    name: "default",
    limit: 600,
    window: "minute",
    guidance: "Ten a second. These read stored records rather than calling a venue, which is why they are cheap.",
  },
} as const satisfies Record<string, Bucket>;

export type BucketName = (typeof BUCKETS)[keyof typeof BUCKETS]["name"];

/** Seconds in a window, which is also how long a full bucket takes to refill. */
export function windowSeconds(window: Window): number {
  return window === "hour" ? 3600 : 60;
}

/**
 * When the window holding `now` ends, in epoch milliseconds.
 *
 * Aligned to the wall clock rather than to first use, because the edge's windows
 * are: a minute bucket refills at the top of the minute whether or not anybody
 * asked for anything.
 */
export function windowEnd(window: Window, now: number): number {
  const size = windowSeconds(window) * 1000;
  return Math.floor(now / size) * size + size;
}

/** One phrase for a limit, for a tool description. */
export function describeLimit(bucket: Bucket): string {
  return `${bucket.limit} requests per ${bucket.window} for your key, shared across every tool in the \`${bucket.name}\` group.`;
}

/**
 * A fixed-window counter per bucket, mirroring the edge's.
 *
 * It exists to stop a model discovering a limit by exhausting it. It is not a
 * security control and cannot be: the edge is the authority, this process may be
 * one of several using the same key, and a restart forgets everything — all of
 * which make it err towards allowing, which is the right direction for something
 * whose failure mode should be "the edge answers 429" rather than "a correct
 * request was refused locally".
 */
export class Limiter {
  #windows = new Map<string, { endsAt: number; used: number }>();
  #clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.#clock = clock;
  }

  /**
   * Records one request against a bucket, and reports whether it may go.
   *
   * `retryAfterSeconds` is rounded UP and floored at one, so a caller told to
   * wait and waiting exactly that long lands in the next window rather than one
   * millisecond short of it.
   */
  take(bucket: Bucket): { allowed: true } | { allowed: false; retryAfterSeconds: number; used: number } {
    const now = this.#clock();
    const current = this.#windows.get(bucket.name);
    const window = current && current.endsAt > now ? current : { endsAt: windowEnd(bucket.window, now), used: 0 };
    this.#windows.set(bucket.name, window);

    if (window.used >= bucket.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((window.endsAt - now) / 1000)),
        used: window.used,
      };
    }
    window.used += 1;
    return { allowed: true };
  }

  /** What is left in a bucket's current window, for a caller that wants to plan. */
  remaining(bucket: Bucket): number {
    const window = this.#windows.get(bucket.name);
    if (!window || window.endsAt <= this.#clock()) return bucket.limit;
    return Math.max(0, bucket.limit - window.used);
  }
}
