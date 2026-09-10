import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Every test here is hermetic: the client tests drive a real HTTP server on
    // a loopback port that verifies signatures the way the API does. Nothing
    // reaches the network.
    environment: "node",
  },
});
