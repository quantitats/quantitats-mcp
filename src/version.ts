/**
 * The version this server reports to a client.
 *
 * Stamped at build time. `scripts/build.mjs` replaces __BUILD_VERSION__ with a
 * string literal derived from git, so a published image says exactly which
 * commit it came from; running from source there is nothing to stamp, and the
 * fallback says so rather than claiming to be a release.
 *
 * `typeof` on an undeclared identifier is not an error in JavaScript — it is
 * "undefined" — which is what makes the same expression work both after esbuild
 * has substituted the literal and when nothing has.
 */
declare const __BUILD_VERSION__: string;

/**
 * The version in package.json, restated here so nothing has to import JSON at
 * runtime. test/version.test.ts keeps the two the same.
 */
export const PACKAGE_VERSION = "0.1.0";

export const VERSION: string =
  typeof __BUILD_VERSION__ === "string" && __BUILD_VERSION__ !== ""
    ? __BUILD_VERSION__
    : `${PACKAGE_VERSION}+source`;
