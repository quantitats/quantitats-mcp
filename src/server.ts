import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { visibleEndpoints, type Endpoint } from "./catalogue.ts";
import { call, RateLimitedLocally, RequestError, type Fetch } from "./client.ts";
import type { Config } from "./config.ts";
import { describeLimit, Limiter } from "./ratelimits.ts";
import { VERSION } from "./version.ts";

export const SERVER_NAME = "quantitats";
/** Re-exported so a client's serverInfo and the image's tag are one string. */
export { VERSION as SERVER_VERSION } from "./version.ts";

/**
 * Builds the MCP server: one tool per endpoint the configuration advertises.
 *
 * Every tool is generated from the catalogue rather than written out, so a tool
 * cannot describe a request the client would not send. The only per-tool code is
 * the annotation block below, which is derived from the same entry.
 */
export function buildServer(
  config: Config,
  fetchImpl: Fetch = globalThis.fetch,
  // One limiter for the whole server: the buckets are per key, not per tool, so
  // every tool sharing a bucket has to share the counter for it.
  limiter: Limiter = new Limiter(),
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    {
      instructions:
        "Tools over a trading account: its bots, its strategy scripts, its orders and its balances. " +
        "Prices and quantities are decimal strings, never numbers. Venue ids carry the market — binance_spot " +
        "and binance_perpetual are different venues. Tools that place or cancel orders, or that create, " +
        "reconfigure or stop a bot, move real money on a live account: confirm with the operator before " +
        "calling one. What each key may do is fixed when the key is created, so a tool can answer that its " +
        "scope was not granted.\n\n" +
        "Every tool is rate limited per key, and the limits differ by three orders of magnitude — each tool's " +
        "description states its own. Market data is 60 an hour because it is served from a cache and is public " +
        "at the venue; account reads that reach a venue are 60 a minute and spend your allowance at that venue " +
        "too. So do not poll: read a list once and work from it, name a venue rather than asking for all of " +
        "them, and treat a limit as a budget for the whole task rather than per step. A result carries what is " +
        "left of the current window when the server reports it.",
    },
  );

  for (const endpoint of visibleEndpoints(config)) {
    register(server, config, endpoint, fetchImpl, limiter);
  }
  return server;
}

/**
 * A line about what is left of the window, when the server said.
 *
 * Only when it is worth acting on. Reporting "599 of 600 remaining" on every
 * call trains a reader to skip the line, and then the one that says 3 is skipped
 * too — so the threshold is a tenth of the bucket, which is the point at which
 * pacing changes what a model should do next.
 */
function remainingNote(
  rateLimit: { limit?: number; remaining?: number; resetSeconds?: number } | undefined,
  bucket: string,
): string | undefined {
  if (rateLimit?.remaining === undefined) return undefined;
  const { limit, remaining, resetSeconds } = rateLimit;
  if (limit !== undefined && remaining > limit / 10) return undefined;
  const reset = resetSeconds !== undefined ? `, resetting in ${resetSeconds}s` : "";
  return `Rate limit: ${remaining}${limit !== undefined ? ` of ${limit}` : ""} left in this window for the ${bucket} group${reset}. Stop or slow down rather than spending the rest.`;
}

function register(
  server: McpServer,
  config: Config,
  endpoint: Endpoint,
  fetchImpl: Fetch,
  limiter: Limiter,
): void {
  server.registerTool(
    endpoint.name,
    {
      title: endpoint.title,
      // The scope is on the description because it is the first thing to check
      // when a call comes back refused, and a model that can read it there can
      // say which scope is missing instead of retrying.
      description:
        `${endpoint.description}\n\n` +
        `Requires the ${endpoint.scope === "any" ? "key to be valid" : `\`${endpoint.scope}\` scope`}.\n\n` +
        // Stated on every tool, not only the tight ones. A model that has to
        // guess which tools are cheap will guess wrong about the one that is
        // metered at a sixtieth of the others.
        `Rate limit: ${describeLimit(endpoint.bucket)} ${endpoint.bucket.guidance}`,
      inputSchema: endpoint.input,
      annotations: {
        title: endpoint.title,
        readOnlyHint: !endpoint.write,
        // Stopping a bot, cancelling an order and deleting a script all remove
        // something that cannot be restored by calling the tool again.
        destructiveHint: endpoint.write === true && endpoint.method !== "POST",
        // A PUT replaces wholesale and a DELETE of something already gone is a
        // no-op; a POST creates a second thing and a cancel spends an order.
        idempotentHint: endpoint.method === "PUT" || endpoint.method === "GET",
        openWorldHint: true,
      },
    },
    async (args: Record<string, unknown>) => {
      try {
        const response = await call(config, endpoint, args ?? {}, fetchImpl, limiter);
        const body =
          response.data === null
            ? `${endpoint.name}: done (HTTP ${response.status})`
            : JSON.stringify(response.data, null, 2);
        // Appended rather than merged into the payload: the answer is the
        // endpoint's and should not gain a field this client invented.
        const budget = remainingNote(response.rateLimit, endpoint.bucket.name);
        return { content: [{ type: "text" as const, text: budget ? `${body}\n\n${budget}` : body }] };
      } catch (err) {
        if (err instanceof RateLimitedLocally) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `${endpoint.name} was not sent: ${err.message} Nothing was spent — wait ${err.retryAfterSeconds}s and it will succeed.`,
              },
            ],
          };
        }
        const message = err instanceof RequestError ? err.message : `${(err as Error).message}`;
        return {
          isError: true,
          content: [{ type: "text" as const, text: `${endpoint.name} failed: ${message}` }],
        };
      }
    },
  );
}
