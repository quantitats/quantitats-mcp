import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where a build's version number comes from.
 *
 * One rule, in four steps, so that the version an image reports is derivable
 * from the commit it was built at and from nothing else:
 *
 *   1. QUANTITATS_MCP_VERSION, verbatim. CI computes the version once and hands
 *      it to every build, so the image tag and the string the server reports to
 *      a client cannot disagree.
 *   2. A `v<semver>` tag pointing at HEAD -> that semver. This is a release.
 *   3. Otherwise <package version>-dev.<commits>+<sha>, and `.dirty` appended
 *      when the working tree has uncommitted changes. Ordered so that semver
 *      sorts a dev build BELOW the release it precedes, which is the direction
 *      that makes "is this newer than 0.2.0" answerable.
 *   4. No git at all — a source tarball, or a container build with .git
 *      excluded — is <package version>+unknown. Deliberately not the bare
 *      package version: something that cannot say where it came from should not
 *      look like a release.
 */

/**
 * The same version, made safe to use as a container tag.
 *
 * A Docker reference allows [A-Za-z0-9_.-] and nothing else, so the `+` that
 * semver uses to introduce build metadata is illegal in a tag while being
 * required in the version itself. It becomes `_`, which is the usual
 * substitution and is reversible by eye.
 */
export function dockerTag(version) {
  const safe = version.replace(/\+/g, "_").replace(/[^A-Za-z0-9_.-]/g, "-");
  // A reference may not begin with a separator.
  return /^[A-Za-z0-9_]/.test(safe) ? safe.slice(0, 128) : `v${safe}`.slice(0, 128);
}

/**
 * What git can say about the commit being built.
 *
 * @typedef {{ sha: string, tag?: string | undefined, commits: string, dirty: boolean }} GitState
 */

/**
 * Reads the version out of package.json.
 *
 * @param {string} [root]
 * @returns {string}
 */
export function packageVersion(root = defaultRoot()) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof pkg.version !== "string" || pkg.version === "") {
    throw new Error("package.json has no version");
  }
  return pkg.version;
}

function defaultRoot() {
  return join(import.meta.dirname, "..");
}

/**
 * Runs a git command, or returns undefined when git cannot answer.
 *
 * Every call here is a question that has a legitimate "no": a build from a
 * tarball has no repository, and a shallow clone has no tags. So a failure is
 * a value rather than an exception.
 */
/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string | undefined}
 */
function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/**
 * The semver in a `v1.2.3` tag, or undefined for anything else.
 *
 * @param {string | undefined} tag
 * @returns {string | undefined}
 */
export function semverFromTag(tag) {
  if (typeof tag !== "string") return undefined;
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(tag.trim());
  return match?.[1];
}

/**
 * The version for this build.
 *
 * `env` and `describe` are injected so the rules above can be tested without a
 * repository to arrange — see test/version.test.ts. `describe` distinguishes its
 * two empty values on purpose: `undefined` means "ask git", and `null` means
 * "there is no repository". Collapsing them would make the no-repository case
 * untestable anywhere that happens to be inside a checkout, which is everywhere
 * the tests run.
 *
 * @param {{ env?: Record<string, string | undefined>, root?: string, describe?: GitState | null }} [options]
 * @returns {string}
 */
export function resolveVersion({ env = process.env, root = defaultRoot(), describe } = {}) {
  const declared = env.QUANTITATS_MCP_VERSION?.trim();
  if (declared) return declared;

  const base = packageVersion(root);
  const state = describe === undefined ? gitState(root) : describe;
  if (!state) return `${base}+unknown`;

  const released = semverFromTag(state.tag);
  if (released) return released;

  const suffix = `${base}-dev.${state.commits}+${state.sha}`;
  return state.dirty ? `${suffix}.dirty` : suffix;
}

/**
 * What git can say about HEAD, or null when there is no repository.
 *
 * @param {string} [root]
 * @returns {GitState | null}
 */
export function gitState(root = defaultRoot()) {
  const sha = git(["rev-parse", "--short=12", "HEAD"], root);
  if (!sha) return null;
  return {
    sha,
    // --points-at rather than `describe --tags`: a version must come from a tag
    // ON this commit, never from the nearest one behind it, or every commit
    // after v1.0.0 would call itself v1.0.0.
    tag: git(["tag", "--points-at", "HEAD", "v*"], root)?.split("\n")[0],
    commits: git(["rev-list", "--count", "HEAD"], root) ?? "0",
    dirty: git(["status", "--porcelain"], root) !== "",
  };
}

/**
 * `node scripts/version.mjs` prints the version; with --github-output it appends
 * `version=` and `tag=` to $GITHUB_OUTPUT so a workflow can compute both once
 * and hand them to every architecture's build.
 *
 * Guarded so importing this module — which the build script and the tests both
 * do — runs none of it.
 */
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { appendFileSync } = await import("node:fs");
  // A tag push is the authority on its own version: reading it from the ref is
  // exact, where `git tag --points-at` depends on the tags having been fetched.
  const ref = process.env.GITHUB_REF ?? "";
  const fromRef = ref.startsWith("refs/tags/") ? semverFromTag(ref.slice("refs/tags/".length)) : undefined;
  const version = fromRef ?? resolveVersion();
  const tag = dockerTag(version);

  if (process.argv.includes("--github-output") && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `released=${fromRef ? "true" : "false"}\n`);
  }
  process.stdout.write(`${version}\n`);
}
