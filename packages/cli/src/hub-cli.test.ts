import { describe, expect, it, vi } from "vitest";
import { handleHubCommand, type HubCliDeps, type ResolvedSource } from "./hub-cli.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function deps(overrides: Partial<HubCliDeps> = {}): HubCliDeps {
  const cleanSource: ResolvedSource = { repository: "git@github.com:acme/x.git", commit: "abcdef1234567", path: "skills/alpha", dirty: false };
  return {
    env: { OSSTACK_HUB_ROOT: "/hub" },
    resolveSource: vi.fn(async () => cleanSource),
    runNode: vi.fn(async () => ({ stdout: JSON.stringify({ status: "registered", candidate_id: "candidate_abcdef0123456789" }), stderr: "", exitCode: 0 })),
    ...overrides,
  };
}

describe("osstack hub candidate", () => {
  it("registers a candidate through the configured Hub root (source reference only)", async () => {
    const d = deps();
    const result = await handleHubCommand(["candidate", "./skills/alpha", "--namespace", "organization/acme", "--json"], d);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "registered", namespace: "organization/acme", source_dirty: false, candidate_id: "candidate_abcdef0123456789" });
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
      stdout: JSON.stringify({ contract: "1.1", status: "published", pushed: true, apiVerified: true, id: "research.alpha", gate: "team", namespace: "organization/acme", releaseId: "organization__acme/research.alpha@0.1.0", digest: DIGEST, storage_key: "organization__acme/research.alpha/0.1.0" }),
      stderr: "", exitCode: 0,
    }));
    const result = await handleHubCommand(["publish", "research.alpha", "--gate", "team", "--surfaces", "api", "--json"], deps({ runNode }));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "published", pushed: true, apiVerified: true, namespace: "organization/acme", release_id: "organization__acme/research.alpha@0.1.0", digest: DIGEST, storage_key: "organization__acme/research.alpha/0.1.0" });
    const [script, argv] = runNode.mock.calls[0]!;
    expect(String(script)).toContain("osstack_publish.mjs");
    expect(argv).toEqual(["research.alpha", "--gate", "team", "--json"]);
  });

  it("NEVER surfaces a dist/packages path as storage_key", async () => {
    const runNode = vi.fn(async () => ({ stdout: JSON.stringify({ status: "published", pushed: true, apiVerified: true, id: "a", gate: "team", packagePath: "dist/packages/organization__acme/a/0.1.0", releaseId: "r", digest: DIGEST }), stderr: "", exitCode: 0 }));
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

describe("osstack hub option-injection + exit mapping + leak safety", () => {
  it("rejects an option-injected flag value (--surfaces --no-push)", async () => {
    const r = await handleHubCommand(["publish", "a", "--surfaces", "--no-push", "--json"], deps());
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: "error", reasons: ["invalid_flag"] });
  });

  it("refuses a dirty source at client/commercial scope even with --allow-dirty", async () => {
    const dirty: ResolvedSource = { repository: "r", commit: "abcdef1234567", path: "p", dirty: true };
    const r = await handleHubCommand(["candidate", "./s", "--namespace", "organization/acme", "--reuse-scope", "client", "--allow-dirty", "--json"], deps({ resolveSource: vi.fn(async () => dirty) }));
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).reasons).toContain("dirty_source_elevated_scope");
  });

  it("maps malformed child output to error(1), not blocked(2), for publish AND candidate", async () => {
    const pub = await handleHubCommand(["publish", "a", "--json"], deps({ runNode: vi.fn(async () => ({ stdout: "garbage", stderr: "", exitCode: 2 })) }));
    expect(pub.exitCode).toBe(1);
    expect(JSON.parse(pub.stdout)).toMatchObject({ status: "error", reasons: ["malformed_output"] });
    const cand = await handleHubCommand(["candidate", "./s", "--namespace", "organization/acme", "--json"], deps({ runNode: vi.fn(async () => ({ stdout: "garbage", stderr: "", exitCode: 0 })) }));
    expect(cand.exitCode).toBe(1);
    expect(JSON.parse(cand.stdout).status).toBe("error");
  });

  it("normalizes a malicious Hub-controlled status to a contract value", async () => {
    const runNode = vi.fn(async () => ({ stdout: JSON.stringify({ status: "published /Volumes/AIMATE_WORK/secret", id: "research.alpha", gate: "team" }), stderr: "", exitCode: 0 }));
    const r = await handleHubCommand(["publish", "research.alpha", "--json"], deps({ runNode }));
    const out = JSON.parse(r.stdout);
    expect(["published", "blocked", "error"]).toContain(out.status);
    expect(JSON.stringify(out)).not.toContain("/Volumes/");
  });

  it("sanitizes a Hub-controlled id that is an absolute/dist path (+ redacts reasons)", async () => {
    const runNode = vi.fn(async () => ({ stdout: JSON.stringify({ status: "published", pushed: true, apiVerified: true, id: "/tmp/dist/packages/secret", gate: "team", releaseId: "organization__acme/research.alpha@0.1.0", digest: DIGEST, reasons: ["see /Volumes/AIMATE_WORK/osborn-hub-store/v1/client-secret"] }), stderr: "", exitCode: 0 }));
    const r = await handleHubCommand(["publish", "research.alpha", "--json"], deps({ runNode }));
    const out = JSON.parse(r.stdout);
    expect(out.id).toBe("research.alpha"); // fell back to the caller's SAFE assetId
    const s = JSON.stringify(out);
    expect(s).not.toContain("dist/packages");
    expect(s).not.toContain("/tmp/");
    expect(s).not.toContain("/Volumes/"); // reasons redacted
  });
});

