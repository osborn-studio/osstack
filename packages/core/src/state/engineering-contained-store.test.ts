import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createScratchDirSync } from "../scratch.js";
import { openDb } from "./db.js";
import { AttentionStore } from "./attention-store.js";
import { ContainedMissionStore, containedUpgradeHolds, type ContainedMission, type ContainedMissionState } from "./engineering-contained-store.js";
import type { EngineeringPrincipal } from "./engineering-store.js";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => { fn(); }); });
const HEAD = "a".repeat(40); const TREE = "b".repeat(40); const DIFF = "c".repeat(64);
const candidate = { head: HEAD, tree: TREE, diff_digest: DIFF };

function setup() {
  const root = realpathSync(createScratchDirSync("tests", "contained"));
  const path = join(root, "state.db"); const db = openDb({ path }); db.pragma("synchronous=FULL");
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const attention = new AttentionStore(db, path); const owner = attention.claimOwner("owner");
  const scope = attention.registerScope(owner, "t", root);
  const principal: EngineeringPrincipal = { principal_id: "human", client_session_id: "cli", read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [scope.scope_id], operator_scopes: [] };
  const store = new ContainedMissionStore(attention, owner);
  const authorize = (claim = { repo_identity: "repo", branch: "osstack/m/1", worktree_identity: "wt1" }, extra: { supersedes?: string; spec?: Record<string, unknown> } = {}) =>
    store.authorize(principal, { scope_id: scope.scope_id, spec: extra.spec ?? { goal: "fix", max_repair_cycles: 2 }, claim, ...(extra.supersedes ? { supersedes: extra.supersedes } : {}) }, 1000);
  return { db, path, root, attention, owner, scope, principal, store, authorize };
}
type Fixture = ReturnType<typeof setup>;
function step(f: Fixture, m: ContainedMission, to: ContainedMissionState, extra: { candidate?: typeof candidate; expected_head?: string } = {}, now = 2000): ContainedMission {
  return f.store.transition(m.mission_id, { if_revision: m.revision, to, event: { kind: `to_${to}`, payload: {} }, ...extra }, now);
}
const stopped = (f: Fixture, m: ContainedMission) => f.store.recordStopEvidence(m.mission_id, m.revision, { stop_proof: "group_empty+sandbox_inherited" }, 2100);
/** executing → (stop evidence) → candidate_ready, the only way a host may apply a patch. */
const apply = (f: Fixture, m: ContainedMission) => step(f, stopped(f, m), "candidate_ready", { candidate });
/** verifying → (container stop evidence) → result. */
const verifyDone = (f: Fixture, m: ContainedMission) => stopped(f, step(f, m, "verifying"));
const fail = (f: Fixture, m: ContainedMission) => step(f, verifyDone(f, apply(f, m)), "verify_failed");
function executing(f: Fixture, spec?: Record<string, unknown>): ContainedMission {
  const m = step(f, f.authorize(undefined, spec ? { spec } : {}), "workspace_ready");
  return step(f, m, "executing", { expected_head: HEAD });
}
function toVerified(f: Fixture): ContainedMission {
  return step(f, verifyDone(f, apply(f, executing(f))), "verified");
}

it("records the spec digest, the claim and an append-only event trail", () => {
  const f = setup(); const m = f.authorize();
  expect(m).toMatchObject({ state: "authorized", revision: 1, verify_attempts: 0, repair_cycles: 0, stop_obligation: 0, candidate_verified: 0, repair_pending: 0 });
  expect(m.spec_digest).toMatch(/^[0-9a-f]{64}$/);
  expect(f.store.claim(m.mission_id)).toMatchObject({ state: "active", branch: "osstack/m/1" });
  expect(f.store.events(m.mission_id).map(e => e.kind)).toEqual(["contained_authorized", "workspace_claimed"]);
  expect(() => f.db.prepare("UPDATE engineering_contained_events SET kind='x'").run()).toThrow("contained_event_immutable");
  expect(() => f.db.prepare("DELETE FROM engineering_contained_events").run()).toThrow("contained_event_immutable");
  expect(() => f.db.prepare("UPDATE engineering_contained_missions SET spec_json='{}',revision=revision+1").run()).toThrow("contained_mission_immutable");
  expect(() => f.db.prepare("UPDATE engineering_contained_missions SET updated_at=5").run()).toThrow("contained_mission_immutable");
});

it("refuses a second active claim on the same branch or worktree", () => {
  const f = setup(); f.authorize();
  expect(() => f.authorize({ repo_identity: "repo", branch: "osstack/m/1", worktree_identity: "wt2" })).toThrow("workspace_claimed");
  expect(() => f.authorize({ repo_identity: "repo", branch: "osstack/m/2", worktree_identity: "wt1" })).toThrow("workspace_claimed");
  expect(f.authorize({ repo_identity: "other", branch: "osstack/m/1", worktree_identity: "wt3" }).state).toBe("authorized");
});

