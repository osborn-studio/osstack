import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { HubPackage, parseHubPackage } from "./hub-package.js";

// Resolve test-vectors relative to the repo root (packages/contracts/src -> ../../..).
const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(HERE, "..", "..", "..", "test-vectors", "hub-package");

async function vector(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(VECTORS, name), "utf8"));
}

describe("Hub Package v1 contract (osstack consumer mirror)", () => {
  it("parses the released Hub v1 team vector", async () => {
    const parsed = parseHubPackage(await vector("team-skill-package.json"));
    expect(parsed).toMatchObject({ schema_version: "1.0", kind: "osbornhub.package" });
    expect(parsed.asset).toMatchObject({ type: "skill", id: "research.alpha-brief", version: "0.1.0" });
    expect(parsed.namespace).toMatchObject({ kind: "organization", id: "osborn" });
    expect(parsed.release.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("parses the released Hub v1 client-restricted vector", async () => {
    const parsed = parseHubPackage(await vector("client-restricted-package.json"));
    expect(parsed.rights.reuse_scope).toBe("client");
    expect(parsed.rights.client_restrictions.length).toBeGreaterThan(0);
  });

  it("rejects packages with no immutable digest", () => {
    expect(() => HubPackage.parse({})).toThrow();
  });

  it("rejects a malformed release digest", async () => {
    const bad = (await vector("team-skill-package.json")) as Record<string, unknown>;
    (bad.release as Record<string, unknown>).digest = "sha256:not-hex";
    expect(() => parseHubPackage(bad)).toThrow();
  });

  it("rejects an unknown reuse_scope / gate (enum-bound)", async () => {
    const bad = (await vector("team-skill-package.json")) as Record<string, unknown>;
    (bad.rights as Record<string, unknown>).reuse_scope = "public";
    expect(() => parseHubPackage(bad)).toThrow();
  });

  it("rejects a non-SemVer asset.version", async () => {
    const bad = (await vector("team-skill-package.json")) as Record<string, unknown>;
    (bad.asset as Record<string, unknown>).version = "1.0";
    expect(() => parseHubPackage(bad)).toThrow();
  });

  it("requires at least one file with a 64-hex sha256", async () => {
    const bad = (await vector("team-skill-package.json")) as Record<string, unknown>;
    bad.files = [];
    expect(() => parseHubPackage(bad)).toThrow();
  });
});