describe("osstack hub candidate — real companion contract", () => {
  it("treats 'existing' as idempotent success (exit 0) with the Hub candidate id", async () => {
    const runNode = vi.fn(async () => ({ stdout: JSON.stringify({ status: "existing", candidate_id: "candidate_abcdef0123456789", source_dirty: false }), stderr: "", exitCode: 0 }));
    const r = await handleHubCommand(["candidate", "./skills/alpha", "--namespace", "organization/acme", "--json"], deps({ runNode }));
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: "existing", candidate_id: "candidate_abcdef0123456789" });
  });

  it("drops a candidate_id that does not match the Hub's candidate_<16hex> format", async () => {
    const runNode = vi.fn(async () => ({ stdout: JSON.stringify({ status: "registered", candidate_id: "/Volumes/evil/path" }), stderr: "", exitCode: 0 }));
    const r = await handleHubCommand(["candidate", "./skills/alpha", "--namespace", "organization/acme", "--json"], deps({ runNode }));
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.candidate_id).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("/Volumes/");
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


describe("osstack hub delivery evidence", () => {
  const publishResult = (payload: Record<string, unknown>, exitCode = 0) => deps({
    runNode: vi.fn(async () => ({ stdout: JSON.stringify({ status: "published", id: "research.alpha", ...payload }), stderr: "", exitCode })),
  });
  it.each([
    [{ committed: true, pushed: false, apiVerified: false }, "local_only"],
    [{ committed: true, pushed: true, apiVerified: false }, "pushed_unverified"],
    [{}, "unknown"],
    [{ pushed: "true", apiVerified: "true" }, "unknown"],
  ])("fails closed for unverified delivery %j", async (payload, delivery) => {
    const r = await handleHubCommand(["publish", "research.alpha", "--json"], publishResult(payload as Record<string, unknown>));
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: "error", delivery, reasons: ["api_delivery_unverified"] });
    expect(JSON.parse(r.stdout).release_id).toBeUndefined();
  });
  it("preserves partial failure evidence without claiming delivery", async () => {
    const r = await handleHubCommand(["publish", "research.alpha", "--json"], publishResult({ status: "error", committed: true, pushed: false, apiVerified: false, reasons: ["push_failed"] }, 1));
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ committed: true, pushed: false, apiVerified: false, reasons: ["push_failed"] });
  });
  it("rejects success JSON from a failed child", async () => {
    const r = await handleHubCommand(["publish", "research.alpha", "--json"], publishResult({ pushed: true, apiVerified: true }, 1));
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: "error", delivery: "unknown", reasons: ["publisher_exit_failure"] });
  });
  it("rejects success for a different asset", async () => {
    const r = await handleHubCommand(["publish", "research.alpha", "--json"], publishResult({ id: "research.beta", pushed: true, apiVerified: true }));
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).reasons).toContain("publisher_id_mismatch");
  });
  it.each(["none", "store"])("refuses unsupported surface %s before any child execution", async (surface) => {
    const d = deps();
    const r = await handleHubCommand(["publish", "research.alpha", "--surfaces", surface, "--json"], d);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).reasons).toEqual(["unsupported_surface"]);
    expect(d.runNode).not.toHaveBeenCalled();
  });
  it.each(["-x", "../alpha", "/tmp/alpha"])("rejects invalid asset ID %s before execution", async (id) => {
    const d = deps();
    expect((await handleHubCommand(["publish", id, "--json"], d)).exitCode).toBe(1);
    expect(d.runNode).not.toHaveBeenCalled();
  });
});

describe("osstack hub doctor routing", () => {
  it("runs without a Hub root and never starts a publisher or git resolver", async () => {
    const doctor = vi.fn(async () => ({ status: "needs_configuration", api_read: "missing_key", reasons: ["no_hub_root"] }));
    const d = deps({ env: {}, doctor });
    const r = await handleHubCommand(["doctor", "--json"], d);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).reasons).toContain("no_hub_root");
    expect(doctor).toHaveBeenCalledWith({});
    expect(d.runNode).not.toHaveBeenCalled();
    expect(d.resolveSource).not.toHaveBeenCalled();
  });
  it("shows the publish route and unverified permission in text mode", async () => {
    const d = deps({ doctor: vi.fn(async () => ({ status: "configured", api_read: "reachable", reasons: [] })) });
    const r = await handleHubCommand(["doctor"], d);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("osstack hub publish");
    expect(r.stdout).toContain("publish permission: unverified");
  });
});
