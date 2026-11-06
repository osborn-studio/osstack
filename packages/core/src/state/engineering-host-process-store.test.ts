import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { createScratchDirSync } from "../scratch.js";
import { AttentionStore } from "./attention-store.js";
import { openDb } from "./db.js";
import { ENGINEERING_HOST_PROCESS_DDL } from "./engineering-host-process-ddl.js";
import { ContainedMissionStore, type ContainedMission, type ContainedMissionState } from "./engineering-contained-store.js";
import { HOST_PROCESS_STOP_PROOFS, HostProcessStore, type HostProcessLaunchInput } from "./engineering-host-process-store.js";
import type { EngineeringPrincipal } from "./engineering-store.js";

// The DDL is not registered as a migration yet (see its header): apply it on top of main's current schema.
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => { fn(); }); });
const HEAD = "a".repeat(40); const TREE = "b".repeat(40); const DIFF = "c".repeat(64);
const candidate = { head: HEAD, tree: TREE, diff_digest: DIFF };
const DIGEST = "d".repeat(64);

function setup() {
  const root = realpathSync(createScratchDirSync("tests", "hostproc"));
  const path = join(root, "state.db"); const db = openDb({ path }); db.pragma("synchronous=FULL");
  db.exec(ENGINEERING_HOST_PROCESS_DDL);
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const attention = new AttentionStore(db, path); const owner = attention.claimOwner("owner");
  const scope = attention.registerScope(owner, "t", root);
  const principal: EngineeringPrincipal = { principal_id: "human", client_session_id: "cli", read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [scope.scope_id], operator_scopes: [] };
  const store = new ContainedMissionStore(attention, owner);
  let tick = 5000; const clock = () => tick++;
  const hp = new HostProcessStore(attention, owner, { clock });
  let n = 0;
  const authorize = (branch = `osstack/m/${++n}`) =>
    store.authorize(principal, { scope_id: scope.scope_id, spec: { goal: "fix", max_repair_cycles: 2 }, claim: { repo_identity: "repo", branch, worktree_identity: `wt-${branch}` } }, 1000);
  let ops = 0;
  const input = (m: ContainedMission, over: Partial<HostProcessLaunchInput> = {}): HostProcessLaunchInput => ({
    op_id: `hp_${String(++ops).padStart(32, "0")}`, mission_id: m.mission_id, kind: "git_update_ref", local_target: "repo#refs/heads/x",
    argv_digest: DIGEST, boot_id: "boot-1", marker: { path: "/tmp/osstack/hp.hold", dev: "16777231", ino: "12345" }, ...over,
  });
  const push = (m: ContainedMission, over: Partial<HostProcessLaunchInput> = {}) =>
    input(m, { kind: "git_push", remote_target: "o/r#refs/heads/b", ...over });
  const reg = { pid: 4242, pgid: 4242, leader_start: "Fri Nov  6 10:00:00 2026" };
  return { db, path, root, attention, owner, scope, principal, store, hp, authorize, input, push, reg, clock };
}
type Fixture = ReturnType<typeof setup>;
const step = (f: Fixture, m: ContainedMission, to: ContainedMissionState, extra: { candidate?: typeof candidate; expected_head?: string } = {}) =>
  f.store.transition(m.mission_id, { if_revision: m.revision, to, event: { kind: `to_${to}`, payload: {} }, ...extra }, 2000);
const cleared = (f: Fixture, m: ContainedMission) => f.store.recordStopEvidence(m.mission_id, m.revision, { stop_proof: "x" }, 2100);
const ready = (f: Fixture, branch?: string) => step(f, f.authorize(branch), "workspace_ready");
const toDelivering = (f: Fixture) => {
  let m = step(f, ready(f), "executing", { expected_head: HEAD });
  m = step(f, cleared(f, m), "candidate_ready", { candidate });
  m = cleared(f, step(f, m, "verifying"));
  return step(f, step(f, step(f, m, "verified"), "revalidating"), "delivering");
};
const sql = (f: Fixture, text: string, ...params: unknown[]) => f.db.prepare(text).run(...params);
const proof = (p: (typeof HOST_PROCESS_STOP_PROOFS)[number] = "group_empty+marker_unheld") => ({ proof: p, detail: { waited_ms: 0 } });
const live = (f: Fixture, m: ContainedMission, over: Partial<HostProcessLaunchInput> = {}) => {
  const i = f.input(m, over); f.hp.launching(i); return i.op_id;
};
const releasedOp = (f: Fixture, m: ContainedMission) => {
  const id = live(f, m); f.hp.registered(id, f.reg); f.hp.release(id, () => undefined); return id;
};