it("enforces permission, revision and the state machine", () => {
  const f = setup();
  expect(() => f.store.authorize({ ...f.principal, write_scopes: [] }, { scope_id: f.scope.scope_id, spec: {}, claim: { repo_identity: "r", branch: "b", worktree_identity: "w" } }, 1)).toThrow("permission_denied");
  const m = f.authorize();
  expect(() => f.store.transition(m.mission_id, { if_revision: 9, to: "workspace_ready", event: { kind: "x", payload: {} } }, 2)).toThrow("version_conflict");
  expect(() => step(f, m, "executing")).toThrow("transition_denied");
  expect(() => step(f, m, "verified")).toThrow("transition_denied");
  expect(() => f.db.prepare("UPDATE engineering_contained_missions SET state='delivering',revision=revision+1").run()).toThrow();
  expect(() => f.db.prepare("UPDATE engineering_contained_missions SET state='verified',revision=revision+1").run()).toThrow("contained_transition_denied");
});

it("fixes a candidate only after stop evidence, keeps it on the verify path and drops it on re-execution", () => {
  const f = setup(); let m = executing(f);
  expect(m.stop_obligation).toBe(1);
  expect(() => step(f, m, "candidate_ready", { candidate })).toThrow("stop_evidence_required");
  expect(() => f.db.prepare("UPDATE engineering_contained_missions SET state='candidate_ready',candidate_head=?,candidate_tree=?,candidate_diff_digest=?,revision=revision+1").run(HEAD, TREE, DIFF)).toThrow("contained_transition_denied");
  m = stopped(f, m);
  expect(() => step(f, m, "candidate_ready")).toThrow("candidate_required");
  m = step(f, m, "candidate_ready", { candidate });
  expect(() => step(f, m, "verifying", { candidate })).toThrow("candidate_unexpected");
  m = step(f, m, "verifying"); expect(m).toMatchObject({ verify_attempts: 1, stop_obligation: 1 });
  expect(() => step(f, m, "verify_failed")).toThrow("stop_evidence_required");
  m = step(f, stopped(f, m), "verify_failed"); expect(m).toMatchObject({ candidate_head: HEAD, candidate_verified: 0, repair_pending: 1 });
  m = step(f, m, "executing"); expect(m).toMatchObject({ repair_cycles: 1, repair_pending: 0, candidate_head: null });
});

it("never resumes execution while a previous executor may still run", () => {
  const f = setup(); let m = executing(f);
  m = step(f, m, "stop_unknown"); m = step(f, m, "needs_reconciliation");
  expect(() => step(f, m, "executing")).toThrow("stop_evidence_required");
  expect(() => step(f, m, "candidate_ready", { candidate })).toThrow("stop_evidence_required");
  m = step(f, m, "awaiting_decision");
  expect(() => step(f, m, "executing")).toThrow("stop_evidence_required");
  m = stopped(f, m); m = step(f, m, "executing");
  expect(m.stop_obligation).toBe(1);
});

it("caps repair cycles by the spec on every route, including reconciliation, and counts each extra grant", () => {
  const f = setup(); let m = executing(f, { max_repair_cycles: 1 });
  m = fail(f, m); m = step(f, m, "executing"); expect(m.repair_cycles).toBe(1);
  m = fail(f, m); expect(() => step(f, m, "executing")).toThrow("repair_cycles_exhausted");
  m = step(f, m, "needs_reconciliation");
  expect(() => step(f, m, "executing")).toThrow("repair_cycles_exhausted");
  m = step(f, m, "awaiting_decision"); m = step(f, m, "executing");
  expect(m).toMatchObject({ repair_cycles: 2, repair_pending: 0 });
  const zero = setup(); let z = executing(zero, { max_repair_cycles: 0 });
  z = fail(zero, z); z = step(zero, z, "needs_reconciliation");
  expect(() => step(zero, z, "executing")).toThrow("repair_cycles_exhausted");
});

it("delivers only a verified candidate through revalidating", () => {
  const f = setup(); let m = toVerified(f);
  expect(m.candidate_verified).toBe(1);
  expect(() => step(f, m, "delivering")).toThrow("transition_denied");
  m = step(f, m, "awaiting_decision"); expect(m).toMatchObject({ candidate_head: HEAD, candidate_verified: 1 });
  expect(() => step(f, m, "verified")).toThrow("transition_denied");
  expect(() => step(f, m, "delivering")).toThrow("transition_denied");
  m = step(f, m, "revalidating"); m = step(f, m, "delivering"); m = step(f, m, "pr_opened");
  expect(() => step(f, m, "abandoned")).toThrow("mission_terminal");
});

