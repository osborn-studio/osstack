// W11 M8: interrupt and restart drills (§9, §12 "恢复"). Two daemons share one ledger; the second claims
// ownership mid-step, as a restarted daemon does, while the first keeps running as a zombie owner.
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hardenedGitEnvironment, type CodexProxyRun, type CodexQualification } from "@osstack/agents";
import { AttentionStore, ContainedMissionStore, containedUpgradeHolds, createScratchDirSync, openDb, type ContainedMission } from "@osstack/core";
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
const run = (): CodexProxyRun => ({ launch: { pid: 4242, pgid: 4242, started_at: 1 }, exit_code: 0, signal: null, timed_out: false, cancelled: false,
  stop: { stop_proof: "group_empty+sandbox_inherited", pgid: 4242, signals: [], confirmed_at: 2 }, patch: { ok: true, text: PATCH, bytes: PATCH.length },
  stdout: "", stderr: "", stdout_truncated: false, stderr_truncated: false });
const PR = { number: 7, url: "https://github.com/o/r/pull/7", reused: false };

/** A held-open promise the test releases; `reached` resolves once the port is waiting on it. */
function gate() {
  let release!: () => void; let reached!: () => void;
  const open = new Promise<void>(r => { release = r; }); const arrived = new Promise<void>(r => { reached = r; });
  return { wait: async () => { reached(); await open; }, release, reached: arrived };
}
type Gate = ReturnType<typeof gate>;

function world() {
  const root = realpathSync(createScratchDirSync("tests", "contained-recovery"));
  const repo = join(root, "repo"); mkdirSync(repo);
  for (const [path, content] of Object.entries({ "src/a.txt": "hi\n", "package.json": "{}\n" })) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content); }
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "initial");
  const path = join(root, "state.db"); const db = openDb({ path }); db.pragma("synchronous=FULL");
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const attention = new AttentionStore(db, path);
  const worktreesRoot = join(root, "worktrees"); const journalRoot = join(root, "journal"); mkdirSync(journalRoot);
  let clock = 1000;
  const gates: { execute?: Gate; verify?: Gate; publish?: Gate; afterPush?: Gate } = {};
  const world = { groupEmpty: true, containerGone: true };
  /** Which daemon reached each remote mutation; a refused mutation never appears here. */
  const remote: Array<{ daemon: string; kind: string }> = [];
  let scope: { scope_id: string } | undefined;

  function daemon(name: string) {
    const owner = attention.claimOwner(name);
    scope ??= attention.registerScope(owner, "t", root);
    const store = new ContainedMissionStore(attention, owner);
    const real = createContainedMissionPorts({ store, now: () => ++clock, codex: { bin: join(root, "no-codex"), sourceCodexHome: root }, runtimeRoot: join(root, "runtime"),
      verification: { socketPath: join(root, "docker.sock"), daemonId: "d", baseImageId: `sha256:${"0".repeat(64)}`, journalRoot }, author: { name: "Mission Host", email: "host@example.invalid" } });
    const ports: ContainedMissionHostPorts = { ...real,
      qualify: async () => qualified,
      execute: async input => { input.onLaunched({ pid: 4242, pgid: 4242, started_at: 1 }); await gates.execute?.wait(); return run(); },
      verify: async () => { await gates.verify?.wait(); return { exit_code: 0, output: "ok", cancelled: false, evidence: "docker-removed:x", stopped: true }; },
      verificationStopped: async () => world.containerGone ? { stopped: true, proof: "container_removed", evidence: "docker-gone:x" } : { stopped: false },
      publish: async input => {
        await gates.publish?.wait();
        input.beforeRemoteMutation("push"); remote.push({ daemon: name, kind: "push" });
        await gates.afterPush?.wait();
        input.beforeRemoteMutation("pr_create"); remote.push({ daemon: name, kind: "pr_create" });
        return { pushed_commit: input.permit.head, pr: PR, base_head: "a".repeat(40) };
      } };
    const host = new ContainedMissionHost({ ports, worktreesRoot, processGroupEmpty: () => world.groupEmpty, processesForWorktree: () => [] });
    cleanup.unshift(() => { void host.close(); });
    return { name, store, host };
  }
  const principal = () => ({ principal_id: "human", client_session_id: "cli", read_scopes: [scope!.scope_id], write_scopes: [scope!.scope_id], stop_scopes: [], operator_scopes: [] });
  async function start(d: ReturnType<typeof daemon>, publication = false): Promise<ContainedMission> {
    const spec = await resolveContainedMissionStart({ goal: "say hello", repo_path: repo, base_ref: "main", allowed_paths: ["src/**"], verify: { argv: ["true"] },
      ...(publication ? { publication: { remote: "origin", repository: "o/r", base: "main", draft: true, preauthorized: true } } : {}) }, { worktreesRoot });
    return d.host.start(principal(), { scope_id: scope!.scope_id, spec });
  }
  const kinds = (d: ReturnType<typeof daemon>, id: string) => d.store.events(id, 0, 500).map(e => e.kind);
  const reason = (d: ReturnType<typeof daemon>, id: string) => {
    const e = d.store.events(id, 0, 500).filter(x => x.kind === "halted").at(-1);
    return e ? (JSON.parse(e.payload_json) as { reason: string }).reason : undefined;
  };
  const branchHead = (m: ContainedMission) => sh(repo, "rev-parse", (JSON.parse(m.spec_json) as { branch: string }).branch);
  /** Step until the Mission reaches `state` (each tick is one step). */
  async function until(d: ReturnType<typeof daemon>, id: string, state: ContainedMission["state"], max = 10) {
    for (let i = 0; i < max && d.store.get(id).state !== state; i++) await d.host.tick();
    expect(d.store.get(id).state).toBe(state);
  }
  return { db, repo, gates, world, remote, daemon, start, kinds, reason, branchHead, principal, until };
}

