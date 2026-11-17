import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hardenedGitEnvironment, type CodexProxyRun, type CodexQualification } from "@osstack/agents";
import { AttentionStore, ContainedMissionStore, createScratchDirSync, openDb, type ContainedMission } from "@osstack/core";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHostProcessLedger, hostProcessOptions } from "./contained-mission-host-process.testkit.js";
import { computeCiChainStats, listCiChains, readCiChain } from "./contained-mission-ci-chain-read.js";
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

function fixture(over: Partial<ContainedMissionHostPorts> = {}, hostOver: { maxConcurrent?: number; empty?: (pgid: number) => boolean; scan?: { pageSize: number; maxPages: number } } = {}) {
  const root = realpathSync(createScratchDirSync("tests", "contained-host"));
  const repo = join(root, "repo"); mkdirSync(repo);
  for (const [path, content] of Object.entries({ "src/a.txt": "hi\n", "src/b.txt": "bye\n", "package.json": "{}\n" })) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content); }
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "initial");
  const path = join(root, "state.db"); const db = openDb({ path }); db.pragma("synchronous=FULL"); ensureHostProcessLedger(db);
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
  const real = createContainedMissionPorts({ store, hostProcess: hostProcessOptions(root), now: () => ++clock, codex: { bin: join(root, "no-codex"), sourceCodexHome: root }, runtimeRoot: join(root, "runtime"),
    verification: { socketPath: join(root, "docker.sock"), daemonId: "d", baseImageId: "sha256:" + "0".repeat(64), journalRoot }, author: { name: "Mission Host", email: "host@example.invalid" } });
  const ports: ContainedMissionHostPorts = { ...real,
    qualify: async () => qualified,
    execute: async input => { calls.execute++; input.onLaunched({ pid: 4242, pgid: 4242, started_at: 1 }); if (gate) await gate; return run(patch); },
    verify: async () => { calls.verify++; return { exit_code: 0, output: "ok", cancelled: false, evidence: "docker-removed:x", stopped: true }; },
    ...over };
  let empty = hostOver.empty ?? (() => true); let named: number[] = [];
  const host = new ContainedMissionHost({ ports, worktreesRoot, processGroupEmpty: pgid => empty(pgid), processesForWorktree: () => named,
    ...(hostOver.maxConcurrent ? { maxConcurrent: hostOver.maxConcurrent } : {}), ...(hostOver.scan ? { scan: hostOver.scan } : {}) });
  const principal = { principal_id: "human", client_session_id: "cli", read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [], operator_scopes: [] };
  const start = async () => host.start(principal, { scope_id: scope.scope_id, spec: await resolveContainedMissionStart({ goal: "say hello", repo_path: repo, base_ref: "main", allowed_paths: ["src/**"], verify: { argv: ["true"] } }, { worktreesRoot }) });
  const reason = (id: string) => { const e = store.events(id, 0, 500).filter(x => x.kind === "halted").at(-1); return e ? (JSON.parse(e.payload_json) as { reason: string }).reason : undefined; };
  return { root, repo, store, host, principal, start, calls, reason, now: () => ++clock,
    setPatch: (p: string) => { patch = p; }, setGate: (g: Promise<void> | undefined) => { gate = g; }, setEmpty: (fn: (pgid: number) => boolean) => { empty = fn; }, setNamed: (pids: number[]) => { named = pids; } };
}
type Fixture = ReturnType<typeof fixture>;
function ciRoot(f: Fixture, suffix: string) {
  return f.store.authorize(f.principal, { scope_id: f.principal.read_scopes[0]!,
    spec: { verification_mode: "github_actions", publication: { repository: "o/r" }, repo_path: f.repo },
    claim: { repo_identity: `ci-${suffix}`, branch: `ci-${suffix}`, worktree_identity: `ci-${suffix}` } }, f.now());
}
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
  it("marks a Mission busy before the synchronous part of its first port call", async () => {
    let busy = false;
    let id = "";
    const f = fixture({ createWorkspace: async () => { busy = f.host.isBusy(id); throw Error("workspace_failed"); } });
    id = (await f.start()).mission_id;
    await f.host.tick();
    expect(busy).toBe(true);
    expect(f.host.isBusy(id)).toBe(false);
  });
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
    mkdirSync(join(f.root, "worktrees"), { recursive: true }); mkdirSync(join(f.root, "outside"));
    symlinkSync(join(f.root, "outside"), join(f.root, "worktrees", "evil"));
    expect(() => f.host.start(f.principal, { scope_id: scope, spec: { ...good, worktree_path: join(f.root, "worktrees", "evil", "mission-x") } })).toThrow("CONTAINED_SPEC_INVALID");
    symlinkSync(join(f.root, "missing"), join(f.root, "worktrees", "dangling"));
    expect(() => f.host.start(f.principal, { scope_id: scope, spec: { ...good, worktree_path: join(f.root, "worktrees", "dangling", "mission-x") } })).toThrow("CONTAINED_SPEC_INVALID");
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

  it("resumes its scan where the previous tick stopped, so halted Missions cannot starve later ones", async () => {
    const f = fixture({}, { scan: { pageSize: 1, maxPages: 1 } });
    const halted = await f.start();
    const cur = f.store.get(halted.mission_id);
    f.store.transition(halted.mission_id, { if_revision: cur.revision, to: "awaiting_decision", event: { kind: "halted", payload: { reason: "test" } } }, f.now());
    const later = await f.start();
    await f.host.tick();
    expect(f.store.get(later.mission_id).state).toBe("authorized");
    await f.host.tick();
    expect(f.store.get(later.mission_id).state).toBe("workspace_ready");
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

  it("completes a cancel that was pending when the stop was unproven, once proof arrives", async () => {
    const f = fixture({}, { empty: () => false });
    const m = await orphanExecuting(f);
    expect((await f.host.cancel(f.principal, m.mission_id)).state).toBe("cancel_requested");
    await f.host.recover();
    expect(f.store.get(m.mission_id).state).toBe("stop_unknown");
    f.setEmpty(() => true);
    await f.host.recover();
    expect(f.store.get(m.mission_id)).toMatchObject({ state: "cancelled", stop_obligation: 0 });
    await f.host.recover();
    expect(f.store.claim(m.mission_id).state).toBe("released");
  });

  it("holds stop_unknown when no launch was journaled but a process still names the worktree", async () => {
    const f = fixture();
    const m = await orphanExecuting(f, false);
    f.setNamed([31337]);
    await f.host.recover();
    expect(f.store.get(m.mission_id)).toMatchObject({ state: "stop_unknown", stop_obligation: 1 });
    f.setNamed([]);
    expect(await f.host.decide(f.principal, m.mission_id, { kind: "retry_stop_check" })).toMatchObject({ state: "needs_reconciliation", stop_obligation: 0 });
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

  it("marks a keyed retry before removing a verification container", async () => {
    const f = fixture({ verificationStopped: async (mission, beforeStop) => {
      beforeStop?.();
      const marker = f.store.events(mission.mission_id, 0, 500).find(e => e.kind === "decision_effect_started");
      expect(marker && JSON.parse(marker.payload_json)).toMatchObject({ decision_id: "stop-key", effect: "verification_stop" });
      return { stopped: true, proof: "container_removed", evidence: "docker-removed:abc" };
    } });
    const m = await f.start(); await ticks(f, 2);
    let current = f.store.get(m.mission_id);
    current = f.store.transition(m.mission_id, { if_revision: current.revision, to: "verifying", event: { kind: "verify_intent", payload: {} } }, f.now());
    f.store.transition(m.mission_id, { if_revision: current.revision, to: "stop_unknown", event: { kind: "halted", payload: { reason: "test" } } }, f.now());
    await f.host.decide(f.principal, m.mission_id, { kind: "retry_stop_check", decision_id: "stop-key" });
    expect(f.store.get(m.mission_id).stop_obligation).toBe(0);
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

  it("discard_changes probes the executor again and does not launch an unqualified one", async () => {
    const f = fixture({ qualify: async () => ({ ...qualified, qualified: false, reasons: ["PARENT_NETWORK_ALLOWED"] }) });
    const m = await orphanExecuting(f);
    await f.host.recover();
    const halted = await f.host.decide(f.principal, m.mission_id, { kind: "discard_changes" });
    expect(halted.state).toBe("awaiting_decision");
    expect(f.reason(m.mission_id)).toBe("qualification_failed");
    expect(f.calls.execute).toBe(0);
  });

  it("discard_changes removes symlinks and directories in the way without following them", async () => {
    const f = fixture();
    const m = await orphanExecuting(f);
    const wt = spec(m).worktree_path;
    const outside = join(f.root, "outside.txt"); writeFileSync(outside, "keep\n");
    rmSync(join(wt, "src/b.txt")); symlinkSync(outside, join(wt, "src/b.txt"));
    rmSync(join(wt, "src/a.txt")); mkdirSync(join(wt, "src/a.txt")); writeFileSync(join(wt, "src/a.txt/inner"), "x\n");
    symlinkSync(join(f.root, "elsewhere"), join(wt, "src/link"));
    await f.host.recover();
    const next = await f.host.decide(f.principal, m.mission_id, { kind: "discard_changes" });
    expect(next.state).toBe("candidate_ready");
    expect(readFileSync(outside, "utf8")).toBe("keep\n");
    expect(lstatSync(join(wt, "src/b.txt")).isFile()).toBe(true); expect(readFileSync(join(wt, "src/b.txt"), "utf8")).toBe("bye\n");
    expect(readFileSync(join(wt, "src/a.txt"), "utf8")).toBe("hello\n");
    expect(() => lstatSync(join(wt, "src/link"))).toThrow();
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

  it("adopt_worktree builds on the ledger head and drops an unrecorded commit's history", async () => {
    const f = fixture();
    const m = await orphanExecuting(f);
    const wt = spec(m).worktree_path;
    writeFileSync(join(wt, "package.json"), "{\"scripts\":{\"x\":\"y\"}}\n");
    sh(wt, "add", "package.json"); sh(wt, "commit", "-q", "-m", "unrecorded");
    writeFileSync(join(wt, "package.json"), "{}\n"); writeFileSync(join(wt, "src/a.txt"), "adopted\n");
    await f.host.recover();
    const adopted = await f.host.decide(f.principal, m.mission_id, { kind: "adopt_worktree" });
    expect(adopted.state).toBe("candidate_ready");
    expect(sh(f.repo, "rev-parse", `${adopted.candidate_head}^`)).toBe(spec(m).start_commit);
    expect(sh(f.repo, "rev-parse", `refs/heads/${spec(m).branch}`)).toBe(adopted.candidate_head);
    expect(sh(f.repo, "diff", "--name-only", spec(m).start_commit, adopted.candidate_head!)).toBe("src/a.txt");
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

describe("ContainedMissionHost status publication", () => {
  const pr = { number: 7, url: "https://github.com/o/r/pull/7", reused: false };
  const evidence = (digest: string, head: string) => ({ schema_version: 1, head, base_head: "e".repeat(40), pr, evidence_digest: digest });

  it("is null before anything was published", async () => {
    const f = fixture(); const m = await f.start();
    expect(f.host.status(f.principal, m.mission_id).publication).toBeNull();
  });

  it("joins pr_opened with its delivery_evidence, past the event tail", async () => {
    const f = fixture(); const m = await f.start();
    f.store.record(m.mission_id, "delivery_evidence", evidence("1".repeat(64), "a".repeat(40)), f.now());
    f.store.record(m.mission_id, "delivery_evidence", evidence("2".repeat(64), "b".repeat(40)), f.now());
    f.store.record(m.mission_id, "pr_opened", { pr, evidence_digest: "2".repeat(64) }, f.now());
    for (let i = 0; i < 60; i++) f.store.record(m.mission_id, "noise", { i }, f.now());
    expect(f.host.status(f.principal, m.mission_id).publication).toEqual({ kind: "opened", pr, evidence_digest: "2".repeat(64), pushed_commit: "b".repeat(40), base_head: "e".repeat(40) });
  });

  it("reports the one-shot merge state from durable CI evidence", async () => {
    const f = fixture(); const m = await f.start();
    const id = m.mission_id;
    const head = "b".repeat(40);
    const digest = "2".repeat(64);
    f.store.record(id, "ci_delivery_evidence", evidence(digest, head), f.now());
    f.store.record(id, "pr_opened", { pr, evidence_digest: digest, verification_kind: "github_actions" }, f.now());
    const state = () => f.host.status(f.principal, id).github_ci_chain;
    expect(state()).toMatchObject({ state: "initial_ci_waiting", pr: 7, since: expect.any(Number) });
    f.store.record(id, "ci_initial_verified", { head }, f.now());
    expect(state()).toMatchObject({ state: "approval_and_handoff_waiting", pr: 7, reason: "CI is green; waiting for Watcher approval and Merger handoff. Approval has no separate ledger event.", since: expect.any(Number) });
    const handoff = { binding: { pr: 7, head } };
    f.store.record(id, "ci_app_e_merge_reserved", handoff, f.now());
    expect(state()).toMatchObject({ state: "merge_reserved", pr: 7, head, since: expect.any(Number) });
    f.store.record(id, "ci_app_e_merge_released", handoff, f.now());
    expect(state()).toMatchObject({ state: "merge_reconciling", pr: 7, head, since: expect.any(Number) });
    f.store.record(id, "ci_pr_merge_unverified", { pr: 7, head, reason: "job_binding_unavailable" }, f.now());
    expect(state()).toMatchObject({ state: "merge_held", pr: 7, head, reason: "job_binding_unavailable", since: expect.any(Number) });
    const merged = { pr: 7, head, merge_commit_sha: "f".repeat(40), handoff_comment_id: 82, app_id: 5620091 };
    f.store.record(id, "ci_pr_merged_observed", merged, f.now());
    expect(state()).toMatchObject({ state: "closed", ...merged, since: expect.any(Number) });
  });

  it("reads every CI waiting state and unknown result from SQLite after restart", async () => {
    const f = fixture(); const root = ciRoot(f, "one"); const id = root.mission_id;
    const head = "b".repeat(40); const fixed = "c".repeat(40); const digest = "2".repeat(64);
    f.store.record(id, "ci_delivery_evidence", evidence(digest, head), 2100);
    f.store.record(id, "pr_opened", { pr, evidence_digest: digest, verification_kind: "github_actions" }, 2101);
    const state = () => readCiChain(f.store.db, f.store.get(id));
    expect(state()).toMatchObject({ state: "initial_ci_waiting", since: 2101, head_before: head });
    f.store.record(id, "ci_initial_verification_waiting", { reason: "jobs_pending" }, 2102);
    expect(state()).toMatchObject({ state: "initial_ci_waiting", since: 2101 });
    f.store.record(id, "ci_failure_observed", { job: { check_run_id: 9 } }, 2103);
    expect(state()).toMatchObject({ state: "repair_permission_waiting", since: 2103 });
    const child = f.store.authorize(f.principal, { scope_id: root.scope_id, spec: { repo_path: f.repo },
      claim: { repo_identity: "child", branch: "child", worktree_identity: "child" } }, 2104);
    f.store.record(id, "ci_repair_dispatched", { child: child.mission_id }, 2105);
    expect(state()).toMatchObject({ state: "repair_permission_waiting", since: 2103 });
    f.store.record(child.mission_id, "ci_repair_approval", {}, 2106);
    expect(state()).toMatchObject({ state: "repair_in_progress", since: 2106 });
    f.store.record(child.mission_id, "ci_repair_push_confirmed", {}, 2107);
    expect(state()).toMatchObject({ state: "repair_ci_waiting", since: 2107 });
    f.store.record(id, "ci_repair_verification_waiting", { reason: "jobs_pending" }, 2108);
    expect(state()).toMatchObject({ state: "repair_ci_waiting", since: 2107, reason: "jobs_pending" });
    f.store.record(id, "ci_repair_failed", { job: { check_run_id: 10 } }, 2109);
    expect(state()).toMatchObject({ state: "stopped", since: 2109, stop_reason: "repair_ci_failed" });
    f.store.record(id, "ci_repair_verified", { head: fixed }, 2110);
    expect(state()).toMatchObject({ state: "approval_and_handoff_waiting", since: 2110, reason: "CI is green; waiting for Watcher approval and Merger handoff. Approval has no separate ledger event." });
    const reopened = openDb({ path: join(f.root, "state.db") });
    try {
      expect(readCiChain(reopened, f.store.get(id))).toMatchObject({ state: "approval_and_handoff_waiting", since: 2110, reason: "CI is green; waiting for Watcher approval and Merger handoff. Approval has no separate ledger event." });
      expect(listCiChains(reopened, [root.scope_id], root.scope_id)).toHaveLength(1);
      expect(computeCiChainStats(reopened).ci_chain_by_state).toContainEqual({ state: "approval_and_handoff_waiting", count: 1 });
    } finally { reopened.close(); }
    f.store.record(id, "ci_closed_unmerged", {}, 2111);
    expect(state()).toMatchObject({ state: "stopped", since: 2111 });
  });

  it.each([
    { reason: "publication_pending", event: null, state: "repair_permission_waiting", stopReason: null },
    { reason: "github_ci_scope_unavailable", event: null, state: "stopped", stopReason: "github_ci_scope_unavailable" },
    { reason: "github_ci_admission_failed:scope", event: null, state: "stopped", stopReason: "github_ci_admission_failed:scope" },
    { reason: "repair_cycles_exhausted", event: null, state: "stopped", stopReason: "repair_cycles_exhausted" },
    { reason: "publication_pending", event: "ci_repair_approval", state: "stopped", stopReason: "publication_pending" },
    { reason: "publication_pending", event: "ci_repair_push_intent", state: "stopped", stopReason: "publication_pending" },
  ])("projects a repair halt with $reason and $event as $state", ({ reason, event, state, stopReason }) => {
    const f = fixture(); const root = ciRoot(f, "one"); const id = root.mission_id;
    const head = "b".repeat(40); const digest = "2".repeat(64);
    f.store.record(id, "ci_delivery_evidence", evidence(digest, head), 3100);
    f.store.record(id, "pr_opened", { pr, evidence_digest: digest, verification_kind: "github_actions" }, 3101);
    const child = f.store.authorize(f.principal, { scope_id: root.scope_id, spec: { repo_path: f.repo },
      claim: { repo_identity: "repair-child", branch: "repair-child", worktree_identity: "repair-child" } }, 3102);
    f.store.record(id, "ci_repair_dispatched", { child: child.mission_id }, 3103);
    // Approval and intent can predate the halt. Neither permits the new waiting exception.
    if (event) f.store.record(child.mission_id, event, {}, 3104);
    f.store.transition(child.mission_id, { if_revision: child.revision, to: "awaiting_decision",
      event: { kind: "halted", payload: { reason } } }, 3105);
    const expected = { state, since: 3105, stop_reason: stopReason, reason };
    expect(readCiChain(f.store.db, f.store.get(id))).toMatchObject(expected);
    expect(f.host.status(f.principal, id).github_ci_chain).toMatchObject(expected);
    expect(listCiChains(f.store.db, [root.scope_id])).toEqual([expect.objectContaining(expected)]);
    if (state === "repair_permission_waiting") {
      // Later unrelated events must not hide the persisted halt reason.
      f.store.record(child.mission_id, "noise", { reason: "unrelated" }, 3106);
      expect(readCiChain(f.store.db, f.store.get(id))).toMatchObject({ ...expected, since: 3106 });
    }
  });

  it("reports an unavailable repair child and a revoked child grant without guessing", async () => {
    const f = fixture(); const root = ciRoot(f, "one"); const id = root.mission_id;
    const head = "b".repeat(40); const digest = "2".repeat(64);
    f.store.record(id, "ci_delivery_evidence", evidence(digest, head), 3100);
    f.store.record(id, "pr_opened", { pr, evidence_digest: digest, verification_kind: "github_actions" }, 3101);
    f.store.record(id, "ci_repair_dispatched", { child: "cm_missing" }, 3102);
    expect(readCiChain(f.store.db, f.store.get(id))).toMatchObject({ state: "result_unknown", since: 3102, stop_reason: "repair_child_missing" });
    const child = f.store.authorize(f.principal, { scope_id: root.scope_id, spec: { repo_path: f.repo },
      claim: { repo_identity: "revoked-child", branch: "revoked-child", worktree_identity: "revoked-child" } }, 3103);
    f.store.record(id, "ci_repair_dispatched", { child: child.mission_id }, 3104);
    f.store.transition(child.mission_id, { if_revision: child.revision, to: "awaiting_decision", event: { kind: "halted", payload: { reason: "grant_revoked" } } }, 3105);
    expect(readCiChain(f.store.db, f.store.get(id))).toMatchObject({ state: "stopped", since: 3105, reason: "grant_revoked" });
  });

  it("counts five consecutive closed chains and observed durations", async () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) {
      const root = ciRoot(f, String(i));
      const head = String(i + 1).repeat(40); const digest = String(i + 1).repeat(64);
      f.store.record(root.mission_id, "ci_pilot_root_bound", {}, 3999 + i * 10);
      f.store.record(root.mission_id, "ci_delivery_evidence", evidence(digest, head), 4000 + i * 10);
      f.store.record(root.mission_id, "pr_opened", { pr: { ...pr, number: i + 1 }, evidence_digest: digest, verification_kind: "github_actions" }, 4001 + i * 10);
      if (i === 2) { f.store.record(root.mission_id, "ci_failure_observed", {}, 4002 + i * 10); f.store.record(root.mission_id, "ci_repair_verified", {}, 4003 + i * 10); }
      f.store.record(root.mission_id, "ci_pr_merged_observed", { pr: i + 1, head, merge_commit_sha: "f".repeat(40), app_id: 123, handoff_comment_id: 82 }, 4005 + i * 10);
    }
    const stats = computeCiChainStats(f.store.db);
    expect(stats).toMatchObject({ ci_chain_closed: 5, ci_chain_repaired_closed: 1, ci_chain_consecutive_normal_closed: 5,
      ci_chain_by_state: [{ state: "closed", count: 5 }] });
    expect(stats.ci_chain_registration_to_close_ms).toHaveLength(5);
    expect(stats.ci_chain_registration_to_close_ms.every(row => row.duration_ms === 6)).toBe(true);
    const stopped = ciRoot(f, "newest-stopped"); const digest = "a".repeat(64); const head = "a".repeat(40);
    f.store.record(stopped.mission_id, "ci_delivery_evidence", evidence(digest, head), 4100);
    f.store.record(stopped.mission_id, "pr_opened", { pr, evidence_digest: digest, verification_kind: "github_actions" }, 4101);
    f.store.record(stopped.mission_id, "ci_closed_unmerged", {}, 4102);
    expect(computeCiChainStats(f.store.db).ci_chain_consecutive_normal_closed).toBe(0);
  });

  it("breaks the normal closure streak for a manual merge without App E evidence", () => {
    const f = fixture(); const root = ciRoot(f, "manual"); const head = "b".repeat(40); const digest = "2".repeat(64);
    f.store.record(root.mission_id, "ci_delivery_evidence", evidence(digest, head), 5000);
    f.store.record(root.mission_id, "pr_opened", { pr, evidence_digest: digest, verification_kind: "github_actions" }, 5001);
    f.store.record(root.mission_id, "ci_pr_merged_observed", { pr: 7, head, merge_commit_sha: "f".repeat(40), merged_by: { id: 9, type: "User" } }, 5002);
    expect(computeCiChainStats(f.store.db)).toMatchObject({ ci_chain_closed: 1, ci_chain_consecutive_normal_closed: 0 });
  });

  it("keeps duration null when registration time is absent", () => {
    const f = fixture(); const root = ciRoot(f, "without-bound"); const head = "b".repeat(40); const digest = "2".repeat(64);
    f.store.record(root.mission_id, "ci_delivery_evidence", evidence(digest, head), 5000);
    f.store.record(root.mission_id, "pr_opened", { pr, evidence_digest: digest, verification_kind: "github_actions" }, 5001);
    f.store.record(root.mission_id, "ci_pr_merged_observed", { pr: 7, head, merge_commit_sha: "f".repeat(40) }, 5002);
    expect(computeCiChainStats(f.store.db).ci_chain_registration_to_close_ms).toEqual([{ mission_id: root.mission_id, duration_ms: null }]);
  });

  it("reports missing evidence instead of throwing", async () => {
    const f = fixture(); const m = await f.start();
    f.store.record(m.mission_id, "pr_opened", { pr, evidence_digest: "3".repeat(64) }, f.now());
    expect(f.host.status(f.principal, m.mission_id).publication).toEqual({ kind: "evidence_missing", pr, evidence_digest: "3".repeat(64) });
  });

  it("reports a PR opened before a cancel with the evidence recorded before it", async () => {
    const f = fixture(); const m = await f.start();
    f.store.record(m.mission_id, "delivery_evidence", evidence("4".repeat(64), "c".repeat(40)), f.now());
    f.store.record(m.mission_id, "pr_opened_before_cancel", { pr }, f.now());
    expect(f.host.status(f.principal, m.mission_id).publication).toEqual({ kind: "opened_before_cancel", pr, pushed_commit: "c".repeat(40), base_head: "e".repeat(40) });
  });

  it("finds the matching evidence across pages and stays valid with an unterminated key header", async () => {
    const f = fixture(); const m = await f.start();
    f.store.record(m.mission_id, "delivery_evidence", { ...evidence("5".repeat(64), "d".repeat(40)), verify: { argv: ["-----BEGIN PRIVATE KEY-----"] } }, f.now());
    for (let i = 0; i < 45; i++) f.store.record(m.mission_id, "delivery_evidence", evidence(i.toString(16).padStart(64, "f"), "a".repeat(40)), f.now());
    f.store.record(m.mission_id, "pr_opened", { pr, evidence_digest: "5".repeat(64) }, f.now());
    expect(f.host.status(f.principal, m.mission_id).publication).toEqual({ kind: "opened", pr, evidence_digest: "5".repeat(64), pushed_commit: "d".repeat(40), base_head: "e".repeat(40) });
  });

  it("redacts secrets and still requires read scope", async () => {
    const f = fixture(); const m = await f.start();
    const token = "ghp" + "_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    f.store.record(m.mission_id, "pr_opened_before_cancel", { pr: { ...pr, url: `https://x-access-token:${token}@github.com/o/r/pull/7` } }, f.now());
    expect(JSON.stringify(f.host.status(f.principal, m.mission_id).publication)).not.toContain(token);
    expect(() => f.host.status({ ...f.principal, read_scopes: [] }, m.mission_id)).toThrow("permission_denied");
  });
});

describe("ContainedMissionHost publishCheck", () => {
  const publication = { remote: "origin", repository: "o/r", base: "main", draft: true, preauthorized: true };
  const publish: ContainedMissionHostPorts["publish"] = async input => {
    input.beforeRemoteMutation("push"); input.beforeRemoteMutation("pr_create");
    return { pushed_commit: input.permit.head, pr: { number: 7, url: "https://github.com/o/r/pull/7", reused: false }, base_head: "e".repeat(40) };
  };
  async function opened(over: Partial<ContainedMissionHostPorts> = {}) {
    const f = fixture({ publish, ...over });
    const scopeId = f.principal.write_scopes[0]!;
    const worktreesRoot = join(f.root, "worktrees");
    const base = await resolveContainedMissionStart({ goal: "say hello", repo_path: f.repo, base_ref: "main", allowed_paths: ["src/**"], verify: { argv: ["true"] }, publication }, { worktreesRoot });
    const m = f.host.start(f.principal, { scope_id: scopeId, spec: base });
    for (let i = 0; i < 12 && f.store.get(m.mission_id).state !== "pr_opened"; i++) await f.host.tick();
    return { f, id: m.mission_id };
  }

  it("republishes idempotently for a pr_opened Mission with write scope", async () => {
    let calls = 0;
    const { f, id } = await opened({ publishVerifyCheck: async () => { calls++; return { check_run_id: 9, created: calls === 1 }; } });
    expect(f.store.get(id).state).toBe("pr_opened");
    expect(await f.host.publishCheck(f.principal, id)).toEqual({ check_run_id: 9, created: false });
    expect(await f.host.publishCheck(f.principal, id)).toEqual({ check_run_id: 9, created: false });
    expect(f.store.get(id).state).toBe("pr_opened");
    expect(f.store.events(id, 0, 500).filter(e => e.kind === "verify_check_published").length).toBe(3);
  });

  it("is refused without write scope, even with read and stop scopes", async () => {
    const { f, id } = await opened({ publishVerifyCheck: async () => ({ check_run_id: 9, created: true }) });
    const readOnly = { ...f.principal, write_scopes: [], stop_scopes: f.principal.read_scopes };
    await expect(f.host.publishCheck(readOnly, id)).rejects.toThrow("permission_denied");
    const other = { ...f.principal, read_scopes: [], write_scopes: [] };
    await expect(f.host.publishCheck(other, id)).rejects.toThrow();
  });

  it("is refused when the Mission is not pr_opened", async () => {
    const f = fixture({ publishVerifyCheck: async () => ({ check_run_id: 9, created: true }) });
    const m = await f.start();
    await expect(f.host.publishCheck(f.principal, m.mission_id)).rejects.toThrow("mission_not_pr_opened");
  });

  it("is refused when the bridge is not configured", async () => {
    const { f, id } = await opened();
    expect(f.store.get(id).state).toBe("pr_opened");
    await expect(f.host.publishCheck(f.principal, id)).rejects.toThrow("bridge_not_configured");
  });

  it("surfaces the check error and records verify_check_failed", async () => {
    let fail = false;
    const { f, id } = await opened({ publishVerifyCheck: async () => { if (fail) throw new Error("CONTAINED_VERIFY_CHECK_HTTP:502"); return { check_run_id: 9, created: true }; } });
    fail = true;
    await expect(f.host.publishCheck(f.principal, id)).rejects.toThrow("CONTAINED_VERIFY_CHECK_HTTP:502");
    expect(f.store.events(id, 0, 500).some(e => e.kind === "verify_check_failed")).toBe(true);
    expect(f.store.get(id).state).toBe("pr_opened");
  });
});
