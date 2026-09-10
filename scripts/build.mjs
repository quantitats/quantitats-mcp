import { build } from "esbuild";

// One bundled ESM file with a shebang, so an MCP client can launch it with
// `node dist/server.mjs` — or directly — and nothing has to be installed at the
// far end. Node 22 is the floor the package declares.
await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
});