describe("journal (W13-B interface)", () => {
  it("runs launching -> registered -> released -> stopped and journals audit events without argv", () => {
    const f = setup(); const m = ready(f);
    const i = f.push(m, { intent_id: "intent-1" });
    f.hp.launching(i);
    expect(f.hp.get(i.op_id)).toMatchObject({ state: "launching", pid: null, released_at: null, intent_id: "intent-1", owner_generation: f.owner.generation });
    f.hp.registered(i.op_id, f.reg);
    expect(f.hp.get(i.op_id)).toMatchObject({ state: "registered", pid: 4242, pgid: 4242, leader_start: f.reg.leader_start });
    expect(f.hp.remoteEffectPossible(i.op_id)).toBe(false);
    f.hp.release(i.op_id, () => undefined);
    expect(f.hp.get(i.op_id).released_at).not.toBeNull();
    expect(f.hp.remoteEffectPossible(i.op_id)).toBe(true);
    f.hp.stopped(i.op_id, { ...proof(), exit_code: 0, exit_signal: null });
    expect(f.hp.get(i.op_id)).toMatchObject({ state: "stopped", stop_proof: "group_empty+marker_unheld", exit_code: 0, exit_signal: null });
    expect(f.hp.open()).toEqual([]);
    const events = f.store.events(m.mission_id).filter(e => e.kind.startsWith("host_process_"));
    expect(events.map(e => e.kind)).toEqual(["host_process_launching", "host_process_registered", "host_process_released", "host_process_stopped"]);
    expect(events.map(e => e.payload_json).join("")).not.toMatch(/argv"|token/i);
  });

  it("accepts a null leader_start and a launching -> stopped(never_spawned) settle", () => {
    const f = setup(); const m = ready(f);
    const a = live(f, m); f.hp.registered(a, { pid: 77, pgid: 77, leader_start: null });
    expect(f.hp.get(a).leader_start).toBeNull();
    f.hp.stopped(a, proof("never_released"));
    const b = live(f, m); f.hp.stopped(b, { proof: "never_spawned", detail: {} });
    expect(f.hp.remoteEffectPossible(b)).toBe(false);
  });

  it("validates input shape", () => {
    const f = setup(); const m = ready(f);
    expect(() => f.hp.launching({ ...f.input(m), op_id: "x_1" })).toThrow("host_process_invalid_op_id");
    expect(() => f.hp.launching({ ...f.input(m), kind: "rm" as never })).toThrow("host_process_invalid_kind");
    expect(() => f.hp.launching(f.input(m, { kind: "git_push" }))).toThrow("host_process_invalid_remote_target");
    expect(() => f.hp.launching({ ...f.input(m), argv_digest: "short" })).toThrow("host_process_invalid_argv_digest");
    expect(() => f.hp.launching({ ...f.input(m), marker: { path: "/p", dev: "abc", ino: "1" } })).toThrow("host_process_invalid_marker");
    expect(() => f.hp.launching({ ...f.input(m), boot_id: "" })).toThrow("host_process_invalid_boot_id");
    const id = live(f, m);
    expect(() => f.hp.registered(id, { pid: 1, pgid: 1, leader_start: null })).toThrow("host_process_invalid_identity");
    expect(() => f.hp.registered(id, { pid: 9, pgid: 8, leader_start: null })).toThrow("host_process_invalid_identity");
    expect(() => f.hp.stopped(id, { proof: "bogus" as never, detail: {} })).toThrow("host_process_invalid_proof");
    expect(() => f.hp.stopped(id, { proof: "never_spawned", detail: { x: "y".repeat(5000) } })).toThrow("host_process_detail_too_large");
    expect(() => f.hp.stopped(id, { proof: "never_spawned", detail: {}, exit_code: 1.5 })).toThrow("host_process_invalid_exit");
    expect(() => f.hp.get("hp_missing")).toThrow("not_found");
  });

  it("refuses out-of-order journal calls and double stop", () => {
    const f = setup(); const m = ready(f);
    const id = live(f, m);
    expect(() => f.hp.release(id, () => undefined)).toThrow("host_process_flow");
    f.hp.registered(id, f.reg);
    expect(() => f.hp.registered(id, f.reg)).toThrow("host_process_flow");
    f.hp.release(id, () => undefined);
    expect(() => f.hp.release(id, () => undefined)).toThrow("host_process_flow");
    f.hp.stopped(id, proof());
    expect(() => f.hp.stopped(id, proof())).toThrow("host_process_already_stopped");
    expect(() => f.hp.release("hp_nope", () => undefined)).toThrow("not_found");
  });

  it("release rolls back the fence's own writes when the fence throws", () => {
    const f = setup(); const m = ready(f);
    const id = live(f, m); f.hp.registered(id, f.reg);
    const before = f.store.events(m.mission_id).length;
    expect(() => f.hp.release(id, () => { f.store.record(m.mission_id, "remote_mutation", {}, 3000); throw Error("fence_denied"); })).toThrow("fence_denied");
    expect(f.hp.get(id)).toMatchObject({ state: "registered", released_at: null });
    expect(f.store.events(m.mission_id)).toHaveLength(before);
    // and a fence that succeeds commits its write together with the release
    f.hp.release(id, () => { f.store.record(m.mission_id, "remote_mutation", {}, 3000); });
    expect(f.hp.get(id).state).toBe("released");
    expect(f.store.events(m.mission_id).map(e => e.kind)).toContain("remote_mutation");
  });

  it("rejects an asynchronous fence and rolls back", () => {
    const f = setup(); const m = ready(f);
    const id = live(f, m); f.hp.registered(id, f.reg);
    expect(() => f.hp.release(id, (() => Promise.resolve()) as never)).toThrow("host_process_fence_async");
    expect(f.hp.get(id).state).toBe("registered");
  });

  it("refuses to run inside an outer transaction (all four durable writes, and settleStopped)", () => {
    const f = setup(); const m = ready(f);
    const id = live(f, m); f.hp.registered(id, f.reg);
    const nested = (fn: () => void) => () => f.db.transaction(fn)();
    expect(nested(() => f.hp.launching(f.input(m)))).toThrow("host_process_nested_transaction");
    expect(nested(() => f.hp.registered(id, f.reg))).toThrow("host_process_nested_transaction");
    expect(nested(() => f.hp.release(id, () => undefined))).toThrow("host_process_nested_transaction");
    expect(nested(() => f.hp.stopped(id, proof()))).toThrow("host_process_nested_transaction");
    expect(nested(() => f.hp.settleStopped(m.mission_id, 1, {}, { to: "needs_reconciliation", event: { kind: "e", payload: {} } }))).toThrow("host_process_nested_transaction");
    expect(f.hp.get(id).state).toBe("registered");
    expect(f.hp.open()).toHaveLength(1);
  });

  it("requires synchronous=FULL", () => {
    const f = setup(); const m = ready(f);
    const id = live(f, m);
    f.db.pragma("synchronous=NORMAL");
    expect(() => f.hp.launching(f.input(m))).toThrow("durability_required");
    expect(() => f.hp.registered(id, f.reg)).toThrow("durability_required");
    expect(() => f.hp.release(id, () => undefined)).toThrow("durability_required");
    expect(() => f.hp.stopped(id, proof("never_spawned"))).toThrow("durability_required");
    expect(() => f.hp.settleStopped(m.mission_id, 1, {}, { to: "needs_reconciliation", event: { kind: "e", payload: {} } })).toThrow("durability_required");
  });

  it("is fenced by the daemon owner and exposes older-generation records to recovery", () => {
    const f = setup(); const m = ready(f);
    const id = live(f, m);
    expect(f.hp.openForRecovery()).toEqual([]);
    expect(f.hp.openForRecovery(100, new Set([id])).map(r => r.op_id)).toEqual([]);
    expect(f.hp.openForRecovery(100, new Set()).map(r => r.op_id)).toEqual([id]); // current owner, no live handle
    const owner2 = f.attention.claimOwner("owner-2");
    expect(() => f.hp.registered(id, f.reg)).toThrow("stale_owner");
    expect(() => f.hp.launching(f.input(m))).toThrow("stale_owner");
    const hp2 = new HostProcessStore(f.attention, owner2, { clock: f.clock });
    expect(hp2.openForRecovery().map(r => r.op_id)).toEqual([id]);
    expect(hp2.missionsWithOpen()).toEqual([m.mission_id]);
    hp2.stopped(id, proof("rebooted"));
    expect(hp2.openForRecovery()).toEqual([]);
    expect(hp2.stoppedProofs(m.mission_id)).toEqual([{ op_id: id, proof: "rebooted" }]);
    const r = live2(hp2, f, m);
    expect(hp2.openForRecovery()).toEqual([]);
    expect(hp2.open(m.mission_id).map(x => x.op_id)).toEqual([r]);
    expect(hp2.hasOpen(m.mission_id)).toBe(true);
  });

  it("records unproven recovery observations without touching the row", () => {
    const f = setup(); const m = ready(f);
    const id = releasedOp(f, m);
    f.hp.recordUnproven(id, "group_alive");
    expect(f.hp.get(id).state).toBe("released");
    const e = f.store.events(m.mission_id).find(x => x.kind === "host_process_unproven")!;
    expect(JSON.parse(e.payload_json)).toMatchObject({ op_id: id, reason: "group_alive", state: "released" });
    expect(() => f.hp.recordUnproven(id, "")).toThrow("invalid_reason");
  });
});

function live2(hp: HostProcessStore, f: Fixture, m: ContainedMission): string {
  const i = f.input(m); hp.launching(i); return i.op_id;
}

describe("insert triggers and indexes (direct SQL must abort)", () => {
  const raw = (f: Fixture, m: ContainedMission, over: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      op_id: "hp_raw1", mission_id: m.mission_id, kind: "git_update_ref", remote_target: null, local_target: "l", intent_id: null, argv_digest: DIGEST,
      owner_home: "h", owner_instance: "i", owner_generation: 1, boot_id: "b", marker_path: "/m", marker_dev: "1", marker_ino: "2",
      state: "launching", pid: null, pgid: null, leader_start: null, released_at: null, exit_code: null, exit_signal: null,
      stop_proof: null, stop_detail_json: null, created_at: 1, updated_at: 1, ...over,
    };
    const cols = Object.keys(row);
    return f.db.prepare(`INSERT INTO engineering_host_processes(${cols.join(",")}) VALUES(${cols.map(c => `@${c}`).join(",")})`).run(row);
  };

  it("accepts a well-formed launching row (control)", () => {
    const f = setup(); const m = ready(f);
    expect(raw(f, m).changes).toBe(1);
  });

  it("insert_shape: stopped, released and registered rows cannot be inserted", () => {
    const f = setup(); const m = ready(f);
    expect(() => raw(f, m, { state: "stopped", stop_proof: "never_spawned" })).toThrow("host_process_insert_invalid");
    expect(() => raw(f, m, { state: "released", pid: 5, pgid: 5, released_at: 1 })).toThrow("host_process_insert_invalid");
    expect(() => raw(f, m, { state: "registered", pid: 5, pgid: 5 })).toThrow("host_process_insert_invalid");
    for (const extra of [{ pid: 5, pgid: 5 }, { leader_start: "x" }, { released_at: 1 }, { exit_code: 0 }, { exit_signal: "SIGKILL" }, { stop_proof: "p" }, { stop_detail_json: "{}" }]) {
      expect(() => raw(f, m, extra)).toThrow("host_process_insert_invalid");
    }
    expect(f.db.prepare("SELECT COUNT(*) n FROM engineering_host_processes").get()).toEqual({ n: 0 });
  });

  it("insert_gate: terminal, stop_unknown, cancel_requested, stop_obligation=1 and unknown Missions are refused", () => {
    const f = setup();
    const missions: Record<string, ContainedMission> = {
      stop_unknown: step(f, ready(f), "stop_unknown"),
      cancel_requested: step(f, ready(f), "cancel_requested"),
      executing: step(f, ready(f), "executing", { expected_head: HEAD }),
      failed: step(f, ready(f), "failed"),
      abandoned: step(f, step(f, ready(f), "awaiting_decision"), "abandoned"),
      cancelled: step(f, step(f, ready(f), "cancel_requested"), "cancelled"),
    };
    for (const [name, m] of Object.entries(missions)) {
      expect(() => raw(f, m, { op_id: `hp_${name}` }), name).toThrow("host_process_launch_denied");
      expect(() => f.hp.launching(f.input(m)), name).toThrow("host_process_launch_denied");
    }
    expect(() => raw(f, { mission_id: "cm_missing" } as ContainedMission)).toThrow("host_process_launch_denied");
    for (const to of ["authorized", "awaiting_decision", "needs_reconciliation"] as const) {
      const m = to === "authorized" ? f.authorize() : step(f, ready(f), to);
      expect(raw(f, m, { op_id: `hp_ok_${to}` }).changes).toBe(1);
    }
  });

  it("partial unique index: at most one open record per Mission, reusable after stopped", () => {
    const f = setup(); const m = ready(f);
    const a = live(f, m);
    expect(() => f.hp.launching(f.input(m))).toThrow("host_process_mission_busy");
    expect(() => raw(f, m, { op_id: "hp_dup_mission" })).toThrow("host_process_mission_busy");
    f.hp.stopped(a, { proof: "never_spawned", detail: {} });
    expect(() => live(f, m)).not.toThrow();
  });

  it("partial unique index: at most one open record per remote branch across Missions", () => {
    const f = setup(); const m1 = ready(f); const m2 = ready(f);
    const a = f.push(m1); f.hp.launching(a);
    expect(() => f.hp.launching(f.push(m2))).toThrow("host_process_remote_busy");
    expect(() => raw(f, m2, { op_id: "hp_dup_remote", kind: "git_push", remote_target: "o/r#refs/heads/b" })).toThrow("host_process_remote_busy");
    // a different remote branch, and local (NULL remote_target) records of two Missions, do not collide
    expect(() => f.hp.launching(f.push(m2, { remote_target: "o/r#refs/heads/other" }))).not.toThrow();
    const m3 = ready(f); const m4 = ready(f);
    expect(() => { live(f, m3); live(f, m4); }).not.toThrow();
    // once stopped the branch is free again
    f.hp.stopped(a.op_id, { proof: "never_spawned", detail: {} });
    const m5 = ready(f);
    expect(() => f.hp.launching(f.push(m5))).not.toThrow();
  });

  it("op_id cannot be NULL", () => {
    const f = setup(); const m = ready(f);
    expect(() => raw(f, m, { op_id: null })).toThrow(/NOT NULL constraint failed/);
  });

  it("INSERT OR REPLACE cannot erase an open record or bypass the claim and Mission guards", () => {
    const f = setup(); const m = ready(f);
    const id = releasedOp(f, m);
    const cols = "op_id,mission_id,kind,local_target,argv_digest,owner_home,owner_instance,owner_generation,boot_id,marker_path,marker_dev,marker_ino,state,created_at,updated_at";
    const vals = (op: string) => `'${op}','${m.mission_id}','git_update_ref','l','${DIGEST}','h','i',1,'b','/m','1','2','launching',1,1`;
    expect(() => f.db.exec(`INSERT OR REPLACE INTO engineering_host_processes(${cols}) VALUES(${vals("hp_replace_mission")})`)).toThrow("host_process_mission_busy");
    expect(() => f.db.exec(`INSERT OR REPLACE INTO engineering_host_processes(${cols}) VALUES(${vals(id)})`)).toThrow(/host_process_(mission_busy|op_exists)/);
    expect(f.hp.get(id).state).toBe("released");
    const claim = f.store.claim(m.mission_id);
    expect(() => f.db.prepare(`INSERT OR REPLACE INTO engineering_workspace_claims(claim_id,mission_id,repo_identity,branch,worktree_identity,state,created_at,released_at,release_reason)
      VALUES(?,?,?,?,?,'released',1,2,'x')`).run(claim.claim_id, m.mission_id, claim.repo_identity, claim.branch, claim.worktree_identity)).toThrow("claim_release_denied");
    expect(f.store.claim(m.mission_id).state).toBe("active");
    // a DIFFERENT Mission replacing this Mission's claim through a claim_id or branch/worktree conflict
    const other = ready(f);
    const steal = (claimId: string, branch: string, worktree: string) => () => f.db.prepare(`INSERT OR REPLACE INTO engineering_workspace_claims(claim_id,mission_id,repo_identity,branch,worktree_identity,state,created_at)
      VALUES(?,?,?,?,?,'active',1)`).run(claimId, other.mission_id, "repo", branch, worktree);
    expect(steal("wc_new", claim.branch, "wt-fresh")).toThrow("claim_release_denied");
    expect(steal("wc_new", "branch-fresh", claim.worktree_identity)).toThrow("claim_release_denied");
    expect(steal(claim.claim_id, "branch-fresh", "wt-fresh")).toThrow("claim_release_denied");
    expect(f.store.claim(m.mission_id)).toMatchObject({ state: "active", branch: claim.branch });
    expect(() => f.db.prepare(`INSERT OR REPLACE INTO engineering_contained_missions(mission_id,scope_id,owner_principal_id,owner_client_session_id,spec_digest,spec_json,state,revision,created_at,updated_at)
      VALUES(?,?,?,?,?,'{}','failed',9,1,1)`).run(m.mission_id, m.scope_id, m.owner_principal_id, m.owner_client_session_id, m.spec_digest)).toThrow("host_process_unproven");
    expect(f.store.get(m.mission_id).state).toBe("workspace_ready");
    expect(() => f.db.exec(`INSERT OR REPLACE INTO engineering_host_processes(${cols}) VALUES(${vals("hp_other")})`)).toThrow();
    f.hp.stopped(id, proof());
    expect(f.hp.open()).toEqual([]);
  });

  it("unique intent_id (all states) and op_id", () => {
    const f = setup(); const m1 = ready(f); const m2 = ready(f);
    const a = f.push(m1, { intent_id: "i1" }); f.hp.launching(a);
    f.hp.stopped(a.op_id, { proof: "never_spawned", detail: {} });
    expect(() => f.hp.launching(f.push(m2, { intent_id: "i1", remote_target: "o/r#refs/heads/z" }))).toThrow("host_process_intent_reused");
    expect(() => f.hp.launching({ ...f.input(m2), op_id: a.op_id })).toThrow("host_process_op_exists");
  });

  it("CHECKs have no NULL holes", () => {
    const f = setup(); const m = ready(f);
    const id = live(f, m);
    const upd = (set: string) => () => f.db.prepare(`UPDATE engineering_host_processes SET ${set} WHERE op_id=?`).run(id);
    // registered with pid but NULL pgid (the `pgid = pid` NULL hole), NULL pid with pgid, pid <= 1, pgid <> pid
    expect(upd("state='registered',pid=5")).toThrow(/CHECK constraint failed/);
    expect(upd("state='registered',pgid=5")).toThrow(/CHECK constraint failed/);
    expect(upd("state='registered',pid=1,pgid=1")).toThrow(/CHECK constraint failed/);
    expect(upd("state='registered',pid=5,pgid=6")).toThrow(/CHECK constraint failed/);
    expect(upd("state='registered',pid='abc',pgid='abc'")).toThrow(/CHECK constraint failed/);
    expect(upd("state='registered'")).toThrow(/CHECK constraint failed/);
    expect(upd("state='registered',leader_start='x'")).toThrow(/CHECK constraint failed/);
    expect(upd("state='stopped'")).toThrow(/CHECK constraint failed/);
    expect(upd("state='stopped',stop_proof=''")).toThrow(/CHECK constraint failed/);
    expect(upd("state='stopped',stop_proof='never_spawned',stop_detail_json='not json'")).toThrow(/CHECK constraint failed/);
    expect(upd(`state='stopped',stop_proof='never_spawned',stop_detail_json='"${"x".repeat(4100)}"'`)).toThrow(/CHECK constraint failed/);
    f.hp.registered(id, f.reg);
    expect(upd("state='released',released_at=NULL")).toThrow(/CHECK constraint failed/);
    expect(upd("state='released',released_at='soon'")).toThrow(/CHECK constraint failed/);
    expect(() => f.db.prepare("UPDATE engineering_host_processes SET exit_code=1 WHERE op_id=?").run(id)).toThrow(/CHECK constraint failed|host_process_flow/);
    // table-level CHECKs a trigger would mask are exercised against a scratch copy of the table
    const scratch = new Database(":memory:");
    const table = (f.db.prepare("SELECT sql FROM sqlite_master WHERE name='engineering_host_processes'").get() as { sql: string }).sql
      .replace(/REFERENCES engineering_contained_missions\(mission_id\)/, "");
    scratch.exec(table);
    const ins = (over: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        op_id: "hp_x", mission_id: "m", kind: "git_update_ref", remote_target: null, local_target: "l", intent_id: null, argv_digest: DIGEST,
        owner_home: "h", owner_instance: "i", owner_generation: 1, boot_id: "b", marker_path: "/m", marker_dev: "1", marker_ino: "2",
        state: "launching", pid: null, pgid: null, leader_start: null, released_at: null, exit_code: null, exit_signal: null,
        stop_proof: null, stop_detail_json: null, created_at: 1, updated_at: 1, ...over,
      };
      const cols = Object.keys(row);
      return () => scratch.prepare(`INSERT INTO engineering_host_processes(${cols.join(",")}) VALUES(${cols.map(c => `@${c}`).join(",")})`).run(row);
    };
    expect(ins({})).not.toThrow();
    const bad: Array<[string, Record<string, unknown>]> = [
      ["registered pgid NULL", { op_id: "hp_1", state: "registered", pid: 5 }],
      ["registered pid NULL", { op_id: "hp_2", state: "registered", pgid: 5 }],
      ["registered pgid != pid", { op_id: "hp_3", state: "registered", pid: 5, pgid: 6 }],
      ["registered pid 1", { op_id: "hp_4", state: "registered", pid: 1, pgid: 1 }],
      ["pid text", { op_id: "hp_5", state: "registered", pid: "abc", pgid: "abc" }],
      ["launching with pid", { op_id: "hp_6", pid: 5, pgid: 5 }],
      ["launching with released_at", { op_id: "hp_7", released_at: 1 }],
      ["released_at without pid", { op_id: "hp_8", state: "stopped", stop_proof: "p", released_at: 1 }],
      ["registered with released_at", { op_id: "hp_9", state: "registered", pid: 5, pgid: 5, released_at: 1 }],
      ["released without released_at", { op_id: "hp_10", state: "released", pid: 5, pgid: 5 }],
      ["stopped without proof", { op_id: "hp_11", state: "stopped" }],
      ["exit code on non-stopped", { op_id: "hp_12", exit_code: 1 }],
      ["proof on non-stopped", { op_id: "hp_13", stop_proof: "p" }],
      ["push without remote", { op_id: "hp_14", kind: "git_push" }],
      ["pr without remote", { op_id: "hp_15", kind: "gh_pr_create" }],
      ["bad op prefix", { op_id: "hpX1" }],
      ["op prefix wildcard", { op_id: "hp" }],
      ["bad kind", { op_id: "hp_16", kind: "rm" }],
      ["bad digest", { op_id: "hp_17", argv_digest: "abc" }],
      ["bad state", { op_id: "hp_18", state: "weird" }],
      ["generation 0", { op_id: "hp_19", owner_generation: 0 }],
      ["leader_start without pid", { op_id: "hp_20", leader_start: "x" }],
      ["pgid without pid", { op_id: "hp_21", pgid: 5 }],
      ["null owner", { op_id: "hp_22", owner_home: null }],
    ];
    for (const [name, over] of bad) expect(ins(over), name).toThrow(/CHECK constraint failed|NOT NULL constraint failed/);
    scratch.close();
  });
});