describe("contained Mission restart drills (M8)", () => {
  it("a takeover during an executor turn holds the Mission until the old group is gone, and the old owner's late result writes nothing", async () => {
    const w = world(); const a = w.daemon("a");
    const m = await w.start(a);
    await w.until(a, m.mission_id, "workspace_ready");
    w.gates.execute = gate();
    const zombie = a.host.tick();
    await w.gates.execute.reached;
    expect(a.store.get(m.mission_id).state).toBe("executing");

    const b = w.daemon("b"); w.world.groupEmpty = false;
    await b.host.recover();
    expect(b.store.get(m.mission_id).state).toBe("stop_unknown");
    expect(w.reason(b, m.mission_id)).toBe("executing_stop_unproven_after_restart");
    expect(containedUpgradeHolds(w.db)).toBe(1);
    expect(b.store.claim(m.mission_id).state).toBe("active");

    const before = w.kinds(b, m.mission_id).length;
    w.gates.execute.release(); await zombie;
    expect(w.kinds(b, m.mission_id)).toHaveLength(before);
    expect(w.branchHead(m)).toBe(JSON.parse(m.spec_json).start_commit);
    // A tick of the new owner must not treat the frozen Mission as steppable.
    await b.host.tick();
    expect(b.store.get(m.mission_id).state).toBe("stop_unknown");

    w.world.groupEmpty = true; delete w.gates.execute;
    expect((await b.host.decide(w.principal(), m.mission_id, { kind: "retry_stop_check" })).state).toBe("needs_reconciliation");
    // Reconciliation by the new owner runs a fresh turn, and the candidate still has to be verified.
    expect((await b.host.decide(w.principal(), m.mission_id, { kind: "discard_changes" })).state).toBe("candidate_ready");
    await w.until(b, m.mission_id, "awaiting_decision");
    expect(w.reason(b, m.mission_id)).toBe("publication_pending");
    expect(b.store.get(m.mission_id).candidate_verified).toBe(1);
  });

  it("a takeover during verification never records the old container's result and leaves the candidate unverified", async () => {
    const w = world(); const a = w.daemon("a");
    const m = await w.start(a);
    await w.until(a, m.mission_id, "candidate_ready");
    w.gates.verify = gate();
    const zombie = a.host.tick();
    await w.gates.verify.reached;

    const b = w.daemon("b"); w.world.containerGone = false;
    await b.host.recover();
    expect(b.store.get(m.mission_id).state).toBe("stop_unknown");
    w.gates.verify.release(); await zombie;
    expect(w.kinds(b, m.mission_id)).not.toContain("verify_receipt");
    await expect(b.host.decide(w.principal(), m.mission_id, { kind: "retry_stop_check" })).rejects.toThrow("CONTAINED_STOP_UNPROVEN");

    w.world.containerGone = true;
    const settled = await b.host.decide(w.principal(), m.mission_id, { kind: "retry_stop_check" });
    expect(settled.state).toBe("needs_reconciliation");
    expect(settled.candidate_verified).toBe(0);
    expect(settled.stop_obligation).toBe(0);
  });

  it("a takeover before the first push refuses the old owner's push, and the new owner delivers once", async () => {
    const w = world(); const a = w.daemon("a");
    const m = await w.start(a, true);
    await w.until(a, m.mission_id, "revalidating");
    w.gates.publish = gate();
    const zombie = a.host.tick();
    await w.gates.publish.reached;
    expect(a.store.get(m.mission_id).state).toBe("delivering");

    const b = w.daemon("b");
    await b.host.recover();
    // No executor or container is open during delivery; recovery leaves it for the bounded retry.
    expect(b.store.get(m.mission_id).state).toBe("delivering");
    w.gates.publish.release(); await zombie;
    expect(w.remote).toEqual([]);

    delete w.gates.publish;
    await b.host.tick();
    expect(b.store.get(m.mission_id).state).toBe("pr_opened");
    expect(w.remote).toEqual([{ daemon: "b", kind: "push" }, { daemon: "b", kind: "pr_create" }]);
    expect(w.kinds(b, m.mission_id).filter(k => k === "delivery_evidence")).toHaveLength(1);
  });

  it("a takeover between push and PR creation stops the old owner there, and the new owner's retry records evidence once", async () => {
    const w = world(); const a = w.daemon("a");
    const m = await w.start(a, true);
    await w.until(a, m.mission_id, "revalidating");
    const held = gate(); w.gates.afterPush = held;
    const zombie = a.host.tick();
    await held.reached;

    const b = w.daemon("b"); await b.host.recover();
    delete w.gates.afterPush;
    // Released while the Mission is still delivering at the same revision: only the owner fence can refuse it.
    expect(b.store.get(m.mission_id).state).toBe("delivering");
    held.release(); await zombie;
    expect(w.remote).toEqual([{ daemon: "a", kind: "push" }]);
    expect(w.kinds(b, m.mission_id).filter(k => k === "remote_mutation")).toHaveLength(1);
    await b.host.tick();
    expect(b.store.get(m.mission_id).state).toBe("pr_opened");
    expect(w.remote).toEqual([{ daemon: "a", kind: "push" }, { daemon: "b", kind: "push" }, { daemon: "b", kind: "pr_create" }]);
    const evidence = b.store.events(m.mission_id, 0, 500).filter(e => e.kind === "delivery_evidence");
    expect(evidence).toHaveLength(1);
    expect(JSON.parse(evidence[0]!.payload_json)).toMatchObject({ pr: PR, head: b.store.get(m.mission_id).candidate_head });
  });

  it("a takeover while the old owner prepares a write refuses its write intent, so it never commits", async () => {
    const w = world(); const a = w.daemon("a");
    const m = await w.start(a);
    await w.until(a, m.mission_id, "workspace_ready");
    // Pause inside the host-write phase: the executor has returned and its stop is recorded.
    let b: ReturnType<typeof w.daemon> | undefined;
    const ports = (a.host.runner as unknown as { ports: ContainedMissionHostPorts }).ports;
    const cumulative = ports.cumulativeDiff;
    ports.cumulativeDiff = async input => { const diff = await cumulative(input); b = w.daemon("b"); return diff; };
    await a.host.tick();
    expect(b).toBeDefined();
    expect(w.branchHead(m)).toBe(JSON.parse(m.spec_json).start_commit);
    expect(w.kinds(b!, m.mission_id)).not.toContain("t0_intent");
    await b!.host.recover();
    expect(b!.store.get(m.mission_id).state).toBe("needs_reconciliation");
  });

  it("a takeover during the commit itself stops the old owner before the ref update", async () => {
    const w = world(); const a = w.daemon("a");
    const m = await w.start(a);
    await w.until(a, m.mission_id, "workspace_ready");
    let b: ReturnType<typeof w.daemon> | undefined;
    const ports = (a.host.runner as unknown as { ports: ContainedMissionHostPorts }).ports;
    const commit = ports.commit;
    // One file: the first fence guards its write, the second the ref update. Take over in between.
    ports.commit = input => { let calls = 0; return commit({ ...input, fence: () => { if (++calls === 2) b = w.daemon("b"); input.fence(); } }); };
    await a.host.tick();
    expect(b).toBeDefined();
    expect(w.kinds(b!, m.mission_id)).toContain("t0_intent");
    expect(w.branchHead(m)).toBe(JSON.parse(m.spec_json).start_commit);
    expect(w.kinds(b!, m.mission_id)).not.toContain("candidate_committed");
    await b!.host.recover();
    expect(b!.store.get(m.mission_id).state).toBe("needs_reconciliation");
    // The new owner discards the half-written worktree and runs a fresh turn.
    expect((await b!.host.decide(w.principal(), m.mission_id, { kind: "discard_changes" })).state).toBe("candidate_ready");
  });

  it("a cancel during the commit settles as cancelled, not reconciliation, with the branch unmoved", async () => {
    const w = world(); const a = w.daemon("a");
    const m = await w.start(a);
    await w.until(a, m.mission_id, "workspace_ready");
    const ports = (a.host.runner as unknown as { ports: ContainedMissionHostPorts }).ports;
    const commit = ports.commit; let cancelled: Promise<unknown> | undefined;
    ports.commit = input => commit({ ...input, fence: () => { cancelled ??= a.host.cancel(w.principal(), m.mission_id); input.fence(); } });
    await a.host.tick(); await cancelled;
    expect(a.store.get(m.mission_id).state).toBe("cancelled");
    expect(w.branchHead(m)).toBe(JSON.parse(m.spec_json).start_commit);
    expect(w.kinds(a, m.mission_id)).not.toContain("candidate_committed");
  });

  it("recovery leaves the current owner's own in-flight step alone", async () => {
    const w = world(); const a = w.daemon("a");
    const m = await w.start(a);
    await w.until(a, m.mission_id, "workspace_ready");
    w.gates.execute = gate();
    const step = a.host.tick();
    await w.gates.execute.reached;
    w.world.groupEmpty = false;
    await a.host.recover();
    expect(a.store.get(m.mission_id).state).toBe("executing");
    expect(w.kinds(a, m.mission_id)).not.toContain("halted");
    w.world.groupEmpty = true; w.gates.execute.release(); await step;
    expect(a.store.get(m.mission_id).state).toBe("candidate_ready");
  });
});
