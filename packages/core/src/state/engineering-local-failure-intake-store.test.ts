import { createHash } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { createScratchDirSync } from "../scratch.js";
import { AttentionStore } from "./attention-store.js";
import { openDb } from "./db.js";
import { ContainedMissionStore } from "./engineering-contained-store.js";
import { RevisionChainStore } from "./engineering-revision-chain-store.js";
import { ENGINEERING_LOCAL_FAILURE_INTAKE_DDL } from "./engineering-local-failure-intake-ddl.js";
import { LocalFailureIntakeStore, type NewLocalFailureIntake, type StoppedDiagnostic } from "./engineering-local-failure-intake-store.js";

const H = "a".repeat(40), B = "b".repeat(40), P = "c".repeat(64), E = "d".repeat(64);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => { fn(); }); });

function setup() {
  const root = realpathSync(createScratchDirSync("tests", "local-intake"));
  const path = join(root, "state.db"), db = openDb({ path });
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.pragma("synchronous=FULL");
  db.exec(ENGINEERING_LOCAL_FAILURE_INTAKE_DDL);
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const attention = new AttentionStore(db, path), owner = attention.claimOwner("owner");
  const scope = attention.registerScope(owner, "t", root);
  const principal = { principal_id: "human", client_session_id: "cli", read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [scope.scope_id], operator_scopes: [] };
  const mission = new ContainedMissionStore(attention, owner).authorize(principal, {
    scope_id: scope.scope_id, spec: { goal: "synthetic diagnostic fixture" },
    claim: { repo_identity: "fixture", branch: "fixture", worktree_identity: "fixture" },
  }, 1000);
  // Structural fixture only. It has no signature and never authorizes a process.
  const grant = { version: 2, grant_id: "rg_fixture", rounds: 2 as const, expires_at: 10000,
    local_failure: { enabled: true, profile_id: "fixture", profile_digest: P,
      trusted_source: { artifact_digest: E }, diagnostic_timeout_seconds: 20, max_diagnostics_per_head: 1 },
    budget: { max_container_seconds: 100 } };
  const chains = new RevisionChainStore(attention, owner);
  const chain = chains.createLiveChain({ root_mission_id: mission.mission_id, repository: "fixture/repo", pr_number: 1,
    branch: "fixture", base_ref: "main", published_head: H, published_base: B, trace_id: "fixture", grant }, 1000);
  const store = new LocalFailureIntakeStore(attention, owner, () => 1000);
  const input: NewLocalFailureIntake = { intake_id: "lf_first", chain_id: chain.chain_id, chain_revision: chain.revision,
    root_mission_id: mission.mission_id, repository: "fixture/repo", pr_number: 1, branch: "fixture", head_sha: H,
    tree_sha: "e".repeat(40), base_ref: "main", base_sha: B, profile_id: "fixture", profile_digest: P,
    trusted_source_digest: E, grant_id: grant.grant_id, grant_digest: sha(chain.grant_json),
    invocation_id: "diagnostic-fixture", journal_ref: "fixture-journal", container_cap_seconds: 20,
    ci_hint_json: '{"app_id":1,"check_run_id":2,"name":"fixture"}' };
  const second = () => {
    const other = new Database(path); other.pragma("foreign_keys=ON"); other.pragma("synchronous=FULL"); other.pragma("busy_timeout=0");
    cleanup.push(() => { other.close(); });
    return new LocalFailureIntakeStore(new AttentionStore(other, path), owner, () => 1000);
  };
  const stopped: StoppedDiagnostic = { outcome: "reproducible_failure", container_used_seconds: 7,
    receipt_json: '{"fixture":"host receipt, not repair authority"}', evidence_digest: E,
    proof_ref: "fixture-stop", proof_digest: E };
  return { db, path, attention, owner, chain, chains, store, input, second, stopped };
}

it("reserves an immutable binding and exposes full cap and active exclusion", () => {
  const f = setup(), row = f.store.reserve(f.input);
  expect(row).toMatchObject({ ...f.input, state: "reserved", revision: 1, stop_obligation: 1, container_used_seconds: null });
  expect(f.store.containerDebit(f.chain.chain_id)).toBe(20);
  expect(f.store.activeExclusions(f.chain.chain_id).map(r => r.intake_id)).toEqual(["lf_first"]);
  expect(f.db.pragma("foreign_key_check")).toEqual([]);
});

it("serializes duplicate and competing admissions across separate SQLite handles", () => {
  const f = setup(), other = f.second();
  f.db.exec("BEGIN IMMEDIATE");
  expect(() => other.reserve(f.input)).toThrow(/locked/);
  f.db.exec("ROLLBACK");
  f.store.reserve(f.input);
  expect(() => other.reserve(f.input)).toThrow(/intake_reused/);
  expect(() => other.reserve({ ...f.input, intake_id: "lf_other", invocation_id: "other", profile_digest: P })).toThrow();
  expect(other.containerDebit(f.chain.chain_id)).toBe(20);
});