describe("update triggers", () => {
  const upd = (f: Fixture, id: string, set: string, ...p: unknown[]) => () => f.db.prepare(`UPDATE engineering_host_processes SET ${set} WHERE op_id=?`).run(...p, id);

  it("fixed columns cannot change", () => {
    const f = setup(); const m = ready(f);
    const id = live(f, m, { intent_id: "i" });
    for (const set of ["mission_id='cm_x'", "kind='git_push'", "remote_target='r'", "local_target='x'", "intent_id='j'", "intent_id=NULL", `argv_digest='${"e".repeat(64)}'`,
      "owner_home='h2'", "owner_instance='i2'", "owner_generation=99", "boot_id='b2'", "marker_path='/other'", "marker_dev='9'", "marker_ino='9'", "created_at=1", "op_id='hp_new'"]) {
      // ride on a legal transition so only the fixed-column trigger can object
      expect(upd(f, id, `state='registered',pid=5,pgid=5,${set}`), set).toThrow("host_process_immutable");
    }
  });

  it("flow: only the five legal transitions; stopped is terminal; no same-state update", () => {
    const f = setup(); const m = ready(f);
    const a = live(f, m);
    expect(upd(f, a, "state='released',released_at=1,pid=5,pgid=5"), "launching->released").toThrow("host_process_flow");
    expect(upd(f, a, "updated_at=9"), "launching->launching").toThrow("host_process_flow");
    f.hp.registered(a, f.reg);
    expect(upd(f, a, "state='launching'"), "registered->launching").toThrow("host_process_flow");
    expect(upd(f, a, "updated_at=9"), "registered->registered").toThrow("host_process_flow");
    f.hp.release(a, () => undefined);
    expect(upd(f, a, "state='registered',released_at=NULL"), "released->registered").toThrow("host_process_flow");
    expect(upd(f, a, "updated_at=9"), "released->released").toThrow("host_process_flow");
    f.hp.stopped(a, proof());
    for (const to of ["launching", "registered", "released", "stopped"]) expect(upd(f, a, `state='${to}'`), `stopped->${to}`).toThrow("host_process_flow");
  });

  it("flow: pid/pgid/leader_start are set once, released_at only on registered -> released", () => {
    const f = setup(); const m = ready(f);
    const a = live(f, m);
    f.hp.registered(a, f.reg);
    expect(upd(f, a, "state='released',released_at=1,pid=7,pgid=7"), "pid change").toThrow("host_process_flow");
    expect(upd(f, a, "state='released',released_at=1,leader_start='other'"), "leader_start change").toThrow("host_process_flow");
    expect(upd(f, a, "state='stopped',stop_proof='already_stopped',pid=NULL,pgid=NULL"), "clear pid").toThrow(/host_process_flow|CHECK/);
    expect(upd(f, a, "state='stopped',stop_proof='already_stopped',released_at=5"), "released_at at stop").toThrow("host_process_flow");
    f.hp.release(a, () => undefined);
    expect(upd(f, a, "state='stopped',stop_proof='group_empty+marker_unheld',released_at=NULL"), "clear released_at").toThrow("host_process_flow");
    expect(upd(f, a, "state='stopped',stop_proof='group_empty+marker_unheld',released_at=released_at+1"), "move released_at").toThrow("host_process_flow");
  });

  it("proof: never_released / never_spawned / never_registered cannot be claimed against the wrong history", () => {
    const f = setup(); const m = ready(f);
    const released = releasedOp(f, m);
    expect(() => f.hp.stopped(released, proof("never_released"))).toThrow("host_process_proof_mismatch");
    f.hp.stopped(released, proof());
    const reg = live(f, m); f.hp.registered(reg, f.reg);
    expect(() => f.hp.stopped(reg, { proof: "never_spawned", detail: {} })).toThrow("host_process_proof_mismatch");
    expect(() => f.hp.stopped(reg, proof("never_registered+marker_unheld"))).toThrow("host_process_proof_mismatch");
    expect(() => f.hp.stopped(reg, proof("never_released"))).not.toThrow();
    const launching = live(f, m);
    expect(() => f.hp.stopped(launching, proof("never_registered+marker_unheld"))).not.toThrow();
  });

  it("rows cannot be deleted", () => {
    const f = setup(); const m = ready(f);
    const a = live(f, m); f.hp.stopped(a, { proof: "never_spawned", detail: {} });
    expect(() => f.db.prepare("DELETE FROM engineering_host_processes").run()).toThrow("host_process_immutable");
  });
});

