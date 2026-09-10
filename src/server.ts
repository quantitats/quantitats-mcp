import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { visibleEndpoints, type Endpoint } from "./catalogue.ts";
import { call, RequestError, type Fetch } from "./client.ts";
import type { Config } from "./config.ts";

export const SERVER_NAME = "orchestrator";
export const SERVER_VERSION = "0.1.0";

/**
 * Builds the MCP server: one tool per endpoint the configuration advertises.
 *
 * Every tool is generated from the catalogue rather than written out, so a tool
 * cannot describe a request the client would not send. The only per-tool code is
 * the annotation block below, which is derived from the same entry.
 */
export function buildServer(config: Config, fetchImpl: Fetch = globalThis.fetch): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools over a trading account: its bots, its strategy scripts, its orders and its balances. " +
        "Prices and quantities are decimal strings, never numbers. Venue ids carry the market — binance_spot " +
        "and binance_perpetual are different venues. Tools that place or cancel orders, or that create, " +
        "reconfigure or stop a bot, move real money on a live account: confirm with the operator before " +
        "calling one. What each key may do is fixed when the key is created, so a tool can answer that its " +
        "scope was not granted.",
    },
  );

  for (const endpoint of visibleEndpoints(config)) {
    register(server, config, endpoint, fetchImpl);
  }
  return server;
}

function register(server: McpServer, config: Config, endpoint: Endpoint, fetchImpl: Fetch): void {
  server.registerTool(
    endpoint.name,
    {
      title: endpoint.title,
      // The scope is on the description because it is the first thing to check
      // when a call comes back refused, and a model that can read it there can
      // say which scope is missing instead of retrying.
      description: `${endpoint.description}\n\nRequires the ${endpoint.scope === "any" ? "key to be valid" : `\`${endpoint.scope}\` scope`}.`,
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
        const response = await call(config, endpoint, args ?? {}, fetchImpl);
        return {
          content: [
            {
              type: "text" as const,
              text:
                response.data === null
                  ? `${endpoint.name}: done (HTTP ${response.status})`
                  : JSON.stringify(response.data, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof RequestError ? err.message : `${(err as Error).message}`;
        return {
          isError: true,
          content: [{ type: "text" as const, text: `${endpoint.name} failed: ${message}` }],
        };
      }
    },
  );
}
