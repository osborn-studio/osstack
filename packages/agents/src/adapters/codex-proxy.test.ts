import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScratchDirSync } from "@osstack/core";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_PROXY_PATCH_MAX_BYTES, CodexProxyExecutor, processGroupEmpty, readCodexProxyPatch } from "./codex-proxy.js";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => { fn(); }); });

// Stands in for the codex launcher. FAKE_MODE selects exec behaviour and FAKE_SANDBOX the `codex sandbox` behaviour.
const FAKE = `#!${process.execPath}
const { spawn, spawnSync } = require("node:child_process"); const fs = require("node:fs"); const path = require("node:path");
const args = process.argv.slice(2); const mode = process.env.FAKE_MODE || "ok";
if (args[0] === "--version") { console.log("codex-cli 0.160.1"); process.exit(0); }
if (args[0] === "sandbox") {
  const cmd = args.slice(args.indexOf("--") + 1); const wt = cmd[2]; const tag = cmd[5];
  const sb = process.env.FAKE_SANDBOX || "deny";
  const row = who => JSON.stringify({ who, write_worktree: "denied", write_outside: "denied", write_gitdir: "denied", network: "denied" });
  if (sb === "none") { const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" }); process.exit(r.status ?? 1); }
  if (sb === "liar") fs.writeFileSync(path.join(wt, "probe-parent-" + tag), "x");
  if (sb === "child-only") { console.log(row("parent")); process.exit(0); }
  console.log(row("parent")); console.log(row("escaped_child")); process.exit(0);
}
const out = args[args.indexOf("-o") + 1];
console.log(JSON.stringify({ args, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, keys: Object.keys(process.env).sort() }));
if (mode === "ok") fs.writeFileSync(out, "--- a/a.txt\\n+++ b/a.txt\\n@@ -1 +1 @@\\n-hi\\n+hello\\nEND-OF-PATCH");
if (mode === "nomarker") fs.writeFileSync(out, "--- a/a.txt\\n+++ b/a.txt\\n");
if (mode === "linger") { spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" }).unref(); fs.writeFileSync(out, "END-OF-PATCH\\n"); }
if (mode === "hang") { spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" }); setTimeout(() => {}, 60000); }
`;

