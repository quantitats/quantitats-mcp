import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

/**
 * `npm run dev` runs these sources through Node's --experimental-strip-types,
 * which erases type syntax and transforms nothing. A few TypeScript constructs
 * cannot be erased — constructor parameter properties, enums, namespaces — and
 * every one of them is invisible to the rest of this suite, because vitest and
 * esbuild both transform.
 *
 * So this test is the only thing standing between a green build and a dev script
 * that refuses to start. It loads the real entrypoint the real way, which pulls
 * the whole module graph through the stripper.
 */
describe("the sources under strip-only mode", () => {
  it("load the way `npm run dev` loads them", async () => {
    const entry = join(import.meta.dirname, "..", "src", "main.ts");
    // No credentials in the environment on purpose: the process should get as
    // far as reporting that, which means every module parsed and ran. A strip
    // failure is a SyntaxError long before this point.
    const result = await run(process.execPath, ["--experimental-strip-types", entry], {
      env: { PATH: process.env.PATH ?? "" },
    }).catch((err: { code?: number; stderr?: string; stdout?: string }) => err);

    const stderr = "stderr" in result ? (result.stderr ?? "") : "";
    expect(stderr).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SyntaxError/);
    expect(stderr).toMatch(/QUANTITATS_API_KEY_ID is required/);
    expect((result as { code?: number }).code).toBe(2);
  }, 30_000);
});
