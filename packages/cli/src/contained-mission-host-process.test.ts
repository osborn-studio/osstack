// W13-C1: covered local writes are gated and journaled; recovery proves host child processes stopped, by observation only,
// before any claim is released, obligation cleared or Mission moved on. Synthetic rows use a probe double; the macOS
// block runs real processes (a blocking git wrapper, a SIGKILLed child holding the real ledger).
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { HostProcessUnprovenError, hardenedGitEnvironment, type CodexProxyRun, type CodexQualification, type HostProcessProbe } from "@osstack/agents";
import { AttentionStore, ContainedMissionStore, createScratchDirSync, openDb, type ContainedMission, type HostProcessRecord } from "@osstack/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContainedMissionHost, resolveContainedMissionStart } from "./contained-mission-host.js";
import { ensureHostProcessLedger, hostProcessOptions } from "./contained-mission-host-process.testkit.js";
import { createContainedMissionPorts, type ContainedMissionHostPorts } from "./contained-mission-ports.js";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => { fn(); }); });
const env = { ...hardenedGitEnvironment(process.env), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const PATCH = "--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-hi\n+hello\n";
const qualified: CodexQualification = { qualified: true, version: "codex-cli 0.160.1", identity_sha256: "f".repeat(64), profile: ":read-only",
  results: { parent: { write_worktree: "denied", write_outside: "denied", write_gitdir: "denied", network: "denied" }, escaped_child: { write_worktree: "denied", write_outside: "denied", write_gitdir: "denied", network: "denied" } },
  host_observed_writes: [], reasons: [] };
const run = (): CodexProxyRun => ({ launch: { pid: 4242, pgid: 4242, started_at: 1 }, exit_code: 0, signal: null, timed_out: false, cancelled: false,
  stop: { stop_proof: "group_empty+sandbox_inherited", pgid: 4242, signals: [], confirmed_at: 2 }, patch: { ok: true, text: PATCH, bytes: PATCH.length },
  stdout: "", stderr: "", stdout_truncated: false, stderr_truncated: false });
const PR = { number: 7, url: "https://github.com/o/r/pull/7", reused: false };
const REAL_GIT = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();

/** Probe whose answers the test sets. It has no way to signal anything. */
function fakeProbe() {
  const answers = { group: true, leader: null as { pgid: number | null; start: string | null } | null, held: false, marker: "ok" as "ok" | "lost", boot: null as string | null };
  const probe: HostProcessProbe = {
    bootSession: () => answers.boot,
    groupPresent: () => answers.group,
    leader: () => answers.leader,
    markerIdentity: () => answers.marker,
    markerHeld: () => answers.held,
  };
  return { answers, probe };
}

function world(options: { probe?: HostProcessProbe; gitBinary?: string; host?: { recheck?: number } } = {}) {
  const root = realpathSync(createScratchDirSync("tests", "contained-hostproc"));
  const repo = join(root, "repo"); mkdirSync(repo);
  for (const [path, content] of Object.entries({ "src/a.txt": "hi\n", "package.json": "{}\n" })) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content); }
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "initial");
  const path = join(root, "state.db"); const db = openDb({ path }); db.pragma("synchronous=FULL"); ensureHostProcessLedger(db);
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const attention = new AttentionStore(db, path);
  const worktreesRoot = join(root, "worktrees"); const journalRoot = join(root, "journal"); mkdirSync(journalRoot);
  let clock = 1000; let rowSeq = 0;
  const gates: { publish?: { wait: () => Promise<void>; release: () => void; reached: Promise<void> }; published: number; hook?: (id: string, d: Daemon) => void; after?: () => void } = { published: 0 };
  let scope: { scope_id: string } | undefined;

  function daemon(name: string, over: { probe?: HostProcessProbe } = {}) {
    const owner = attention.claimOwner(name);
    scope ??= attention.registerScope(owner, "t", root);
    const store = new ContainedMissionStore(attention, owner);
    const probe = over.probe ?? options.probe;
    const real = createContainedMissionPorts({ store, now: () => ++clock, codex: { bin: join(root, "no-codex"), sourceCodexHome: root }, runtimeRoot: join(root, "runtime"),
      verification: { socketPath: join(root, "docker.sock"), daemonId: "d", baseImageId: `sha256:${"0".repeat(64)}`, journalRoot }, author: { name: "Mission Host", email: "host@example.invalid" },
      hostProcess: hostProcessOptions(root, probe ? { probe } : {}), ...(options.gitBinary ? { git: { gitBinary: options.gitBinary } } : {}) });
    const ports: ContainedMissionHostPorts = { ...real, qualify: async () => qualified,
      execute: async input => { input.onLaunched({ pid: 4242, pgid: 4242, started_at: 1 }); return run(); },
      verify: async () => ({ exit_code: 0, output: "ok", cancelled: false, evidence: "docker-removed:x", stopped: true }),
      verificationStopped: async () => ({ stopped: true, proof: "container_removed", evidence: "docker-gone:x" }),
      publish: async input => {
        gates.published++;
        await gates.publish?.wait();
        gates.hook?.(input.mission.mission_id, self);
        input.beforeRemoteMutation("push"); input.beforeRemoteMutation("pr_create");
        gates.after?.();
        return { pushed_commit: input.permit.head, pr: PR, base_head: "a".repeat(40) };
      } };
    const host = new ContainedMissionHost({ ports, worktreesRoot, processGroupEmpty: () => true, processesForWorktree: () => [], hostProcessWaitMs: 400,
      ...(options.host?.recheck !== undefined ? { hostProcessRecheckMs: options.host.recheck } : {}) });
    cleanup.push(() => { void host.close(); });
    const self = { name, store, host, hp: real.hostProcesses.hp, ports };
    return self;
  }
  type Daemon = ReturnType<typeof daemon>;
  const principal = () => ({ principal_id: "human", client_session_id: "cli", read_scopes: [scope!.scope_id], write_scopes: [scope!.scope_id], stop_scopes: [], operator_scopes: [] });
  async function start(d: Daemon, publication = false): Promise<ContainedMission> {
    const spec = await resolveContainedMissionStart({ goal: "say hello", repo_path: repo, base_ref: "main", allowed_paths: ["src/**"], verify: { argv: ["true"] },
      ...(publication ? { publication: { remote: "origin", repository: "o/r", base: "main", draft: true, preauthorized: true } } : {}) }, { worktreesRoot });
    return d.host.start(principal(), { scope_id: scope!.scope_id, spec });
  }
  const events = (d: Daemon, id: string) => d.store.events(id, 0, 500);
  const kinds = (d: Daemon, id: string) => events(d, id).map(e => e.kind);
  const halted = (d: Daemon, id: string) => {
    const e = events(d, id).filter(x => x.kind === "halted").at(-1);
    return e ? JSON.parse(e.payload_json) as { reason: string; route?: string; prior_obligation?: number } : undefined;
  };
  async function until(d: Daemon, id: string, state: ContainedMission["state"], max = 10) {
    for (let i = 0; i < max && d.store.get(id).state !== state; i++) await d.host.tick();
    expect(d.store.get(id).state).toBe(state);
  }
  /** A ledger row a crashed daemon left behind (no process behind it: the probe double decides what recovery observes). */
  function orphan(d: Daemon, missionId: string, state: "launching" | "registered" | "released", kind: HostProcessRecord["kind"] = "git_update_ref", over: { remote_target?: string } = {}): string {
    const opId = `hp_${String(++rowSeq).padStart(32, "0")}`;
    d.hp.launching({ op_id: opId, mission_id: missionId, kind, local_target: "repo#refs/heads/x", argv_digest: "d".repeat(64), boot_id: "boot-1",
      marker: { path: join(root, `marker-${rowSeq}`), dev: "1", ino: "2" }, ...(over.remote_target ? { remote_target: over.remote_target } : {}) });
    if (state !== "launching") d.hp.registered(opId, { pid: 4242, pgid: 4242, leader_start: "Fri Nov  6 10:00:00 2026" });
    if (state === "released") d.hp.release(opId, () => undefined);
    return opId;
  }
  const rows = (id: string) => db.prepare("SELECT op_id,kind,state,released_at,stop_proof FROM engineering_host_processes WHERE mission_id=? ORDER BY created_at,op_id").all(id) as
    Array<{ op_id: string; kind: string; state: string; released_at: number | null; stop_proof: string | null }>;
  return { root, repo, db, path, attention, gates, daemon, start, events, kinds, halted, until, orphan, rows, principal, worktreesRoot,
    branchHead: (m: ContainedMission) => sh(repo, "rev-parse", (JSON.parse(m.spec_json) as { branch: string }).branch) };
}

