import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hardenedGitEnvironment, type CodexProxyRun, type CodexQualification } from "@osstack/agents";
import { AttentionStore, ContainedMissionStore, createScratchDirSync, openDb, type ContainedMission } from "@osstack/core";
import { afterEach, describe, expect, it } from "vitest";
import { ContainedMissionHost, resolveContainedMissionStart } from "./contained-mission-host.js";
import { createContainedMissionPorts, type ContainedMissionHostPorts } from "./contained-mission-ports.js";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => { fn(); }); });
const env = { ...hardenedGitEnvironment(process.env), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const PATCH = "--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-hi\n+hello\n";
const qualified: CodexQualification = { qualified: true, version: "codex-cli 0.160.1", identity_sha256: "f".repeat(64), profile: ":read-only",
  results: { parent: { write_worktree: "denied", write_outside: "denied", write_gitdir: "denied", network: "denied" }, escaped_child: { write_worktree: "denied", write_outside: "denied", write_gitdir: "denied", network: "denied" } },
  host_observed_writes: [], reasons: [] };
const run = (patch = PATCH): CodexProxyRun => ({ launch: { pid: 4242, pgid: 4242, started_at: 1 }, exit_code: 0, signal: null, timed_out: false, cancelled: false,
  stop: { stop_proof: "group_empty+sandbox_inherited", pgid: 4242, signals: [], confirmed_at: 2 }, patch: { ok: true, text: patch, bytes: patch.length },
  stdout: "", stderr: "", stdout_truncated: false, stderr_truncated: false });

function fixture(over: Partial<ContainedMissionHostPorts> = {}, hostOver: { maxConcurrent?: number; empty?: (pgid: number) => boolean } = {}) {
  const root = realpathSync(createScratchDirSync("tests", "contained-host"));
  const repo = join(root, "repo"); mkdirSync(repo);
  for (const [path, content] of Object.entries({ "src/a.txt": "hi\n", "src/b.txt": "bye\n", "package.json": "{}\n" })) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content); }
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "initial");
  const path = join(root, "state.db"); const db = openDb({ path }); db.pragma("synchronous=FULL");
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const attention = new AttentionStore(db, path); const owner = attention.claimOwner("owner");
  const scope = attention.registerScope(owner, "t", root);
  const store = new ContainedMissionStore(attention, owner);
  const journalRoot = join(root, "journal"); mkdirSync(journalRoot);
  const worktreesRoot = join(root, "worktrees");
  let clock = 1000;
  const calls = { execute: 0, verify: 0 };
  let patch = PATCH; let gate: Promise<void> | undefined;
  const real = createContainedMissionPorts({ store, now: () => ++clock, codex: { bin: join(root, "no-codex"), sourceCodexHome: root }, runtimeRoot: join(root, "runtime"),
    verification: { socketPath: join(root, "docker.sock"), daemonId: "d", baseImageId: "sha256:" + "0".repeat(64), journalRoot }, author: { name: "Mission Host", email: "host@example.invalid" } });
  const ports: ContainedMissionHostPorts = { ...real,
    qualify: async () => qualified,
    execute: async input => { calls.execute++; input.onLaunched({ pid: 4242, pgid: 4242, started_at: 1 }); if (gate) await gate; return run(patch); },
    verify: async () => { calls.verify++; return { exit_code: 0, output: "ok", cancelled: false, evidence: "docker-removed:x", stopped: true }; },
    ...over };
  let empty = hostOver.empty ?? (() => true);
  const host = new ContainedMissionHost({ ports, worktreesRoot, processGroupEmpty: pgid => empty(pgid), ...(hostOver.maxConcurrent ? { maxConcurrent: hostOver.maxConcurrent } : {}) });
  const principal = { principal_id: "human", client_session_id: "cli", read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [], operator_scopes: [] };
  const start = async () => host.start(principal, { scope_id: scope.scope_id, spec: await resolveContainedMissionStart({ goal: "say hello", repo_path: repo, base_ref: "main", allowed_paths: ["src/**"], verify: { argv: ["true"] } }, { worktreesRoot }) });
  const reason = (id: string) => { const e = store.events(id, 0, 500).filter(x => x.kind === "halted").at(-1); return e ? (JSON.parse(e.payload_json) as { reason: string }).reason : undefined; };
  return { root, repo, store, host, principal, start, calls, reason, now: () => ++clock,
    setPatch: (p: string) => { patch = p; }, setGate: (g: Promise<void> | undefined) => { gate = g; }, setEmpty: (fn: (pgid: number) => boolean) => { empty = fn; } };
}
type Fixture = ReturnType<typeof fixture>;
const spec = (m: ContainedMission) => JSON.parse(m.spec_json) as { worktree_path: string; branch: string; start_commit: string };
async function ticks(f: Fixture, n: number) { for (let i = 0; i < n; i++) await f.host.tick(); }
/** A daemon that crashed mid-turn: workspace created, executor launched, nothing settled. */
async function orphanExecuting(f: Fixture, launched = true): Promise<ContainedMission> {
  const m = await f.start();
  await f.host.tick();
  let current = f.store.get(m.mission_id);
  current = f.store.transition(m.mission_id, { if_revision: current.revision, to: "executing", expected_head: spec(m).start_commit, event: { kind: "executor_launch_intent", payload: {} } }, f.now());
  if (launched) f.store.record(m.mission_id, "executor_started", { pid: 7777, pgid: 7777, started_at: 1 }, f.now());
  return current;
}

