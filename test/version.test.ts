import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { dockerTag, packageVersion, resolveVersion, semverFromTag } from "../scripts/version.mjs";
import { PACKAGE_VERSION, VERSION } from "../src/version.ts";

const root = join(import.meta.dirname, "..");

describe("the package version", () => {
  it("is the same in package.json and in the source", () => {
    // src/version.ts restates it so that nothing has to import JSON at runtime.
    // This is the only thing keeping the two the same.
    const declared = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    expect(PACKAGE_VERSION).toBe(declared);
    expect(packageVersion(root)).toBe(declared);
  });
});

describe("the version the server reports", () => {
  it("says it came from source when nothing was stamped", () => {
    // Under vitest there is no build step, so __BUILD_VERSION__ is undefined and
    // the fallback applies. A built bundle carries the real string — the build
    // substitutes a literal, which test/build.test.ts checks.
    expect(VERSION).toBe(`${PACKAGE_VERSION}+source`);
  });
});

describe("semverFromTag", () => {
  it("accepts a v-prefixed semver and nothing else", () => {
    expect(semverFromTag("v1.2.3")).toBe("1.2.3");
    expect(semverFromTag("v1.2.3-rc.1")).toBe("1.2.3-rc.1");
    expect(semverFromTag("v0.0.1+build.5")).toBe("0.0.1+build.5");
  });

  it("rejects anything that is not one", () => {
    for (const tag of ["1.2.3", "v1.2", "release-1.2.3", "vlatest", "", undefined]) {
      expect(semverFromTag(tag as string), String(tag)).toBeUndefined();
    }
  });
});

describe("resolveVersion", () => {
  const base = packageVersion(root);

  it("takes an explicit version verbatim, which is what CI hands every build", () => {
    // One version per run, threaded to every architecture, so the image tag and
    // the string the server reports cannot disagree.
    expect(resolveVersion({ env: { QUANTITATS_MCP_VERSION: "9.9.9" }, root })).toBe("9.9.9");
  });

  it("uses a release tag pointing at HEAD", () => {
    const describe_ = { sha: "abc123abc123", tag: "v2.0.0", commits: "40", dirty: false };
    expect(resolveVersion({ env: {}, root, describe: describe_ })).toBe("2.0.0");
  });

  it("builds a dev version that sorts below the release it precedes", () => {
    // -dev, not +dev: semver orders a prerelease BELOW the plain version, which
    // is the direction that makes "is this newer than 0.2.0" answerable.
    const version = resolveVersion({
      env: {},
      root,
      describe: { sha: "abc123abc123", tag: "", commits: "40", dirty: false },
    });
    expect(version).toBe(`${base}-dev.40+abc123abc123`);
    expect(version).toMatch(/-dev\./);
  });

  it("marks an uncommitted tree, so a local build cannot pass for a clean one", () => {
    expect(
      resolveVersion({ env: {}, root, describe: { sha: "abc123abc123", tag: "", commits: "40", dirty: true } }),
    ).toBe(`${base}-dev.40+abc123abc123.dirty`);
  });

  it("says unknown rather than looking like a release when there is no repository", () => {
    // A source tarball, or a container build with .git excluded — which is
    // exactly how the image is built, which is why CI passes the version in.
    //
    // `null`, not `undefined`: undefined means "ask git", which inside a checkout
    // would answer, and this case would never be exercised.
    expect(resolveVersion({ env: {}, root, describe: null })).toBe(`${base}+unknown`);
  });

  it("asks git when nothing is injected", () => {
    // The ordinary path, and the one `npm run build` takes locally.
    expect(resolveVersion({ env: {}, root })).toMatch(new RegExp(`^${base.replace(/\./g, "\\.")}`));
  });

  it("ignores a tag that is not a version", () => {
    expect(
      resolveVersion({ env: {}, root, describe: { sha: "abc123abc123", tag: "nightly", commits: "7", dirty: false } }),
    ).toBe(`${base}-dev.7+abc123abc123`);
  });
});

describe("dockerTag", () => {
  it("replaces the semver + that a container reference may not carry", () => {
    // A reference allows [A-Za-z0-9_.-]. The `+` is required in the version and
    // illegal in the tag, so it becomes `_` — reversible by eye.
    expect(dockerTag("0.1.0-dev.40+abc123abc123")).toBe("0.1.0-dev.40_abc123abc123");
    expect(dockerTag("0.1.0+unknown")).toBe("0.1.0_unknown");
  });

  it("leaves a release version alone", () => {
    expect(dockerTag("1.2.3")).toBe("1.2.3");
  });

  it("produces only characters a reference allows", () => {
    for (const version of ["1.2.3", "0.1.0-dev.4+ab.dirty", "0.1.0+unknown", "1.0.0-rc.1"]) {
      expect(dockerTag(version), version).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/);
    }
  });

  it("never begins with a separator", () => {
    expect(dockerTag("-broken")).toMatch(/^[A-Za-z0-9_]/);
    expect(dockerTag(".broken")).toMatch(/^[A-Za-z0-9_]/);
  });
});