function setup(env: Record<string, string> = {}) {
  const root = realpathSync(createScratchDirSync("tests", "codex-proxy"));
  cleanup.push(() => { rmSync(root, { recursive: true, force: true }); });
  const bin = join(root, "codex"); writeFileSync(bin, FAKE); chmodSync(bin, 0o755);
  const source = join(root, "source-codex"); mkdirSync(source);
  writeFileSync(join(source, "auth.json"), '{"token":"t"}'); writeFileSync(join(source, "config.toml"), 'mcp_servers.x.command="/bin/sh"\n');
  const repo = join(root, "repo"); mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const previous = { ...process.env };
  Object.assign(process.env, env, { OSSTACK_SECRET_TOKEN: "s3cret", GH_TOKEN: "gh", OSSTACK_HOME: "/nope" });
  cleanup.push(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  const executor = new CodexProxyExecutor({ bin, sourceCodexHome: source, runtimeDir: join(root, "runtime"), passEnv: Object.keys(env), timeoutMs: 5_000, terminationGraceMs: 200 });
  return { root, bin, source, repo, executor };
}

describe("CodexProxyExecutor", () => {
  it("runs read-only with config and rules ignored, and an isolated home holding only the copied login", async () => {
    const f = setup({ FAKE_MODE: "ok" });
    const run = await f.executor.run({ worktree: f.repo, prompt: "propose" });
    const seen = JSON.parse(run.stdout.split("\n")[0]!) as { args: string[]; HOME: string; CODEX_HOME: string; keys: string[] };
    expect(seen.args.slice(0, 9)).toEqual(["exec", "-s", "read-only", "-C", f.repo, "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules"]);
    expect(seen.args).not.toContain("--add-dir");
    expect(seen.HOME.startsWith(join(f.root, "runtime"))).toBe(true);
    expect(readdirSync(seen.CODEX_HOME)).toEqual(["auth.json"]);
    expect(seen.keys).not.toEqual(expect.arrayContaining(["OSSTACK_SECRET_TOKEN"]));
    for (const key of ["GH_TOKEN", "OSSTACK_HOME", "OSSTACK_SECRET_TOKEN", "SSH_AUTH_SOCK"]) expect(seen.keys).not.toContain(key);
    expect(run.patch).toEqual({ ok: true, text: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-hi\n+hello\n", bytes: expect.any(Number) });
    expect(run.stop?.stop_proof).toBe("group_empty+sandbox_inherited");
    expect(processGroupEmpty(run.launch.pgid)).toBe(true);
  });

  it("never reuses a previous turn's output and rejects an incomplete patch", async () => {
    const f = setup({ FAKE_MODE: "ok" });
    await f.executor.run({ worktree: f.repo, prompt: "first" });
    process.env["FAKE_MODE"] = "silent";
    expect((await f.executor.run({ worktree: f.repo, prompt: "second" })).patch).toEqual({ ok: false, reason: "PATCH_MISSING" });
    process.env["FAKE_MODE"] = "nomarker";
    expect((await f.executor.run({ worktree: f.repo, prompt: "third" })).patch).toEqual({ ok: false, reason: "PATCH_INCOMPLETE" });
  });

  it("journals the launch before reading output and kills a lingering group member before claiming stop", async () => {
    const f = setup({ FAKE_MODE: "linger" });
    const launches: number[] = [];
    const run = await f.executor.run({ worktree: f.repo, prompt: "p", onLaunched: l => { launches.push(l.pgid); } });
    expect(launches).toEqual([run.launch.pgid]);
    expect(run.stop).toBeDefined();
    expect(run.stop!.signals).toContain("SIGTERM");
    expect(processGroupEmpty(run.launch.pgid)).toBe(true);
  });

  it("stops the whole group on cancellation and on timeout", async () => {
    const f = setup({ FAKE_MODE: "hang" });
    const controller = new AbortController();
    const pending = f.executor.run({ worktree: f.repo, prompt: "p", signal: controller.signal, onLaunched: () => { setTimeout(() => controller.abort(), 100); } });
    const cancelled = await pending;
    expect(cancelled).toMatchObject({ cancelled: true, timed_out: false });
    expect(cancelled.stop).toBeDefined(); expect(processGroupEmpty(cancelled.launch.pgid)).toBe(true);
    const quick = new CodexProxyExecutor({ bin: f.bin, sourceCodexHome: f.source, runtimeDir: join(f.root, "runtime2"), passEnv: ["FAKE_MODE"], timeoutMs: 150, terminationGraceMs: 200 });
    const timed = await quick.run({ worktree: f.repo, prompt: "p" });
    expect(timed.timed_out).toBe(true); expect(timed.stop).toBeDefined();
  }, 15_000);
});

describe("qualification probe", () => {
  function gitDir(repo: string) { return join(repo, ".git"); }
  it("qualifies only when both the probe and its escaped child are denied every operation", async () => {
    const f = setup({ FAKE_SANDBOX: "deny" });
    const q = await f.executor.qualify(f.repo, gitDir(f.repo));
    expect(q).toMatchObject({ qualified: true, version: "codex-cli 0.160.1", profile: ":read-only", reasons: [] });
    expect(q.identity_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("fails closed without a sandbox: the real probe writes and the host sees it", async () => {
    const f = setup({ FAKE_SANDBOX: "none" });
    const q = await f.executor.qualify(f.repo, gitDir(f.repo));
    expect(q.qualified).toBe(false);
    expect(q.reasons).toEqual(expect.arrayContaining(["PARENT_WRITE_WORKTREE_ALLOWED", "ESCAPED_CHILD_WRITE_OUTSIDE_ALLOWED", "HOST_OBSERVED_WRITE"]));
    expect(q.host_observed_writes.every(p => !existsSync(p))).toBe(true);
  });
  it("does not trust a sandbox that reports denial while writing", async () => {
    const f = setup({ FAKE_SANDBOX: "liar" });
    const q = await f.executor.qualify(f.repo, gitDir(f.repo));
    expect(q).toMatchObject({ qualified: false, reasons: ["HOST_OBSERVED_WRITE"] });
  });
  it("treats a missing escaped-child report as not qualified", async () => {
    const f = setup({ FAKE_SANDBOX: "child-only" });
    const q = await f.executor.qualify(f.repo, gitDir(f.repo));
    expect(q.qualified).toBe(false);
    expect(q.reasons).toContain("ESCAPED_CHILD_NETWORK_MISSING");
  });
});

describe("readCodexProxyPatch", () => {
  const file = (content: string | Buffer) => {
    const root = realpathSync(createScratchDirSync("tests", "codex-patch")); cleanup.push(() => { rmSync(root, { recursive: true, force: true }); });
    const path = join(root, "out.txt"); writeFileSync(path, content); return path;
  };
  it("accepts the marker at EOF without a newline and strips it", () => {
    expect(readCodexProxyPatch(file("diff\nEND-OF-PATCH"))).toEqual({ ok: true, text: "diff\n", bytes: 17 });
    expect(readCodexProxyPatch(file("END-OF-PATCH\n\n"))).toEqual({ ok: true, text: "", bytes: 14 });
  });
  it("rejects oversize, invalid UTF-8 and a marker that is not last", () => {
    expect(readCodexProxyPatch(file(`${"x".repeat(CODEX_PROXY_PATCH_MAX_BYTES)}\nEND-OF-PATCH`))).toEqual({ ok: false, reason: "PATCH_TOO_LARGE" });
    expect(readCodexProxyPatch(file(Buffer.from([0xff, 0x0a])))).toEqual({ ok: false, reason: "PATCH_NOT_UTF8" });
    expect(readCodexProxyPatch(file("END-OF-PATCH\nmore"))).toEqual({ ok: false, reason: "PATCH_INCOMPLETE" });
    expect(readFileSync(file("x"), "utf8")).toBe("x");
  });
});

// Opt-in check against the real installed Codex (M0 §5.7). Never runs in CI.
describe.skipIf(process.env["OSSTACK_REAL_CODEX"] !== "1")("real codex sandbox", () => {
  it("qualifies the installed codex in :read-only", async () => {
    const root = realpathSync(createScratchDirSync("tests", "codex-real")); cleanup.push(() => { rmSync(root, { recursive: true, force: true }); });
    const repo = join(root, "repo"); mkdirSync(repo); execFileSync("git", ["init", "-q"], { cwd: repo });
    const executor = new CodexProxyExecutor({ bin: process.env["OSSTACK_CODEX_BIN"] ?? "codex", sourceCodexHome: join(process.env["HOME"]!, ".codex"), runtimeDir: join(root, "runtime") });
    const q = await executor.qualify(repo, join(repo, ".git"));
    expect(q.reasons).toEqual([]); expect(q.qualified).toBe(true);
  }, 120_000);
});