describe("ContainedMissionHost", () => {
  it("runs start to a publication decision through tick, with the patch on the branch", async () => {
    const f = fixture();
    const m = await f.start();
    expect(m.state).toBe("authorized");
    expect(spec(m).branch).toMatch(/^osstack\/mission\/[0-9a-f]{12}$/);
    await ticks(f, 4);
    const done = f.store.get(m.mission_id);
    expect(done).toMatchObject({ state: "awaiting_decision", candidate_verified: 1, stop_obligation: 0 });
    expect(f.reason(m.mission_id)).toBe("publication_pending");
    expect(sh(f.repo, "show", `refs/heads/${spec(m).branch}:src/a.txt`)).toBe("hello");
    expect(sh(f.repo, "rev-parse", `refs/heads/${spec(m).branch}`)).toBe(done.candidate_head);
    const status = f.host.status(f.principal, m.mission_id);
    expect(status.events.length).toBeGreaterThan(0); expect(status.claim.state).toBe("active");
    await ticks(f, 1);
    expect(f.store.get(m.mission_id).state).toBe("awaiting_decision");
  });

  it("refuses a spec whose worktree is outside the worktrees root or whose branch is not a mission branch", async () => {
    const f = fixture();
    const good = await resolveContainedMissionStart({ goal: "g", repo_path: f.repo, base_ref: "main", allowed_paths: ["src/**"], verify: { argv: ["true"] } }, { worktreesRoot: join(f.root, "worktrees") });
    const scope = f.principal.write_scopes[0]!;
    expect(() => f.host.start(f.principal, { scope_id: scope, spec: { ...good, worktree_path: join(f.root, "elsewhere") } })).toThrow("CONTAINED_SPEC_INVALID");
    expect(() => f.host.start(f.principal, { scope_id: scope, spec: { ...good, branch: "main" } })).toThrow("CONTAINED_SPEC_INVALID");
    expect(() => f.host.start({ ...f.principal, write_scopes: [] }, { scope_id: scope, spec: good })).toThrow("permission_denied");
  });

  it("never steps one Mission twice concurrently", async () => {
    const f = fixture();
    const m = await f.start();
    await f.host.tick();
    let release!: () => void; f.setGate(new Promise<void>(resolve => { release = resolve; }));
    const first = f.host.tick();
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = f.host.tick();
    await second;
    expect(f.calls.execute).toBe(1);
    expect(f.host.status(f.principal, m.mission_id).stepping).toBe(true);
    await expect(f.host.decide(f.principal, m.mission_id, { kind: "abandon" })).rejects.toThrow("CONTAINED_MISSION_BUSY");
    release(); await first;
    expect(f.store.get(m.mission_id).state).toBe("candidate_ready");
  });

  it("bounds concurrent steps across Missions", async () => {
    const f = fixture();
    const a = await f.start(); const b = await f.start();
    await f.host.tick();
    expect([f.store.get(a.mission_id).state, f.store.get(b.mission_id).state].sort()).toEqual(["authorized", "workspace_ready"]);
  });

  it("records a failing step as an event instead of throwing", async () => {
    const f = fixture({ createWorkspace: async () => { throw new Error("boom"); } });
    const m = await f.start();
    await f.host.tick();
    expect(f.store.get(m.mission_id).state).toBe("awaiting_decision");
    expect(f.reason(m.mission_id)).toBe("workspace_failed:boom");
  });
});

