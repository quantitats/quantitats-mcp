import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ENDPOINTS } from "../src/catalogue.ts";
import { buildServer } from "../src/server.ts";
import { hmacSigner } from "../src/signing.ts";

/**
 * Nothing a user can observe names what this is built from.
 *
 * A tool manifest is squarely observable: every title, description and argument
 * description is handed to a model and shown in a client's tool list, and the
 * server's instructions are read before a single call is made. So the denylist
 * below is checked against what this server actually sends, not against the
 * source — a name that reached the manifest through a template or a default
 * would pass a grep over string literals and fail here.
 *
 * Code comments are not user-facing and are not checked. That is why the
 * catalogue may say in a comment what it may not say in a description.
 *
 * "deployment" is deliberately absent from the list. The published docs use it
 * for "an installation of this product" — "not every deployment serves every
 * endpoint" — which names nothing. It is the orchestration object of the same
 * name that may not be described, and no word here describes one.
 */
const denied = [
  // Named products.
  "kafka",
  "redis",
  "keycloak",
  "openbao",
  "loki",
  "postgres",
  "postgresql",
  "kubernetes",
  "next.js",
  "auth.js",
  "vault",
  "grafana",
  // Words that name no product but describe one unmistakably.
  "kubectl",
  "namespace",
  "configmap",
  "ingress",
  "kubelet",
  "sidecar",
];

/** Every word a client is shown, gathered from the manifest the server serves. */
function observableText(): { where: string; text: string }[] {
  const found: { where: string; text: string }[] = [];
  for (const endpoint of ENDPOINTS) {
    found.push({ where: `${endpoint.name}.title`, text: endpoint.title });
    found.push({ where: `${endpoint.name}.description`, text: endpoint.description });
    for (const [arg, schema] of Object.entries(endpoint.input)) {
      const description = (schema as { description?: string }).description;
      if (description) found.push({ where: `${endpoint.name}.${arg}`, text: description });
    }
  }
  return found;
}

describe("what a client is shown", () => {
  it("names no product this is built from, and no word that describes one", () => {
    for (const { where, text } of observableText()) {
      for (const name of denied) {
        expect(text.toLowerCase(), `${where} says "${name}"`).not.toContain(name);
      }
    }
  });

  it("checks the server's instructions too, which are read before any call", () => {
    const server = buildServer({
      baseUrl: "https://api.example.com",
      keyId: "ak_test",
      signer: hmacSigner(Buffer.alloc(32).toString("base64")),
      timeoutMs: 1000,
      readOnly: false,
    });
    // Reaching for the instructions the server was constructed with rather than
    // connecting: this asserts about the text, and a transport would only add a
    // way for the test to be flaky.
    const instructions = (server as unknown as { server: { _instructions?: string } }).server._instructions ?? "";
    expect(instructions.length).toBeGreaterThan(0);
    for (const name of denied) {
      expect(instructions.toLowerCase()).not.toContain(name);
    }
  });

  it("checks the README and the environment sample, which a user reads first", () => {
    const root = join(import.meta.dirname, "..");
    for (const file of ["README.md", ".env.example"]) {
      const text = readFileSync(join(root, file), "utf8").toLowerCase();
      for (const name of denied) {
        expect(text, `${file} says "${name}"`).not.toContain(name);
      }
    }
  });
});

describe("the source", () => {
  it("writes nothing to stdout, which carries JSON-RPC and nothing else", () => {
    // A stray console.log anywhere in this tree corrupts the transport, and the
    // symptom is a client that fails to start with no useful message.
    const dir = join(import.meta.dirname, "..", "src");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      // Comments stripped first: this file's own explanation of the rule
      // mentions the call it forbids, and so does main.ts.
      const source = readFileSync(join(dir, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(source, `${file} writes to stdout`).not.toMatch(/console\.(log|info|debug)|process\.stdout\.write/);
    }
  });
});