it("refuses to revalidate an unverified or failed candidate", () => {
  const f = setup(); let m = apply(f, executing(f));
  m = step(f, m, "awaiting_decision"); expect(m.candidate_verified).toBe(0);
  expect(() => step(f, m, "revalidating")).toThrow("verification_required");
  const g = setup(); let n = fail(g, executing(g));
  n = step(g, n, "awaiting_decision");
  expect(() => step(g, n, "revalidating")).toThrow("verification_required");
  expect(() => g.db.prepare("UPDATE engineering_contained_missions SET state='revalidating',revision=revision+1").run()).toThrow();
});

it("requires stop evidence before cancelling and keeps abandoned unknown-stop Missions outstanding", () => {
  const f = setup(); let m = executing(f);
  m = step(f, m, "cancel_requested");
  expect(() => step(f, m, "cancelled")).toThrow("stop_evidence_required");
  m = step(f, m, "stop_unknown"); m = step(f, m, "abandoned");
  expect(m).toMatchObject({ state: "abandoned", stop_obligation: 1 });
  expect(f.store.listOutstanding().map(r => r.mission_id)).toEqual([m.mission_id]);
  expect(() => f.store.releaseClaim(m.mission_id, "done", 3000)).toThrow("claim_release_denied");
  expect(containedUpgradeHolds(f.db)).toBe(1);
  m = stopped(f, m);
  expect(m.stop_obligation).toBe(0);
  expect(containedUpgradeHolds(f.db)).toBe(1);
  f.store.releaseClaim(m.mission_id, "abandoned", 3002);
  expect(f.store.listOutstanding()).toEqual([]);
  expect(containedUpgradeHolds(f.db)).toBe(0);
});

it("a superseding Mission inherits repair cycles and takes over a released worktree in the same scope only", () => {
  const f = setup(); let m = fail(f, executing(f));
  m = step(f, m, "executing");
  expect(() => f.authorize({ repo_identity: "repo", branch: "osstack/m/2", worktree_identity: "wt9" }, { supersedes: m.mission_id })).toThrow("supersedes_active_mission");
  m = stopped(f, m);
  m = step(f, m, "awaiting_decision"); m = step(f, m, "abandoned");
  mkdirSync(join(f.root, "other")); const other = f.attention.registerScope(f.owner, "t", join(f.root, "other"));
  expect(() => f.store.authorize({ ...f.principal, write_scopes: [other.scope_id] }, { scope_id: other.scope_id, spec: {}, supersedes: m.mission_id, claim: { repo_identity: "x", branch: "y", worktree_identity: "z" } }, 1000)).toThrow("permission_denied");
  expect(f.store.claim(m.mission_id).state).toBe("active");
  const next = f.authorize(undefined, { supersedes: m.mission_id });
  expect(next).toMatchObject({ repair_cycles: 1, supersedes: m.mission_id });
  expect(f.store.claim(m.mission_id)).toMatchObject({ state: "released", release_reason: "superseded" });
});

it("a successor of failed work still consumes the repair budget", () => {
  const f = setup(); let m = fail(f, executing(f, { max_repair_cycles: 0 }));
  m = step(f, m, "awaiting_decision"); m = step(f, m, "abandoned");
  let next = f.authorize(undefined, { supersedes: m.mission_id, spec: { max_repair_cycles: 0 } });
  expect(next).toMatchObject({ repair_cycles: 0, repair_pending: 1 });
  next = step(f, next, "workspace_ready");
  expect(() => step(f, next, "executing")).toThrow("repair_cycles_exhausted");
});

it("records the actual transition even when the payload names other states", () => {
  const f = setup(); const m = f.authorize();
  f.store.transition(m.mission_id, { if_revision: m.revision, to: "awaiting_decision", event: { kind: "halt", payload: { from: "x", to: "pr_opened", reason: "r" } } }, 2000);
  const last = f.store.events(m.mission_id).at(-1)!;
  expect(JSON.parse(last.payload_json)).toEqual({ reason: "r", from: "authorized", to: "awaiting_decision" });
});

it("upgrades a 49 home to 50 additively and reopens cleanly", () => {
  const root = realpathSync(createScratchDirSync("tests", "contained-upgrade"));
  const path = join(root, "state.db");
  cleanup.push(() => { rmSync(root, { recursive: true, force: true }); });
  const old = new Database(path); old.pragma("foreign_keys = ON");
  for (const m of MIGRATIONS.filter(x => x.id <= 49)) { old.exec("BEGIN"); old.exec(m.sql); old.pragma(`user_version = ${m.id}`); old.exec("COMMIT"); }
  const before = old.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  old.close();
  const db = openDb({ path });
  expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  expect(CURRENT_SCHEMA_VERSION).toBe(50);
  const after = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
  expect(after.filter(t => !(before as Array<{ name: string }>).some(b => b.name === t.name)).map(t => t.name))
    .toEqual(["engineering_contained_events", "engineering_contained_missions", "engineering_workspace_claims"]);
  expect(db.pragma("foreign_key_check")).toEqual([]);
  db.close();
  const reopened = openDb({ path }); expect(reopened.pragma("user_version", { simple: true })).toBe(50); reopened.close();
});