describe("ContainedMissionHost recovery", () => {
  it("moves an orphaned executor whose group is empty to needs_reconciliation", async () => {
    const f = fixture();
    const m = await orphanExecuting(f);
    const seen: number[] = []; f.setEmpty(pgid => { seen.push(pgid); return true; });
    await f.host.recover();
    expect(seen).toEqual([7777]);
    expect(f.store.get(m.mission_id)).toMatchObject({ state: "needs_reconciliation", stop_obligation: 0 });
    const stopped = f.store.events(m.mission_id, 0, 500).filter(e => e.kind === "executor_stopped").at(-1)!;
    expect(JSON.parse(stopped.payload_json)).toMatchObject({ stop_proof: "group_empty_after_restart", pgid: 7777 });
    expect(f.calls.execute).toBe(0);
  });

  it("records never_launched for an executing Mission with no started executor", async () => {
    const f = fixture();
    const m = await orphanExecuting(f, false);
    await f.host.recover();
    expect(f.store.get(m.mission_id)).toMatchObject({ state: "needs_reconciliation", stop_obligation: 0 });
  });

  it("holds stop_unknown while the group is live, and settles only on a later stop check", async () => {
    const f = fixture({}, { empty: () => false });
    const m = await orphanExecuting(f);
    await f.host.recover();
    expect(f.store.get(m.mission_id)).toMatchObject({ state: "stop_unknown", stop_obligation: 1 });
    await expect(f.host.decide(f.principal, m.mission_id, { kind: "discard_changes" })).rejects.toThrow("CONTAINED_DECISION_NOT_ALLOWED");
    await expect(f.host.decide(f.principal, m.mission_id, { kind: "retry_stop_check" })).rejects.toThrow("CONTAINED_STOP_UNPROVEN");
    expect(f.store.get(m.mission_id).state).toBe("stop_unknown");
    await f.host.tick();
    expect(f.calls.execute).toBe(0);
    f.setEmpty(() => true);
    expect(await f.host.decide(f.principal, m.mission_id, { kind: "retry_stop_check" })).toMatchObject({ state: "needs_reconciliation", stop_obligation: 0 });
  });

  it("keeps the claim of an abandoned Mission until its stop is proven, then releases it", async () => {
    const f = fixture({}, { empty: () => false });
    const m = await orphanExecuting(f);
    await f.host.recover();
    expect((await f.host.decide(f.principal, m.mission_id, { kind: "abandon" })).state).toBe("abandoned");
    await f.host.recover();
    expect(f.store.claim(m.mission_id).state).toBe("active");
    f.setEmpty(() => true);
    await f.host.recover();
    expect(f.store.get(m.mission_id).stop_obligation).toBe(0);
    expect(f.store.claim(m.mission_id)).toMatchObject({ state: "released", release_reason: "terminal" });
  });

  it("releases the claim of a terminal Mission", async () => {
    const f = fixture({ createWorkspace: async () => { throw new Error("boom"); } });
    const m = await f.start();
    await f.host.tick();
    await f.host.decide(f.principal, m.mission_id, { kind: "abandon" });
    expect(f.store.claim(m.mission_id).state).toBe("active");
    await f.host.recover();
    expect(f.store.claim(m.mission_id)).toMatchObject({ state: "released", release_reason: "terminal" });
  });

  it("moves an orphaned verification to stop_unknown when the container cannot be proven gone", async () => {
    const f = fixture({ verificationStopped: async () => ({ stopped: false }) });
    const m = await f.start();
    await ticks(f, 2);
    let current = f.store.get(m.mission_id);
    current = f.store.transition(m.mission_id, { if_revision: current.revision, to: "verifying", event: { kind: "verify_intent", payload: {} } }, f.now());
    await f.host.recover();
    expect(f.store.get(m.mission_id)).toMatchObject({ state: "stop_unknown", stop_obligation: 1 });
  });

  it("settles an orphaned verification whose container was removed", async () => {
    const f = fixture({ verificationStopped: async () => ({ stopped: true, proof: "container_removed", evidence: "docker-removed:abc" }) });
    const m = await f.start();
    await ticks(f, 2);
    const current = f.store.get(m.mission_id);
    f.store.transition(m.mission_id, { if_revision: current.revision, to: "verifying", event: { kind: "verify_intent", payload: {} } }, f.now());
    await f.host.recover();
    expect(f.store.get(m.mission_id)).toMatchObject({ state: "needs_reconciliation", stop_obligation: 0 });
    expect(f.calls.verify).toBe(0);
  });
});