function gate() {
  let release!: () => void; let reached!: () => void;
  const open = new Promise<void>(r => { release = r; }); const arrived = new Promise<void>(r => { reached = r; });
  return { wait: async () => { reached(); await open; }, release, reached: arrived };
}

describe("gated local writes in a Mission", () => {
  it("every ref update and index write of a normal run is a journaled, released and stopped launch", async () => {
    const w = world(); const a = w.daemon("a");
    const m = await w.start(a);
    await w.until(a, m.mission_id, "awaiting_decision");
    const rows = w.rows(m.mission_id);
    // worktree add + two index commands to create, one ref update to commit, two index commands in the restore-free path: none.
    expect(rows.map(r => r.kind)).toEqual(["git_worktree_add", "git_index_write", "git_index_write", "git_update_ref"]);
    expect(rows.every(r => r.state === "stopped" && r.released_at !== null && r.stop_proof === "group_empty+marker_unheld")).toBe(true);
    expect(w.kinds(a, m.mission_id)).toContain("host_process_stopped");
    expect(a.hp.open()).toEqual([]);
  });

  it("only gated paths write refs or the real index (static scan)", () => {
    const ports = readFileSync(new URL("./contained-mission-ports.ts", import.meta.url), "utf8");
    for (const match of ports.matchAll(/'update-ref'/g)) expect(ports.slice(match.index, match.index + 400), `update-ref at ${match.index}`).toContain("kit.hardened(");
    const plumbing = readFileSync(new URL("../../agents/src/contained-workspace/plumbing.ts", import.meta.url), "utf8");
    for (const needle of ['"update-ref"', '"worktree", "add"', '["read-tree", commit]', "refreshIndex(run, undefined, indexWrite)"]) {
      const at = plumbing.indexOf(needle);
      expect(at, needle).toBeGreaterThan(-1);
      expect(plumbing.slice(at, at + 260), needle).toMatch(/gatedGit\(|indexWrite/);
    }
    const hardenedSource = readFileSync(new URL("../../agents/src/contained-workspace/hardened-git.ts", import.meta.url), "utf8");
    expect(hardenedSource).toContain("argvDigest(program, argv)");
  });
});

describe("remote writes at the Mission level (W13-C2)", () => {
  /** Drives a publishing Mission to `revalidating` with real gated local writes, then makes every later proof unknown. */
  async function toRevalidating() {
    const fp = fakeProbe(); fp.answers.group = false; fp.answers.leader = { pgid: 4242, start: "Fri Nov  6 10:00:00 2026" };
    const w = world({ probe: fp.probe }); const a = w.daemon("a");
    const m = await w.start(a, true);
    await w.until(a, m.mission_id, "revalidating");
    fp.answers.group = true;
    return { fp, w, a, m };
  }
  const push = (w: ReturnType<typeof world>, a: { hp: unknown }, id: string) => w.orphan(a as never, id, "released", "git_push", { remote_target: "o/r#refs/heads/x" });

  it("a delivery never starts over a record that is not proven stopped: the Mission stops in stop_unknown and nothing is pushed again", async () => {
    const { fp, w, a, m } = await toRevalidating();
    const op = push(w, a, m.mission_id);
    const kill = vi.spyOn(process, "kill"); let signalled: unknown[] = [];
    try {
      await a.host.tick();
      for (let i = 0; i < 3; i++) await a.host.tick();
      signalled = kill.mock.calls.filter(([, signal]) => signal !== undefined && signal !== 0);
    } finally { kill.mockRestore(); }
    expect(signalled).toEqual([]);
    expect(w.gates.published).toBe(0);
    expect(a.store.get(m.mission_id).state).toBe("stop_unknown");
    expect(w.halted(a, m.mission_id)).toMatchObject({ reason: `host_process_unproven:${op}`, route: "delivering" });
    expect(a.hp.get(op).state).toBe("released");
    // proven stopped: a person approves, and only then is the (idempotent) delivery attempted
    fp.answers.group = false;
    expect((await a.host.decide(w.principal(), m.mission_id, { kind: "retry_stop_check" })).state).toBe("awaiting_decision");
    expect(w.gates.published).toBe(0);
    expect((await a.host.decide(w.principal(), m.mission_id, { kind: "approve_publication" })).state).toBe("revalidating");
    await a.host.tick();
    expect(w.gates.published).toBe(1);
    expect(a.store.get(m.mission_id).state).toBe("pr_opened");
  });

  it("a publish whose process could not be proven stopped puts the Mission in stop_unknown on the delivering route, with no retry", async () => {
    const { w, a, m } = await toRevalidating();
    w.gates.hook = () => { throw new HostProcessUnprovenError("hp_00000000000000000000000000000009", true); };
    await a.host.tick();
    expect(a.store.get(m.mission_id).state).toBe("stop_unknown");
    expect(w.halted(a, m.mission_id)).toMatchObject({ reason: "host_process_unproven:hp_00000000000000000000000000000009", route: "delivering" });
    expect(w.kinds(a, m.mission_id)).not.toContain("delivery_uncertain");
    expect(w.gates.published).toBe(1);
  });

  it("the release record decides whether the remote can have been written: a rolled-back release is a plain failure, a released push is uncertain", async () => {
    const { w, a, m } = await toRevalidating();
    // The fence recorded remote_mutation but no release row exists (the release transaction rolled back): git never ran.
    w.gates.after = () => { throw Error("boom"); };
    await a.host.tick();
    expect(a.store.get(m.mission_id).state).toBe("awaiting_decision");
    expect(w.halted(a, m.mission_id)?.reason).toMatch(/^publication_failed:/);
    expect(w.kinds(a, m.mission_id)).not.toContain("delivery_uncertain");

    const second = await toRevalidating();
    second.w.gates.hook = (id, d) => { push(second.w, d, id); throw Error("transport lost"); };
    await second.a.host.tick();
    expect(second.a.store.get(second.m.mission_id).state).toBe("delivering");
    expect(second.w.kinds(second.a, second.m.mission_id)).toContain("delivery_uncertain");
    // the next step does not push: the open released record is settled first
    await second.a.host.tick();
    expect(second.w.gates.published).toBe(1);
    expect(second.a.store.get(second.m.mission_id).state).toBe("stop_unknown");
  });
});

describe("recovery by observation (probe double)", () => {
  it("a terminal Mission keeps its claim while a host process is unproven, and releases it once proven", async () => {
    const fp = fakeProbe(); fp.answers.group = true; fp.answers.leader = { pgid: 4242, start: "Fri Nov  6 10:00:00 2026" };
    const w = world({ probe: fp.probe }); const a = w.daemon("a");
    const m = await w.start(a);
    const op = w.orphan(a, m.mission_id, "released");
    a.store.transition(m.mission_id, { if_revision: m.revision, to: "failed", event: { kind: "failed", payload: {} } }, 5000);
    await a.host.recover();
    expect(a.store.get(m.mission_id).state).toBe("failed");
    expect(a.store.claim(m.mission_id).state).toBe("active");
    expect(() => a.store.releaseClaim(m.mission_id, "terminal", 5001)).toThrow();
    expect(a.hp.get(op).state).toBe("released");
    expect(w.kinds(a, m.mission_id)).toContain("host_process_unproven");
    fp.answers.group = false;
    await a.host.recover();
    expect(a.hp.get(op).state).toBe("stopped");
    expect(a.store.claim(m.mission_id).state).toBe("released");
  });

  it.each([
    ["a different start time is pid reuse: stopped", "Fri Nov  6 10:00:07 2026", "Fri Nov  6 10:00:00 2026", "stopped"],
    ["the same start time (same-second reuse) cannot be told apart: unknown", "Fri Nov  6 10:00:00 2026", "Fri Nov  6 10:00:00 2026", "released"],
    ["an unreadable leader start: unknown", null, "Fri Nov  6 10:00:00 2026", "released"],
  ] as const)("pid reuse: %s", async (_name, observed, _recorded, expected) => {
    const fp = fakeProbe(); fp.answers.group = true; fp.answers.leader = { pgid: 4242, start: observed };
    const w = world({ probe: fp.probe }); const a = w.daemon("a");
    const m = await w.start(a);
    const op = w.orphan(a, m.mission_id, "released");
    const kill = vi.spyOn(process, "kill"); let signalled: unknown[] = [];
    try { await a.host.recover(); signalled = kill.mock.calls.filter(([, signal]) => signal !== undefined && signal !== 0); } finally { kill.mockRestore(); }
    expect(a.hp.get(op).state).toBe(expected);
    expect(signalled).toEqual([]);
    if (expected === "released") expect(a.store.get(m.mission_id).state).toBe("stop_unknown");
  });

  it("a cancel stays cancel_requested while a host process is unproven, and the store refuses cancelled and pr_opened", async () => {
    const fp = fakeProbe(); fp.answers.group = true; fp.answers.leader = { pgid: 4242, start: "Fri Nov  6 10:00:00 2026" };
    const w = world({ probe: fp.probe }); const a = w.daemon("a");
    const m = await w.start(a);
    const op = w.orphan(a, m.mission_id, "released");
    const requested = await a.host.cancel(w.principal(), m.mission_id);
    expect(requested.state).toBe("cancel_requested");
    expect(() => a.store.transition(m.mission_id, { if_revision: requested.revision, to: "cancelled", event: { kind: "cancelled", payload: {} } }, 5000)).toThrow("host_process_unproven");
    await expect(a.host.decide(w.principal(), m.mission_id, { kind: "retry_stop_check" })).rejects.toThrow("CONTAINED_STOP_UNPROVEN");
    expect(a.store.get(m.mission_id).state).toBe("cancel_requested");
    fp.answers.group = false;
    expect((await a.host.decide(w.principal(), m.mission_id, { kind: "retry_stop_check" })).state).toBe("cancelled");
    expect(a.hp.get(op).state).toBe("stopped");
  });

  it("an orphaned worktree add: stop_unknown on the authorized route, then workspace_recovered once proven; a second unknown while there keeps the route (T15b)", async () => {
    const fp = fakeProbe(); fp.answers.group = true; fp.answers.leader = { pgid: 4242, start: "Fri Nov  6 10:00:00 2026" };
    const w = world({ probe: fp.probe }); const a = w.daemon("a");
    const m = await w.start(a);
    const first = w.orphan(a, m.mission_id, "released", "git_worktree_add");
    await a.host.recover();
    expect(a.store.get(m.mission_id)).toMatchObject({ state: "stop_unknown", stop_obligation: 1 });
    expect(w.halted(a, m.mission_id)).toMatchObject({ reason: `host_process_unproven:${first}`, route: "authorized", prior_obligation: 0 });
    // nothing new may be launched for a stop_unknown Mission
    expect(() => w.orphan(a, m.mission_id, "launching")).toThrow();
    fp.answers.group = false;
    const settled = await a.host.decide(w.principal(), m.mission_id, { kind: "retry_stop_check" });
    expect(settled).toMatchObject({ state: "awaiting_decision", stop_obligation: 0 });
    expect(w.halted(a, m.mission_id)?.reason).toBe("workspace_recovered");
    expect(a.store.claim(m.mission_id).state).toBe("active");
    // resume_workspace crashes mid-materialization: a new unknown row while awaiting_decision(workspace_recovered)
    fp.answers.group = true;
    const second = w.orphan(a, m.mission_id, "released", "git_index_write");
    await a.host.recover();
    expect(a.store.get(m.mission_id).state).toBe("stop_unknown");
    expect(w.halted(a, m.mission_id)).toMatchObject({ reason: `host_process_unproven:${second}`, route: "authorized" });
    fp.answers.group = false;
    expect((await a.host.decide(w.principal(), m.mission_id, { kind: "retry_stop_check" })).state).toBe("awaiting_decision");
    expect(w.halted(a, m.mission_id)?.reason).toBe("workspace_recovered");
  });

  it("a cancel after a host-only stop_unknown still settles once the host process is proven (no executor proof is owed), even through a second halt", async () => {
    const fp = fakeProbe(); fp.answers.group = true; fp.answers.leader = { pgid: 4242, start: "Fri Nov  6 10:00:00 2026" };
    const w = world({ probe: fp.probe }); const a = w.daemon("a");
    const m = await w.start(a);
    const op = w.orphan(a, m.mission_id, "released", "git_worktree_add");
    await a.host.recover();
    expect(a.store.get(m.mission_id).state).toBe("stop_unknown");
    expect((await a.host.cancel(w.principal(), m.mission_id)).state).toBe("cancel_requested");
    await a.host.recover(); // unknown again: halts a second time and must keep prior_obligation 0
    expect(a.store.get(m.mission_id).state).toBe("stop_unknown");
    expect(w.halted(a, m.mission_id)).toMatchObject({ reason: `host_process_unproven:${op}`, prior_obligation: 0 });
    fp.answers.group = false;
    expect((await a.host.decide(w.principal(), m.mission_id, { kind: "retry_stop_check" })).state).toBe("cancelled");
    expect(a.store.claim(m.mission_id).state).toBe("active");
    await a.host.recover();
    expect(a.store.claim(m.mission_id).state).toBe("released");
  });

  it("abandoning a host-only stop_unknown still frees the claim once the process is proven (terminal recovery owes no executor proof)", async () => {
    const fp = fakeProbe(); fp.answers.group = true; fp.answers.leader = { pgid: 4242, start: "Fri Nov  6 10:00:00 2026" };
    const w = world({ probe: fp.probe }); const a = w.daemon("a");
    const m = await w.start(a);
    w.orphan(a, m.mission_id, "released", "git_worktree_add");
    await a.host.recover();
    expect((await a.host.decide(w.principal(), m.mission_id, { kind: "abandon" })).state).toBe("abandoned");
    await a.host.recover();
    expect(a.store.claim(m.mission_id).state).toBe("active");
    expect(a.store.get(m.mission_id).stop_obligation).toBe(1);
    fp.answers.group = false;
    await a.host.recover();
    expect(a.store.claim(m.mission_id).state).toBe("released");
    expect(a.store.get(m.mission_id).stop_obligation).toBe(0);
  });

  it("an orphaned worktree add proven stopped on the first recovery owes no obligation and still needs resume_workspace", async () => {
    const fp = fakeProbe(); fp.answers.group = false;
    const w = world({ probe: fp.probe }); const a = w.daemon("a");
    const m = await w.start(a);
    w.orphan(a, m.mission_id, "released", "git_worktree_add");
    await a.host.recover();
    expect(a.store.get(m.mission_id)).toMatchObject({ state: "awaiting_decision", stop_obligation: 0 });
    expect(w.halted(a, m.mission_id)?.reason).toBe("workspace_recovered");
    expect(w.kinds(a, m.mission_id)).not.toContain("executor_stopped");
    expect(w.kinds(a, m.mission_id)).toContain("host_process_settled");
    // a tick must not retry the creation
    await a.host.tick();
    expect(a.store.get(m.mission_id).state).toBe("awaiting_decision");
  });

  it("crash windows of the old two-commit exit: rows stopped but still stop_unknown, and stop_unknown with no obligation left", async () => {
    const fp = fakeProbe(); fp.answers.group = false;
    const w = world({ probe: fp.probe }); const a = w.daemon("a");
    const m1 = await w.start(a);
    const op = w.orphan(a, m1.mission_id, "released");
    // rows stopped (committed) before the Mission left stop_unknown
    const halted = a.store.transition(m1.mission_id, { if_revision: m1.revision, to: "stop_unknown", event: { kind: "halted", payload: { reason: `host_process_unproven:${op}`, route: "default", prior_obligation: 0 } } }, 5000);
    expect(halted.stop_obligation).toBe(1);
    a.hp.stopped(op, { proof: "group_empty+marker_unheld", detail: {} });
    await a.host.recover();
    expect(a.store.get(m1.mission_id)).toMatchObject({ state: "needs_reconciliation", stop_obligation: 0 });
    // the obligation was cleared by a crashed earlier exit, the Mission is still stop_unknown
    const m2 = await w.start(a);
    const s2 = a.store.transition(m2.mission_id, { if_revision: m2.revision, to: "stop_unknown", event: { kind: "halted", payload: { reason: "executor_stop_unproven" } } }, 5001);
    a.store.recordStopEvidence(m2.mission_id, s2.revision, { stop_proof: "x" }, 5002);
    await a.host.recover();
    expect(a.store.get(m2.mission_id)).toMatchObject({ state: "needs_reconciliation", stop_obligation: 0 });
  });

  it("settling clears the obligation and leaves stop_unknown in one transaction: a failing exit rolls both back", async () => {
    const fp = fakeProbe(); fp.answers.group = false;
    const w = world({ probe: fp.probe }); const a = w.daemon("a");
    const m = await w.start(a);
    const s = a.store.transition(m.mission_id, { if_revision: m.revision, to: "stop_unknown", event: { kind: "halted", payload: { reason: "x" } } }, 5000);
    expect(() => a.hp.settleStopped(m.mission_id, s.revision, { stop_proof: "x" }, { to: "cancelled", event: { kind: "cancelled", payload: {} } })).toThrow();
    expect(a.store.get(m.mission_id)).toMatchObject({ state: "stop_unknown", stop_obligation: 1, revision: s.revision });
    expect(w.kinds(a, m.mission_id)).not.toContain("executor_stopped");
  });

  it("an orphaned delivery process: stop_unknown on the delivering route, then publication_failed:host_process_recovered, then the idempotent retry", async () => {
    // Real gated launches run first (their online stop proof needs an empty group); then the daemon "crashes" with a live push.
    const fp = fakeProbe(); fp.answers.group = false; fp.answers.leader = { pgid: 4242, start: "Fri Nov  6 10:00:00 2026" };
    const w = world({ probe: fp.probe }); const a = w.daemon("a");
    const m = await w.start(a, true);
    await w.until(a, m.mission_id, "revalidating");
    fp.answers.group = true;
    const held = gate(); w.gates.publish = held;
    const zombie = a.host.tick();
    await held.reached;
    const b = w.daemon("b");
    const op = w.orphan(b, m.mission_id, "released", "git_push", { remote_target: "o/r#refs/heads/x" });
    await b.host.recover();
    expect(b.store.get(m.mission_id).state).toBe("stop_unknown");
    expect(w.halted(b, m.mission_id)).toMatchObject({ route: "delivering", reason: `host_process_unproven:${op}` });
    delete w.gates.publish; held.release(); await zombie;
    fp.answers.group = false;
    expect((await b.host.decide(w.principal(), m.mission_id, { kind: "retry_stop_check" })).state).toBe("awaiting_decision");
    expect(w.halted(b, m.mission_id)?.reason).toBe("publication_failed:host_process_recovered");
    expect((await b.host.decide(w.principal(), m.mission_id, { kind: "approve_publication" })).state).toBe("revalidating");
    await b.host.tick();
    expect(b.store.get(m.mission_id).state).toBe("pr_opened");
  });

  it("the periodic re-check is off by default and settles an open record only when enabled", async () => {
    for (const recheck of [undefined, 1]) {
      const fp = fakeProbe(); fp.answers.group = true; fp.answers.leader = { pgid: 4242, start: "Fri Nov  6 10:00:00 2026" };
      const w = world({ probe: fp.probe, ...(recheck !== undefined ? { host: { recheck } } : {}) }); const a = w.daemon("a");
      const m = await w.start(a);
      w.orphan(a, m.mission_id, "released");
      await a.host.recover();
      expect(a.store.get(m.mission_id).state).toBe("stop_unknown");
      fp.answers.group = false;
      await a.host.tick(); await sleep(5); await a.host.tick();
      expect(a.store.get(m.mission_id).state).toBe(recheck === undefined ? "stop_unknown" : "awaiting_decision");
    }
  });

  it("recovery removes a marker no row names, but not a fresh one", async () => {
    const fp = fakeProbe();
    const w = world({ probe: fp.probe }); const a = w.daemon("a");
    const dir = join(w.root, "host-processes"); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const old = join(dir, "hp_old.hold"); const fresh = join(dir, "hp_fresh.hold");
    writeFileSync(old, ""); writeFileSync(fresh, "");
    utimesSync(old, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    await a.host.recover();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

/** A git that blocks the named subcommand while the hold file exists, then runs the real git. */
function blockingGit(root: string, subcommand: string, hold: string): string {
  const script = join(root, "blocking-git.sh");
  writeFileSync(script, `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = ${subcommand} ]; then while [ -e ${JSON.stringify(hold)} ]; do sleep 0.05; done; fi\ndone\nexec ${REAL_GIT} "$@"\n`);
  chmodSync(script, 0o755);
  return script;
}
async function untilStopped(fn: () => Promise<unknown>, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (error) { if (!(error instanceof Error) || error.message !== "CONTAINED_STOP_UNPROVEN") throw error; await sleep(100); }
  }
  throw Error("process never exited");
}

describe.skipIf(process.platform !== "darwin")("real processes (macOS)", () => {
  it("T10: a commit orphaned in update-ref holds the Mission in stop_unknown until the process exits; then reconciliation restores the branch", { timeout: 120_000 }, async () => {
    const scratch = realpathSync(createScratchDirSync("tests", "hostproc-hold")); cleanup.push(() => rmSync(scratch, { recursive: true, force: true }));
    const hold = join(scratch, "hold"); const bin = blockingGit(scratch, "update-ref", hold);
    const w = world({ gitBinary: bin }); const a = w.daemon("a");
    const m = await w.start(a);
    await w.until(a, m.mission_id, "workspace_ready");
    writeFileSync(hold, "");
    const zombie = a.host.tick();
    for (let i = 0; i < 200 && !w.rows(m.mission_id).some(r => r.kind === "git_update_ref" && r.state === "released"); i++) await sleep(50);
    expect(w.rows(m.mission_id).find(r => r.kind === "git_update_ref")?.state).toBe("released");

    const b = w.daemon("b");
    const kill = vi.spyOn(process, "kill"); let signalled: unknown[] | undefined;
    try { await b.host.recover(); signalled = kill.mock.calls.filter(([, signal]) => signal !== undefined && signal !== 0); } finally { kill.mockRestore(); }
    expect(signalled).toEqual([]);
    expect(b.store.get(m.mission_id).state).toBe("stop_unknown");
    expect(w.halted(b, m.mission_id)).toMatchObject({ route: "default", prior_obligation: 0 });
    expect(b.store.claim(m.mission_id).state).toBe("active");
    await expect(b.host.decide(w.principal(), m.mission_id, { kind: "discard_changes" })).rejects.toThrow("CONTAINED_DECISION_NOT_ALLOWED");
    await expect(b.host.decide(w.principal(), m.mission_id, { kind: "retry_stop_check" })).rejects.toThrow("CONTAINED_STOP_UNPROVEN");

    rmSync(hold); await zombie.catch(() => undefined);
    const settled = await untilStopped(() => b.host.decide(w.principal(), m.mission_id, { kind: "retry_stop_check" })) as ContainedMission;
    expect(settled.state).toBe("needs_reconciliation");
    expect(w.rows(m.mission_id).every(r => r.state === "stopped")).toBe(true);
    const spec = JSON.parse(m.spec_json) as { start_commit: string };
    // the orphan moved the branch after the takeover; discard_changes puts it back before the fresh turn commits on top of start_commit
    expect((await b.host.decide(w.principal(), m.mission_id, { kind: "discard_changes" })).state).toBe("candidate_ready");
    expect(sh(w.repo, "rev-parse", `${w.branchHead(m)}^`)).toBe(spec.start_commit);
  });

  it("a cancel while a released ref update is running aborts it, proves the stop and settles cancelled with the branch unmoved", { timeout: 120_000 }, async () => {
    const scratch = realpathSync(createScratchDirSync("tests", "hostproc-hold")); cleanup.push(() => rmSync(scratch, { recursive: true, force: true }));
    const hold = join(scratch, "hold"); const bin = blockingGit(scratch, "update-ref", hold);
    const w = world({ gitBinary: bin }); const a = w.daemon("a");
    const m = await w.start(a);
    await w.until(a, m.mission_id, "workspace_ready");
    writeFileSync(hold, "");
    const stepping = a.host.tick();
    for (let i = 0; i < 200 && !w.rows(m.mission_id).some(r => r.kind === "git_update_ref" && r.state === "released"); i++) await sleep(50);
    expect(w.rows(m.mission_id).find(r => r.kind === "git_update_ref")?.state).toBe("released");
    await a.host.cancel(w.principal(), m.mission_id);
    await stepping;
    expect(a.store.get(m.mission_id).state).toBe("cancelled");
    expect(w.rows(m.mission_id).every(r => r.state === "stopped")).toBe(true);
    expect(w.branchHead(m)).toBe((JSON.parse(m.spec_json) as { start_commit: string }).start_commit);
  });

  it("T15: an interrupted workspace creation is proven, recovered to workspace_recovered, resumed, and the Mission runs on; a stale index.lock is removed", { timeout: 120_000 }, async () => {
    const scratch = realpathSync(createScratchDirSync("tests", "hostproc-hold")); cleanup.push(() => rmSync(scratch, { recursive: true, force: true }));
    const hold = join(scratch, "hold"); const bin = blockingGit(scratch, "read-tree", hold);
    const w = world({ gitBinary: bin }); const a = w.daemon("a");
    const m = await w.start(a);
    writeFileSync(hold, "");
    const zombie = a.host.tick();
    for (let i = 0; i < 200 && !w.rows(m.mission_id).some(r => r.kind === "git_index_write" && r.state === "released"); i++) await sleep(50);
    const b = w.daemon("b");
    await b.host.recover();
    expect(b.store.get(m.mission_id).state).toBe("stop_unknown");
    expect(w.halted(b, m.mission_id)).toMatchObject({ route: "authorized" });
    rmSync(hold); await zombie.catch(() => undefined);
    // the killed index writer's lock
    const worktree = (JSON.parse(m.spec_json) as { worktree_path: string }).worktree_path;
    const lock = join(sh(worktree, "rev-parse", "--absolute-git-dir"), "index.lock");
    await sleep(1200);
    const settled = await untilStopped(async () => { const s = await b.host.decide(w.principal(), m.mission_id, { kind: "retry_stop_check" }); return s; }) as ContainedMission;
    expect(settled.state).toBe("awaiting_decision");
    expect(w.halted(b, m.mission_id)?.reason).toBe("workspace_recovered");
    expect(existsSync(lock)).toBe(false);
    // a decision other than resume cannot run the Mission
    await expect(b.host.decide(w.principal(), m.mission_id, { kind: "approve_publication" })).rejects.toThrow("CONTAINED_DECISION_NOT_ALLOWED");
    expect((await b.host.decide(w.principal(), m.mission_id, { kind: "resume_workspace" })).state).toBe("workspace_ready");
    expect(w.kinds(b, m.mission_id)).toContain("workspace_created");
    expect(sh(worktree, "status", "--porcelain")).toBe("");
    await w.until(b, m.mission_id, "awaiting_decision");
    expect(w.halted(b, m.mission_id)?.reason).toBe("publication_pending");
    expect(b.store.get(m.mission_id).candidate_verified).toBe(1);
  });

  it("a stale index.lock older than the proof is removed and recorded; resume_workspace refuses a worktree that is gone and leaves only abandon", { timeout: 120_000 }, async () => {
    const scratch = realpathSync(createScratchDirSync("tests", "hostproc-hold")); cleanup.push(() => rmSync(scratch, { recursive: true, force: true }));
    const hold = join(scratch, "hold"); const bin = blockingGit(scratch, "read-tree", hold);
    const w = world({ gitBinary: bin }); const a = w.daemon("a");
    const m = await w.start(a);
    writeFileSync(hold, "");
    const zombie = a.host.tick();
    for (let i = 0; i < 200 && !w.rows(m.mission_id).some(r => r.kind === "git_index_write" && r.state === "released"); i++) await sleep(50);
    const b = w.daemon("b"); await b.host.recover();
    rmSync(hold); await zombie.catch(() => undefined);
    const worktree = (JSON.parse(m.spec_json) as { worktree_path: string }).worktree_path;
    const lock = join(sh(worktree, "rev-parse", "--absolute-git-dir"), "index.lock");
    await sleep(1200); writeFileSync(lock, ""); utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    await untilStopped(() => b.host.decide(w.principal(), m.mission_id, { kind: "retry_stop_check" }));
    expect(existsSync(lock)).toBe(false);
    expect(w.kinds(b, m.mission_id)).toContain("index_lock_removed");
    rmSync(worktree, { recursive: true, force: true });
    expect((await b.host.decide(w.principal(), m.mission_id, { kind: "resume_workspace" })).state).toBe("awaiting_decision");
    expect(w.halted(b, m.mission_id)?.reason).toBe("workspace_failed:host_process_recovered");
    await expect(b.host.decide(w.principal(), m.mission_id, { kind: "resume_workspace" })).rejects.toThrow("CONTAINED_DECISION_NOT_ALLOWED");
    expect((await b.host.decide(w.principal(), m.mission_id, { kind: "abandon" })).state).toBe("abandoned");
    await b.host.recover();
    expect(b.store.claim(m.mission_id).state).toBe("released");
  });

  describe("T3 with the real ledger: a child SIGKILLed at each protocol step, recovered by the next owner", () => {
    const STEPS = ["after_launching", "after_spawn", "after_registered", "after_release_commit", "after_release_write"] as const;
    for (const step of STEPS) {
      it(step, { timeout: 120_000 }, async () => {
        const w = world(); const a = w.daemon("a");
        const m = await w.start(a);
        const sentinel = join(w.root, `sentinel-${step}`);
        const script = join(w.root, "crash-child.mjs");
        writeFileSync(script, `const [core, hp, sqlite, dbPath, markerDir, sentinel, missionId] = process.argv.slice(2);
const { AttentionStore, HostProcessStore } = await import(core);
const Database = (await import(sqlite)).default;
const { runGatedProcess, argvDigest, currentBootSession } = await import(hp);
const db = new Database(dbPath); db.pragma("synchronous=FULL"); db.pragma("foreign_keys=ON"); db.pragma("busy_timeout=5000");
const attention = new AttentionStore(db, dbPath); const owner = attention.claimOwner("child");
const journal = new HostProcessStore(attention, owner);
const args = ["-c", "touch " + sentinel + "; sleep 2"];
await runGatedProcess("/bin/sh", args, { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 20000, maxOutputBytes: 1024, journal, markerDir,
  launch: { mission_id: missionId, kind: "git_update_ref", local_target: "t", argv_digest: argvDigest("/bin/sh", args), boot_id: currentBootSession() ?? "unknown" },
  fence: () => {}, onStep: s => { if (s === process.env.CRASH_AT) process.kill(process.pid, "SIGKILL"); } });
`);
        const child = spawn(process.execPath, [script, pathToFileURL(new URL("../../core/dist/index.js", import.meta.url).pathname).href, pathToFileURL(new URL("../../agents/dist/contained-workspace/host-process.js", import.meta.url).pathname).href,
          pathToFileURL(createRequire(new URL("../../core/package.json", import.meta.url)).resolve("better-sqlite3")).href,
          w.path, join(w.root, "host-processes"), sentinel, m.mission_id], { env: { ...process.env, CRASH_AT: step }, stdio: "ignore" });
        const signal = await new Promise<string | null>(resolve => child.once("exit", (_c, s) => resolve(s)));
        expect(signal).toBe("SIGKILL");
        const before = w.rows(m.mission_id);
        expect(before).toHaveLength(1);
        const released = before[0]!.released_at !== null;
        expect(released).toBe(step === "after_release_commit" || step === "after_release_write");

        const b = w.daemon("b");
        await b.host.recover();
        await sleep(700);
        const running = step === "after_release_write" && existsSync(sentinel);
        if (running) {
          expect(b.store.get(m.mission_id).state).toBe("stop_unknown");
          await untilStopped(() => b.host.decide(w.principal(), m.mission_id, { kind: "retry_stop_check" }));
        } else {
          expect(existsSync(sentinel)).toBe(false);
          if (b.store.get(m.mission_id).state === "stop_unknown") await untilStopped(() => b.host.decide(w.principal(), m.mission_id, { kind: "retry_stop_check" }));
        }
        expect(b.store.get(m.mission_id)).toMatchObject({ state: "awaiting_decision", stop_obligation: 0 });
        expect(w.halted(b, m.mission_id)?.reason).toBe("workspace_recovered");
        const after = w.rows(m.mission_id)[0]!;
        expect(after.state).toBe("stopped");
        if (!released) expect(after.released_at).toBeNull();
        expect(b.store.claim(m.mission_id).state).toBe("active");
      });
    }
  });
});