describe("holds on the Mission while a record is unproven", () => {
  it("claim release is denied while a record is open and allowed after stopped", () => {
    const f = setup(); const m = step(f, step(f, ready(f), "awaiting_decision"), "abandoned"); // terminal, obligation 0, but claim still active
    // abandoned is terminal now; open a record first on a fresh Mission and abandon it afterwards (design 10.5a)
    expect(f.store.releaseClaim(m.mission_id, "done", 3000).state).toBe("released");
    const m2 = step(f, ready(f), "awaiting_decision");
    const id = live(f, m2);
    const m3 = step(f, m2, "abandoned");
    expect(m3.state).toBe("abandoned");
    expect(() => f.store.releaseClaim(m3.mission_id, "done", 3000)).toThrow("claim_release_denied");
    expect(() => sql(f, "UPDATE engineering_workspace_claims SET state='released',released_at=1,release_reason='x' WHERE mission_id=?", m3.mission_id)).toThrow("claim_release_denied");
    expect(f.store.claim(m3.mission_id).state).toBe("active");
    f.hp.stopped(id, { proof: "never_spawned", detail: {} });
    expect(f.store.releaseClaim(m3.mission_id, "done", 3000).state).toBe("released");
  });

  it("claim release by the supersedes handoff is denied while a record is open", () => {
    const f = setup();
    const m = step(f, ready(f), "awaiting_decision");
    const id = live(f, m);
    step(f, m, "abandoned");
    expect(() => f.store.authorize(f.principal, { scope_id: f.scope.scope_id, spec: { goal: "x" }, supersedes: m.mission_id, claim: { repo_identity: "repo", branch: "osstack/m/1", worktree_identity: "wt-osstack/m/1" } }, 4000)).toThrow("claim_release_denied");
    f.hp.stopped(id, { proof: "never_spawned", detail: {} });
    expect(f.store.authorize(f.principal, { scope_id: f.scope.scope_id, spec: { goal: "x" }, supersedes: m.mission_id, claim: { repo_identity: "repo", branch: "osstack/m/1", worktree_identity: "wt-osstack/m/1" } }, 4000).state).toBe("authorized");
  });

  it("cancelled is denied while a record is open and allowed after stopped", () => {
    const f = setup(); const m = ready(f);
    const id = releasedOp(f, m);
    const cr = step(f, m, "cancel_requested");
    expect(() => step(f, cr, "cancelled")).toThrow("host_process_unproven");
    expect(() => sql(f, "UPDATE engineering_contained_missions SET state='cancelled',revision=revision+1 WHERE mission_id=?", m.mission_id)).toThrow("host_process_unproven");
    f.hp.stopped(id, proof());
    expect(step(f, cr, "cancelled").state).toBe("cancelled");
  });

  it("pr_opened is denied while a record is open and allowed after stopped", () => {
    const f = setup(); const m = toDelivering(f);
    const id = live(f, m, { kind: "gh_pr_create", remote_target: "o/r#refs/heads/b" });
    expect(() => step(f, m, "pr_opened")).toThrow("host_process_unproven");
    f.hp.stopped(id, { proof: "never_spawned", detail: {} });
    expect(step(f, m, "pr_opened").state).toBe("pr_opened");
  });

  it("clearing stop_obligation is denied while a record is open and allowed after stopped", () => {
    const f = setup(); const m = ready(f);
    const id = releasedOp(f, m);
    const su = step(f, m, "stop_unknown");
    expect(su.stop_obligation).toBe(1);
    expect(() => cleared(f, su)).toThrow("host_process_unproven");
    expect(() => sql(f, "UPDATE engineering_contained_missions SET stop_obligation=0,revision=revision+1 WHERE mission_id=?", m.mission_id)).toThrow("host_process_unproven");
    f.hp.stopped(id, proof());
    expect(cleared(f, su).stop_obligation).toBe(0);
  });

  it("a stopped record does not block anything", () => {
    const f = setup(); const m = ready(f);
    const id = live(f, m); f.hp.stopped(id, { proof: "never_spawned", detail: {} });
    expect(step(f, step(f, m, "cancel_requested"), "cancelled").state).toBe("cancelled");
    expect(f.store.releaseClaim(m.mission_id, "done", 3000).state).toBe("released");
  });

  it("listOutstanding and upgrade holds keep counting a Mission with an open record", () => {
    const f = setup(); const m = step(f, ready(f), "awaiting_decision");
    live(f, m); step(f, m, "abandoned");
    expect(f.store.listOutstanding().map(x => x.mission_id)).toContain(m.mission_id);
  });
});