it("retains unknown-stop cost and exclusion across restart and forbids blind relaunch", () => {
  const f = setup(); f.store.reserve(f.input);
  const running = f.store.start("lf_first", 1);
  const unknown = f.store.markStopUnknown("lf_first", running.revision, "stop_unproven");
  expect(unknown).toMatchObject({ state: "stop_unknown", stop_obligation: 1 });
  const other = f.second();
  expect(other.containerDebit(f.chain.chain_id)).toBe(20);
  expect(other.activeExclusions(f.chain.chain_id)).toHaveLength(1);
  expect(() => other.start("lf_first", unknown.revision)).toThrow(/state_denied/);
  expect(() => other.reserve({ ...f.input, intake_id: "lf_retry", invocation_id: "retry" })).toThrow();
  const done = other.settleStopped("lf_first", unknown.revision, f.stopped);
  expect(done).toMatchObject({ state: "stopped", outcome: "reproducible_failure", stop_obligation: 0 });
  expect(other.containerDebit(f.chain.chain_id)).toBe(7);
  expect(other.activeExclusions(f.chain.chain_id)).toEqual([]);
  expect(() => other.reserve({ ...f.input, intake_id: "lf_retry", invocation_id: "retry" })).toThrow(/intake_reused/);
});

it("rolls back caller transactions and fences stale revisions and owners", () => {
  const f = setup();
  expect(() => f.db.transaction(() => { f.store.reserve(f.input); throw Error("rollback"); }).immediate()).toThrow("rollback");
  expect(f.store.containerDebit(f.chain.chain_id)).toBe(0);
  f.store.reserve(f.input);
  expect(() => f.store.start("lf_first", 9)).toThrow("version_conflict");
  // A launch-ready transition must commit independently of caller rollback.
  expect(() => f.db.transaction(() => f.store.start("lf_first", 1))()).toThrow("intake_nested_launch");
  const replacement = f.attention.claimOwner("replacement");
  expect(() => f.store.start("lf_first", 1)).toThrow("stale_owner");
  const recovered = new LocalFailureIntakeStore(f.attention, replacement, () => 1000);
  expect(() => recovered.start("lf_first", 1)).toThrow("intake_owner_changed");
  expect(recovered.markStopUnknown("lf_first", 1, "owner_replaced").state).toBe("stop_unknown");
  expect(recovered.containerDebit(f.chain.chain_id)).toBe(20);
});

it("rejects stale chain/grant/profile/root binding without inserting a debit", () => {
  const f = setup();
  for (const patch of [{ chain_revision: 2 }, { root_mission_id: "wrong" }, { grant_digest: E },
    { profile_digest: E }, { trusted_source_digest: P }, { head_sha: B }, { base_sha: H }, { grant_id: "wrong" },
    { container_cap_seconds: 21 }]) {
    expect(() => f.store.reserve({ ...f.input, ...patch })).toThrow();
    expect(f.store.containerDebit(f.chain.chain_id)).toBe(0);
  }
});

it("rejects negative usage, over-cap usage and missing stop evidence without refund", () => {
  const f = setup(); f.store.reserve(f.input); f.store.start("lf_first", 1);
  for (const patch of [{ container_used_seconds: -1 }, { container_used_seconds: 21 },
    { container_used_seconds: 0.5 }, { proof_ref: "" }, { proof_digest: "" }, { receipt_json: "{}", evidence_digest: "" }]) {
    expect(() => f.store.settleStopped("lf_first", 2, { ...f.stopped, ...patch })).toThrow();
    expect(f.store.containerDebit(f.chain.chain_id)).toBe(20);
    expect(f.store.get("lf_first").revision).toBe(2);
  }
});

