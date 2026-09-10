import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ConfigError, loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";

/**
 * The entrypoint.
 *
 * stdout is the transport — it carries JSON-RPC and nothing else — so every
 * message this process writes for a human goes to stderr. A stray console.log
 * anywhere in this tree corrupts the stream, which is why there is none.
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`orchestrator-mcp: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  const server = buildServer(config);
  await server.connect(new StdioServerTransport());

  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`orchestrator-mcp: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