describe("settleStopped", () => {
  const exit = { to: "needs_reconciliation" as const, event: { kind: "host_process_recovered", payload: { by: "test" } } };

  it("clears the obligation and leaves stop_unknown in one transaction", () => {
    const f = setup(); const m = ready(f);
    const id = releasedOp(f, m);
    const su = step(f, m, "stop_unknown");
    expect(() => f.hp.settleStopped(m.mission_id, su.revision, { stop_proof: "x" }, exit)).toThrow("host_process_unproven");
    f.hp.stopped(id, proof());
    const done = f.hp.settleStopped(m.mission_id, su.revision, { host_processes: f.hp.stoppedProofs(m.mission_id) }, exit);
    expect(done).toMatchObject({ state: "needs_reconciliation", stop_obligation: 0, revision: su.revision + 2 });
    const kinds = f.store.events(m.mission_id).map(e => e.kind);
    expect(kinds.slice(-2)).toEqual(["executor_stopped", "host_process_recovered"]);
  });

  it("skips the obligation clear when it is already 0 and still records evidence", () => {
    const f = setup(); const m = ready(f);
    const su = step(f, m, "stop_unknown");
    const cleared0 = cleared(f, su);
    expect(cleared0).toMatchObject({ state: "stop_unknown", stop_obligation: 0 });
    const done = f.hp.settleStopped(m.mission_id, cleared0.revision, { why: "legacy" }, exit);
    expect(done).toMatchObject({ state: "needs_reconciliation", stop_obligation: 0 });
    expect(f.store.events(m.mission_id).map(e => e.kind)).toContain("host_process_settled");
  });

  it("settles an authorized orphan (obligation never set) without clearing anything", () => {
    const f = setup(); const m = f.authorize();
    const id = live(f, m); f.hp.stopped(id, proof("rebooted"));
    const done = f.hp.settleStopped(m.mission_id, m.revision, { host_processes: f.hp.stoppedProofs(m.mission_id) },
      { to: "awaiting_decision", event: { kind: "workspace_recovered", payload: {} } });
    expect(done).toMatchObject({ state: "awaiting_decision", stop_obligation: 0 });
    expect(f.store.events(m.mission_id).map(e => e.kind)).toEqual(expect.arrayContaining(["host_process_settled", "workspace_recovered"]));
  });

  it("refuses wrong revision and an executing Mission whose obligation is still set", () => {
    const f = setup(); const m = ready(f);
    const exec = step(f, m, "executing", { expected_head: HEAD });
    expect(() => f.hp.settleStopped(m.mission_id, exec.revision, {}, exit)).toThrow("settle_requires_stop_unknown");
    const m2 = ready(f);
    const su = step(f, m2, "stop_unknown");
    const mid = m2.mission_id; void mid;
    expect(() => f.hp.settleStopped(m2.mission_id, su.revision + 5, {}, exit)).toThrow("version_conflict");
    expect(() => f.hp.settleStopped(m2.mission_id, 0, {}, exit)).toThrow("invalid_revision");
  });

  it("crash injection between the steps rolls every step back (also after reopening the file)", () => {
    for (const [name, trigger] of [
      ["after the obligation clear, before the exit", "CREATE TRIGGER inject BEFORE UPDATE OF state ON engineering_contained_missions WHEN NEW.state='needs_reconciliation' BEGIN SELECT RAISE(ABORT,'injected_crash'); END"],
      ["before the obligation clear", "CREATE TRIGGER inject BEFORE INSERT ON engineering_contained_events WHEN NEW.kind='executor_stopped' BEGIN SELECT RAISE(ABORT,'injected_crash'); END"],
      ["on the exit event", "CREATE TRIGGER inject BEFORE INSERT ON engineering_contained_events WHEN NEW.kind='host_process_recovered' BEGIN SELECT RAISE(ABORT,'injected_crash'); END"],
    ] as const) {
      const f = setup(); const m = ready(f);
      const id = live(f, m);
      const su = step(f, m, "stop_unknown");
      f.hp.stopped(id, { proof: "never_spawned", detail: {} });
      const eventsBefore = f.store.events(m.mission_id).length;
      f.db.exec(trigger);
      expect(() => f.hp.settleStopped(m.mission_id, su.revision, {}, exit), name).toThrow("injected_crash");
      expect(f.db.inTransaction, name).toBe(false);
      const other = new Database(f.path, { readonly: true });
      expect(other.prepare("SELECT state,stop_obligation,revision FROM engineering_contained_missions WHERE mission_id=?").get(m.mission_id), name)
        .toEqual({ state: "stop_unknown", stop_obligation: 1, revision: su.revision });
      expect((other.prepare("SELECT COUNT(*) n FROM engineering_contained_events WHERE mission_id=?").get(m.mission_id) as { n: number }).n, name).toBe(eventsBefore);
      other.close();
      f.db.exec("DROP TRIGGER inject");
      expect(f.hp.settleStopped(m.mission_id, su.revision, {}, exit).state, name).toBe("needs_reconciliation");
    }
  });

  it("a process death mid-transaction leaves the committed state intact", () => {
    const f = setup(); const m = ready(f);
    const id = live(f, m); const su = step(f, m, "stop_unknown");
    f.hp.stopped(id, { proof: "never_spawned", detail: {} });
    // Simulate the crash: start the same two writes, then drop the connection without COMMIT.
    f.db.exec("BEGIN IMMEDIATE");
    f.store.recordStopEvidence(m.mission_id, su.revision, {}, 9000);
    const probe = new Database(f.path, { readonly: true });
    expect(probe.prepare("SELECT stop_obligation FROM engineering_contained_missions WHERE mission_id=?").get(m.mission_id)).toEqual({ stop_obligation: 1 });
    probe.close();
    f.db.exec("ROLLBACK");
    expect(f.store.get(m.mission_id).stop_obligation).toBe(1);
  });
});