it("freezes bindings and terminal receipt/evidence against raw SQL and REPLACE tampering", () => {
  const f = setup(); f.store.reserve(f.input);
  for (const [column, value] of Object.entries({ chain_id: "rc_other", chain_revision: 2, root_mission_id: "cm_other",
    repository: "other/repo", pr_number: 2, branch: "other", head_sha: B, tree_sha: B, base_ref: "other", base_sha: H,
    profile_id: "other", profile_digest: E, trusted_source_digest: P, grant_id: "other", grant_json: "{}", grant_digest: E,
    ci_hint_json: "{}", invocation_id: "other", journal_ref: "other", container_cap_seconds: 10,
    owner_home: "other", owner_instance: "other", owner_generation: 2, created_at: 999 })) {
    expect(() => f.db.prepare(`UPDATE engineering_local_failure_intakes SET ${column}=?,revision=revision+1 WHERE intake_id='lf_first'`).run(value)).toThrow();
  }
  f.store.start("lf_first", 1);
  const done = f.store.settleStopped("lf_first", 2, f.stopped);
  expect(done.receipt_digest).toBe(sha(f.stopped.receipt_json));
  for (const [column, value] of Object.entries({ receipt_json: "{}", receipt_digest: P, evidence_digest: P,
    container_used_seconds: 0, state: "running", proof_ref: "other", proof_digest: P, reason: "other" })) {
    expect(() => f.db.prepare(`UPDATE engineering_local_failure_intakes SET ${column}=?,revision=revision+1 WHERE intake_id='lf_first'`).run(value)).toThrow();
  }
  expect(() => f.db.exec("DELETE FROM engineering_local_failure_intakes")).toThrow("intake_immutable");
  expect(() => f.db.exec("INSERT OR REPLACE INTO engineering_local_failure_intakes SELECT * FROM engineering_local_failure_intakes")).toThrow();
  expect(f.store.get("lf_first")).toEqual(done);
});

it("releases only a never-started reservation without a runner receipt and never reruns it", () => {
  const f = setup(); f.store.reserve(f.input);
  expect(() => f.store.settleStopped("lf_first", 1, f.stopped)).toThrow();
  const unknown = f.store.markStopUnknown("lf_first", 1, "restart_before_launch");
  expect(f.store.settleNotStarted("lf_first", unknown.revision)).toMatchObject({ state: "stopped", outcome: "not_started", receipt_json: null });
  expect(f.store.containerDebit(f.chain.chain_id)).toBe(0);
  expect(() => f.store.reserve({ ...f.input, intake_id: "lf_again", invocation_id: "again" })).toThrow("intake_reused");
});

it("cannot erase a launched obligation as never-started or roll back a partial settlement", () => {
  const f = setup(); f.store.reserve(f.input); f.store.start("lf_first", 1);
  expect(() => f.store.settleNotStarted("lf_first", 2)).toThrow();
  f.db.exec(`CREATE TRIGGER fixture_abort_settlement AFTER UPDATE ON engineering_local_failure_intakes
    WHEN NEW.state='stopped' BEGIN SELECT RAISE(ABORT,'fixture_settlement_failure'); END`);
  expect(() => f.store.settleStopped("lf_first", 2, f.stopped)).toThrow("fixture_settlement_failure");
  expect(f.store.get("lf_first")).toMatchObject({ state: "running", stop_obligation: 1, receipt_json: null, container_used_seconds: null, revision: 2 });
  expect(f.second().containerDebit(f.chain.chain_id)).toBe(20);
});

it("fails closed on V1, opt-out, malformed opt-in, expired grants, unavailable rounds and deadlines", () => {
  const f = setup(), grant = JSON.parse(f.chain.grant_json) as Record<string, unknown>;
  const local = grant.local_failure as Record<string, unknown>;
  for (const patch of [{ version: 1 }, { local_failure: undefined }, { local_failure: { ...local, enabled: false } },
    { local_failure: { ...local, enabled: 1 } }, { local_failure: { ...local, max_diagnostics_per_head: null } },
    { expires_at: 1000 }, { budget: { max_container_seconds: 19 } }]) {
    f.db.prepare("UPDATE engineering_revision_chains SET grant_json=?,revision=revision+1 WHERE chain_id=?").run(JSON.stringify({ ...grant, ...patch }), f.chain.chain_id);
    const chain = f.chains.get(f.chain.chain_id);
    expect(() => f.store.reserve({ ...f.input, chain_revision: chain.revision, grant_digest: sha(chain.grant_json) })).toThrow();
  }
  f.db.prepare("UPDATE engineering_revision_chains SET grant_json=?,review_deadline=1000,revision=revision+1 WHERE chain_id=?").run(f.chain.grant_json, f.chain.chain_id);
  let chain = f.chains.get(f.chain.chain_id);
  expect(() => f.store.reserve({ ...f.input, chain_revision: chain.revision })).toThrow("intake_binding_denied");
  f.db.prepare("UPDATE engineering_revision_chains SET rounds_used=1,review_deadline=NULL,revision=revision+1 WHERE chain_id=?").run(f.chain.chain_id);
  f.db.prepare("UPDATE engineering_revision_chains SET rounds_used=2,revision=revision+1 WHERE chain_id=?").run(f.chain.chain_id);
  chain = f.chains.get(f.chain.chain_id);
  expect(() => f.store.reserve({ ...f.input, chain_revision: chain.revision })).toThrow("intake_binding_denied");
  expect(f.store.containerDebit(f.chain.chain_id)).toBe(0);
});