describe("ContainedMissionHost reconciliation decisions", () => {
  it("discard_changes restores expected_head exactly, then runs a fresh executor turn", async () => {
    const f = fixture();
    const m = await orphanExecuting(f);
    const wt = spec(m).worktree_path;
    writeFileSync(join(wt, "src/a.txt"), "half-written\n"); writeFileSync(join(wt, "src/junk.txt"), "junk\n");
    await f.host.recover();
    const next = await f.host.decide(f.principal, m.mission_id, { kind: "discard_changes" });
    expect(next.state).toBe("candidate_ready");
    expect(f.calls.execute).toBe(1);
    expect(existsSync(join(wt, "src/junk.txt"))).toBe(false);
    expect(readFileSync(join(wt, "src/a.txt"), "utf8")).toBe("hello\n");
    expect(sh(f.repo, "show", `${next.candidate_head}:src/a.txt`)).toBe("hello");
  });

  it("adopt_worktree classifies the worktree from start_commit and still requires verification", async () => {
    const f = fixture();
    const m = await orphanExecuting(f);
    writeFileSync(join(spec(m).worktree_path, "src/a.txt"), "adopted\n");
    await f.host.recover();
    const adopted = await f.host.decide(f.principal, m.mission_id, { kind: "adopt_worktree" });
    expect(adopted).toMatchObject({ state: "candidate_ready", candidate_verified: 0 });
    expect(f.calls.execute).toBe(0);
    expect(sh(f.repo, "show", `${adopted.candidate_head}:src/a.txt`)).toBe("adopted");
    await expect(f.host.decide(f.principal, m.mission_id, { kind: "approve_publication" })).rejects.toThrow("CONTAINED_DECISION_NOT_ALLOWED");
    await f.host.tick();
    expect(f.calls.verify).toBe(1);
    expect(f.store.get(m.mission_id)).toMatchObject({ state: "verified", candidate_verified: 1 });
  });

  it("adopt_worktree escalates a protected-set change without committing", async () => {
    const f = fixture();
    const m = await orphanExecuting(f);
    writeFileSync(join(spec(m).worktree_path, "package.json"), "{\"scripts\":{\"test\":\"curl x\"}}\n");
    await f.host.recover();
    const halted = await f.host.decide(f.principal, m.mission_id, { kind: "adopt_worktree" });
    expect(halted.state).toBe("awaiting_decision");
    expect(f.reason(m.mission_id)).toBe("tier_escalated");
    expect(sh(f.repo, "rev-parse", `refs/heads/${spec(m).branch}`)).toBe(spec(m).start_commit);
  });

  it("adopt_worktree refuses an empty worktree change and leaves the Mission for another decision", async () => {
    const f = fixture();
    const m = await orphanExecuting(f);
    await f.host.recover();
    await expect(f.host.decide(f.principal, m.mission_id, { kind: "adopt_worktree" })).rejects.toThrow("CONTAINED_ADOPT_EMPTY");
    expect(f.store.get(m.mission_id).state).toBe("needs_reconciliation");
  });
});