describe("property: random journal sequences never let an unproven record coexist with a released claim or a cancelled/pr_opened Mission", () => {
  type Op =
    | { t: "launch"; m: number; kind: number; remote: number }
    | { t: "register" | "release" | "stop" | "failrelease"; i: number; p: number }
    | { t: "mission"; m: number; to: number }
    | { t: "evidence" | "claim" | "settle"; m: number; to: number };
  const TO: ContainedMissionState[] = ["workspace_ready", "executing", "cancel_requested", "cancelled", "stop_unknown", "awaiting_decision", "abandoned", "needs_reconciliation", "failed", "candidate_ready"];
  const KINDS = ["git_push", "gh_pr_create", "git_update_ref", "git_worktree_add", "git_index_write"] as const;
  const op = fc.oneof(
    fc.record({ t: fc.constant("launch" as const), m: fc.nat(2), kind: fc.nat(4), remote: fc.nat(1) }),
    fc.record({ t: fc.constantFrom("register" as const, "release" as const, "stop" as const, "failrelease" as const), i: fc.nat(20), p: fc.nat(6) }),
    fc.record({ t: fc.constant("mission" as const), m: fc.nat(2), to: fc.nat(TO.length - 1) }),
    fc.record({ t: fc.constantFrom("evidence" as const, "claim" as const, "settle" as const), m: fc.nat(2), to: fc.nat(TO.length - 1) }),
  );

  it("holds over 60 random sequences", () => {
    fc.assert(fc.property(fc.array(op, { minLength: 1, maxLength: 40 }), (ops: Op[]) => {
      const f = setup();
      try {
        const missions = [ready(f), ready(f), ready(f)].map(m => m.mission_id);
        const created: string[] = []; let n = 0;
        const attempt = (fn: () => unknown) => { try { fn(); } catch { /* refused operations are the point */ } };
        const invariant = () => {
          const bad = f.db.prepare(`SELECT h.op_id FROM engineering_host_processes h
            JOIN engineering_contained_missions m ON m.mission_id=h.mission_id
            JOIN engineering_workspace_claims c ON c.mission_id=h.mission_id
            WHERE h.state<>'stopped' AND (c.state='released' OR m.state IN ('cancelled','pr_opened'))`).all();
          expect(bad).toEqual([]);
          const dup = f.db.prepare("SELECT mission_id FROM engineering_host_processes WHERE state<>'stopped' GROUP BY mission_id HAVING COUNT(*)>1").all();
          expect(dup).toEqual([]);
          const dupRemote = f.db.prepare("SELECT remote_target FROM engineering_host_processes WHERE state<>'stopped' AND remote_target IS NOT NULL GROUP BY remote_target HAVING COUNT(*)>1").all();
          expect(dupRemote).toEqual([]);
          // a never-released record carries no release time, and a released one always does
          expect(f.db.prepare("SELECT op_id FROM engineering_host_processes WHERE (state='released' AND released_at IS NULL) OR (state IN ('launching','registered') AND released_at IS NOT NULL)").all()).toEqual([]);
        };
        for (const o of ops) {
          const mid = missions[("m" in o ? o.m : 0) % missions.length]!;
          switch (o.t) {
            case "launch": {
              const kind = KINDS[o.kind]!;
              const i = f.input(f.store.get(mid), { kind, ...(kind === "git_push" || kind === "gh_pr_create" ? { remote_target: `o/r#refs/heads/b${o.remote}` } : {}) });
              attempt(() => { f.hp.launching(i); created.push(i.op_id); n++; });
              break;
            }
            case "register": case "release": case "stop": case "failrelease": {
              const id = created[o.i % Math.max(created.length, 1)];
              if (!id) break;
              if (o.t === "register") attempt(() => f.hp.registered(id, { pid: 100 + n, pgid: 100 + n, leader_start: null }));
              else if (o.t === "release") attempt(() => f.hp.release(id, () => undefined));
              else if (o.t === "failrelease") attempt(() => f.hp.release(id, () => { throw Error("fence"); }));
              else attempt(() => f.hp.stopped(id, proof(HOST_PROCESS_STOP_PROOFS[o.p % HOST_PROCESS_STOP_PROOFS.length]!)));
              break;
            }
            case "mission": {
              const to = TO[o.to]!;
              attempt(() => { const cur = f.store.get(mid); f.store.transition(mid, { if_revision: cur.revision, to, event: { kind: "p", payload: {} }, ...(to === "executing" ? { expected_head: HEAD } : {}), ...(to === "candidate_ready" ? { candidate } : {}) }, 6000); });
              break;
            }
            case "evidence": attempt(() => f.store.recordStopEvidence(mid, f.store.get(mid).revision, {}, 6000)); break;
            case "claim": attempt(() => f.store.releaseClaim(mid, "r", 6000)); break;
            case "settle": attempt(() => f.hp.settleStopped(mid, f.store.get(mid).revision, {}, { to: TO[o.to]!, event: { kind: "p", payload: {} } })); break;
          }
          invariant();
        }
      } finally {
        cleanup.splice(0).forEach(fn => { fn(); });
      }
    }), { numRuns: 60 });
  }, 180_000);
});