it("keeps one active intake across a profile regrant and rejects a moved launch binding", () => {
  const f = setup(); f.store.reserve(f.input);
  const grant = JSON.parse(f.chain.grant_json) as { local_failure: { profile_digest: string } };
  grant.local_failure.profile_digest = E;
  f.db.prepare("UPDATE engineering_revision_chains SET grant_json=?,revision=revision+1 WHERE chain_id=?").run(JSON.stringify(grant), f.chain.chain_id);
  const chain = f.chains.get(f.chain.chain_id);
  expect(() => f.store.reserve({ ...f.input, intake_id: "lf_new_profile", invocation_id: "new-profile", chain_revision: chain.revision,
    profile_digest: E, grant_digest: sha(chain.grant_json) })).toThrow("intake_reused");
  expect(() => f.store.start("lf_first", 1)).toThrow("intake_start_denied");
  expect(f.store.containerDebit(f.chain.chain_id)).toBe(20);
});

it("accumulates debit across heads and grants without refunding prior measured usage", () => {
  const f = setup(); f.store.reserve(f.input); f.store.start("lf_first", 1); f.store.settleStopped("lf_first", 2, f.stopped);
  f.db.prepare("UPDATE engineering_revision_chains SET published_head=?,revision=revision+1 WHERE chain_id=?").run(B, f.chain.chain_id);
  const chain = f.chains.get(f.chain.chain_id);
  f.store.reserve({ ...f.input, intake_id: "lf_next", invocation_id: "next", chain_revision: chain.revision, head_sha: B });
  expect(f.store.containerDebit(f.chain.chain_id)).toBe(27);
  const second = f.store.start("lf_next", 1);
  f.store.settleStopped("lf_next", second.revision, { ...f.stopped, outcome: "passed", container_used_seconds: 20 });
  expect(f.store.containerDebit(f.chain.chain_id)).toBe(27);
});

it("retains recovery settlement after chain close but cannot launch after close or without FULL durability", () => {
  const f = setup(); f.store.reserve(f.input);
  f.db.prepare("UPDATE engineering_revision_chains SET state='closed',revision=revision+1 WHERE chain_id=?").run(f.chain.chain_id);
  expect(() => f.store.start("lf_first", 1)).toThrow("intake_start_denied");
  f.db.pragma("synchronous=NORMAL");
  expect(() => f.store.markStopUnknown("lf_first", 1, "closed")).toThrow("durability_required");
  f.db.pragma("synchronous=FULL");
  expect(f.store.settleNotStarted("lf_first", 1).state).toBe("stopped");
});

it("rejects REPLACE through the partial active-chain index after a profile regrant", () => {
  const f = setup(), original = f.store.reserve(f.input);
  const grant = JSON.parse(f.chain.grant_json) as { local_failure: { profile_digest: string } };
  grant.local_failure.profile_digest = E;
  f.db.prepare("UPDATE engineering_revision_chains SET grant_json=?,revision=revision+1 WHERE chain_id=?").run(JSON.stringify(grant), f.chain.chain_id);
  const chain = f.chains.get(f.chain.chain_id);
  const replacement = { ...original, intake_id: "lf_replace", invocation_id: "replace", profile_digest: E,
    chain_revision: chain.revision, grant_json: chain.grant_json, grant_digest: sha(chain.grant_json) };
  const columns = Object.keys(replacement);
  expect(() => f.db.prepare(`INSERT OR REPLACE INTO engineering_local_failure_intakes(${columns.join(",")})
    VALUES(${columns.map(c => `@${c}`).join(",")})`).run(replacement)).toThrow();
  expect(f.store.get("lf_first")).toEqual(original);
});

it("fences raw stale-owner updates and lets only the new owner reconcile a running obligation", () => {
  const f = setup(); f.store.reserve(f.input); f.store.start("lf_first", 1);
  const replacement = f.attention.claimOwner("replacement");
  expect(() => f.db.exec(`UPDATE engineering_local_failure_intakes SET state='stop_unknown',reason='stale',revision=revision+1
    WHERE intake_id='lf_first'`)).toThrow("intake_state_denied");
  expect(() => f.store.settleStopped("lf_first", 2, f.stopped)).toThrow("stale_owner");
  const recovery = new LocalFailureIntakeStore(f.attention, replacement, () => 1000);
  const unknown = recovery.markStopUnknown("lf_first", 2, "restart");
  expect(recovery.containerDebit(f.chain.chain_id)).toBe(20);
  expect(recovery.settleStopped("lf_first", unknown.revision, { ...f.stopped, outcome: "cancelled" })).toMatchObject({
    owner_instance: f.owner.instance_id, writer_instance: replacement.instance_id, state: "stopped", outcome: "cancelled",
  });
});
