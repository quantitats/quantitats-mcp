import { build } from "esbuild";

import { resolveVersion } from "./version.mjs";

// One bundled ESM file with a shebang, so an MCP client can launch it with
// `node dist/server.mjs` — or directly — and nothing has to be installed at the
// far end. Node 22 is the floor the package declares.
const version = resolveVersion();

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  // Stamped in rather than read at runtime: a single bundled file has no
  // package.json beside it to read, and a version derived at build time is the
  // only one that can name the commit it was built from. See src/version.ts,
  // which falls back when nothing has been substituted.
  define: { __BUILD_VERSION__: JSON.stringify(version) },
});

// To stdout on purpose: this is a build script, and CI reads the line.
console.log(`built dist/server.mjs at version ${version}`);
