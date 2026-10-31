import { realpathSync, rmSync } from "node:fs";
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
function toVerified(f: Fixture): ContainedMission {
  let m = f.authorize();
  m = step(f, m, "workspace_ready"); m = step(f, m, "executing", { expected_head: HEAD });
  m = step(f, m, "candidate_ready", { candidate }); m = step(f, m, "verifying");
  return step(f, m, "verified");
}

it("records the spec digest, the claim and an append-only event trail", () => {
  const f = setup(); const m = f.authorize();
  expect(m).toMatchObject({ state: "authorized", revision: 1, verify_attempts: 0, repair_cycles: 0, stop_obligation: 0 });
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
  expect(() => f.db.prepare("UPDATE engineering_contained_missions SET state='delivering',revision=revision+1").run()).toThrow("contained_transition_denied");
  expect(() => f.db.prepare("UPDATE engineering_contained_missions SET state='verified',revision=revision+1").run()).toThrow("contained_transition_denied");
});

it("fixes a candidate on candidate_ready, keeps it on the verify path and drops it on re-execution", () => {
  const f = setup(); let m = f.authorize();
  m = step(f, m, "workspace_ready"); m = step(f, m, "executing", { expected_head: HEAD });
  expect(m.stop_obligation).toBe(1);
  expect(() => step(f, m, "candidate_ready")).toThrow("candidate_required");
  m = step(f, m, "candidate_ready", { candidate });
  expect(() => step(f, m, "verifying", { candidate })).toThrow("candidate_unexpected");
  m = step(f, m, "verifying"); expect(m.verify_attempts).toBe(1);
  m = step(f, m, "verify_failed"); expect(m.candidate_head).toBe(HEAD);
  m = step(f, m, "executing"); expect(m).toMatchObject({ repair_cycles: 1, candidate_head: null });
});

it("caps automatic repair cycles by the spec and counts each extra grant", () => {
  const f = setup(); let m = f.authorize(undefined, { spec: { max_repair_cycles: 1 } });
  m = step(f, m, "workspace_ready"); m = step(f, m, "executing");
  const fail = (x: ContainedMission) => step(f, step(f, step(f, x, "candidate_ready", { candidate }), "verifying"), "verify_failed");
  m = fail(m); m = step(f, m, "executing"); expect(m.repair_cycles).toBe(1);
  m = fail(m); expect(() => step(f, m, "executing")).toThrow("repair_cycles_exhausted");
  m = step(f, m, "awaiting_decision"); m = step(f, m, "executing");
  expect(m.repair_cycles).toBe(2);
});

it("delivers only through revalidating and never returns a decision straight to verified or delivering", () => {
  const f = setup(); let m = toVerified(f);
  expect(() => step(f, m, "delivering")).toThrow("transition_denied");
  m = step(f, m, "awaiting_decision"); expect(m.candidate_head).toBe(HEAD);
  expect(() => step(f, m, "verified")).toThrow("transition_denied");
  expect(() => step(f, m, "delivering")).toThrow("transition_denied");
  m = step(f, m, "revalidating"); m = step(f, m, "delivering"); m = step(f, m, "pr_opened");
  expect(() => step(f, m, "abandoned")).toThrow("mission_terminal");
});

it("requires stop evidence before cancelling and keeps abandoned unknown-stop Missions outstanding", () => {
  const f = setup(); let m = f.authorize();
  m = step(f, m, "workspace_ready"); m = step(f, m, "executing");
  m = step(f, m, "cancel_requested");
  expect(() => step(f, m, "cancelled")).toThrow("stop_evidence_required");
  m = step(f, m, "stop_unknown"); m = step(f, m, "abandoned");
  expect(m).toMatchObject({ state: "abandoned", stop_obligation: 1 });
  expect(f.store.listOutstanding().map(r => r.mission_id)).toEqual([m.mission_id]);
  expect(() => f.store.releaseClaim(m.mission_id, "done", 3000)).toThrow("claim_release_denied");
  expect(containedUpgradeHolds(f.db)).toBe(1);
  m = f.store.recordStopEvidence(m.mission_id, m.revision, { stop_proof: "group_empty+sandbox_inherited" }, 3001);
  expect(m.stop_obligation).toBe(0);
  expect(containedUpgradeHolds(f.db)).toBe(1);
  f.store.releaseClaim(m.mission_id, "abandoned", 3002);
  expect(f.store.listOutstanding()).toEqual([]);
  expect(containedUpgradeHolds(f.db)).toBe(0);
});

it("a superseding Mission inherits repair cycles and takes over a released worktree", () => {
  const f = setup(); let m = f.authorize();
  m = step(f, m, "workspace_ready"); m = step(f, m, "executing");
  m = step(f, step(f, step(f, m, "candidate_ready", { candidate }), "verifying"), "verify_failed");
  m = step(f, m, "executing");
  expect(() => f.authorize({ repo_identity: "repo", branch: "osstack/m/2", worktree_identity: "wt9" }, { supersedes: m.mission_id })).toThrow("supersedes_active_mission");
  m = f.store.recordStopEvidence(m.mission_id, m.revision, {}, 2500);
  m = step(f, m, "awaiting_decision"); m = step(f, m, "abandoned");
  const next = f.authorize(undefined, { supersedes: m.mission_id });
  expect(next).toMatchObject({ repair_cycles: 1, supersedes: m.mission_id });
  expect(f.store.claim(m.mission_id)).toMatchObject({ state: "released", release_reason: "superseded" });
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
