import { describe, expect, it, vi } from "vitest";
import { handleHubCommand, type HubCliDeps, type ResolvedSource } from "./hub-cli.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function deps(overrides: Partial<HubCliDeps> = {}): HubCliDeps {
  const cleanSource: ResolvedSource = { repository: "git@github.com:acme/x.git", commit: "abcdef1234567", path: "skills/alpha", dirty: false };
  return {
    env: { OSSTACK_HUB_ROOT: "/hub" },
    resolveSource: vi.fn(async () => cleanSource),
    runNode: vi.fn(async () => ({ stdout: JSON.stringify({ candidate_id: "cand-123" }), stderr: "", exitCode: 0 })),
    ...overrides,
  };
}

describe("osstack hub candidate", () => {
  it("registers a candidate through the configured Hub root (source reference only)", async () => {
    const d = deps();
    const result = await handleHubCommand(["candidate", "./skills/alpha", "--namespace", "organization/acme", "--json"], d);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "registered", namespace: "organization/acme", source_dirty: false, candidate_id: "cand-123" });
    // invoked Node with an ARGUMENT ARRAY carrying the resolved source triple
    const [, argv] = (d.runNode as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(argv).toEqual(expect.arrayContaining(["--repository", "git@github.com:acme/x.git", "--commit", "abcdef1234567", "--path", "skills/alpha", "--json"]));
  });

  it("refuses a dirty source unless --allow-dirty", async () => {
    const dirty: ResolvedSource = { repository: "r", commit: "abcdef1234567", path: "skills/alpha", dirty: true };
    const blocked = await handleHubCommand(["candidate", "./skills/alpha", "--namespace", "organization/acme", "--json"], deps({ resolveSource: vi.fn(async () => dirty) }));
    expect(blocked.exitCode).toBe(2);
    expect(JSON.parse(blocked.stdout)).toMatchObject({ status: "blocked", reasons: ["dirty_source"] });
  });

  it("allows a dirty registration with --allow-dirty and records source_dirty:true", async () => {
    const dirty: ResolvedSource = { repository: "r", commit: "abcdef1234567", path: "skills/alpha", dirty: true };
    const d = deps({ resolveSource: vi.fn(async () => dirty) });
    const ok = await handleHubCommand(["candidate", "./skills/alpha", "--namespace", "organization/acme", "--allow-dirty", "--json"], d);
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ status: "registered", source_dirty: true });
    const [, argv] = (d.runNode as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(argv).toContain("--source-dirty");
  });

  it("rejects an invalid namespace", async () => {
    const r = await handleHubCommand(["candidate", "./skills/alpha", "--namespace", "bogus", "--json"], deps());
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: "error", reasons: ["invalid_namespace"] });
  });
});

describe("osstack hub publish", () => {
  it("publishes and prints immutable release identity (logical locator, no dist path)", async () => {
    const runNode = vi.fn(async (_script: string, _argv: string[]) => ({
      stdout: JSON.stringify({ contract: "1.1", status: "published", id: "research.alpha", gate: "team", namespace: "organization/acme", releaseId: "organization__acme/research.alpha@0.1.0", digest: DIGEST, storage_key: "organization__acme/research.alpha/0.1.0" }),
      stderr: "", exitCode: 0,
    }));
    const result = await handleHubCommand(["publish", "research.alpha", "--gate", "team", "--surfaces", "api", "--json"], deps({ runNode }));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "published", namespace: "organization/acme", release_id: "organization__acme/research.alpha@0.1.0", digest: DIGEST, storage_key: "organization__acme/research.alpha/0.1.0" });
    const [script, argv] = runNode.mock.calls[0]!;
    expect(String(script)).toContain("osstack_publish.mjs");
    expect(argv).toEqual(["research.alpha", "--gate", "team", "--surfaces", "api", "--json"]);
  });

  it("NEVER surfaces a dist/packages path as storage_key", async () => {
    const runNode = vi.fn(async () => ({ stdout: JSON.stringify({ status: "published", id: "a", gate: "team", packagePath: "dist/packages/organization__acme/a/0.1.0", releaseId: "r", digest: DIGEST }), stderr: "", exitCode: 0 }));
    const r = await handleHubCommand(["publish", "a", "--json"], deps({ runNode }));
    expect(JSON.parse(r.stdout).storage_key).toBeUndefined();
  });

  it("returns blocked with reasons and NO release identity on a blocked publish", async () => {
    const runNode = vi.fn(async () => ({ stdout: JSON.stringify({ status: "blocked", id: "a", gate: "team", reasons: ["score<gate"] }), stderr: "", exitCode: 2 }));
    const r = await handleHubCommand(["publish", "a", "--json"], deps({ runNode }));
    expect(r.exitCode).toBe(2);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ status: "blocked", reasons: ["score<gate"] });
    expect(out.release_id).toBeUndefined();
    expect(out.digest).toBeUndefined();
  });
});

describe("osstack hub errors", () => {
  it("errors without a Hub root", async () => {
    const r = await handleHubCommand(["publish", "a", "--json"], deps({ env: {} }));
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: "error", reasons: ["no_hub_root"] });
  });
  it("errors on an unknown subcommand", async () => {
    const r = await handleHubCommand(["frobnicate", "--json"], deps());
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ reasons: ["unknown_subcommand"] });
  });
});
