import { createHash, randomUUID, generateKeyPairSync } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { samplePreview, GRANT_NOW } from "../bridge/revision-grant-fixtures.js";
import { signLocalFailureRevisionGrant } from "../bridge/revision-local-failure-grant.js";
import { createScratchDirSync } from "../scratch.js";
import { AttentionStore } from "./attention-store.js";
import { openDb } from "./db.js";
import { ContainedMissionStore } from "./engineering-contained-store.js";
import { RevisionChainStore } from "./engineering-revision-chain-store.js";
import { checkRootAdmission, readRootActivity, type RootWriterKind } from "./engineering-root-admission.js";
import { LocalFailureIntakeStore, type NewLocalFailureIntake, type StoppedDiagnostic } from "./engineering-local-failure-intake-store.js";

const H = "a".repeat(40), B = "b".repeat(40), P = "c".repeat(64), E = "d".repeat(64);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => { fn(); }); });

function setup(identity: Partial<Pick<NewLocalFailureIntake, "head_sha" | "tree_sha" | "base_sha">> = {}) {
  const root = realpathSync(createScratchDirSync("tests", "local-intake"));
  const path = join(root, "state.db"), db = openDb({ path });
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.pragma("synchronous=FULL");
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const attention = new AttentionStore(db, path), owner = attention.claimOwner("owner");
  const scope = attention.registerScope(owner, "t", root);
  const principal = { principal_id: "human", client_session_id: "cli", read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [scope.scope_id], operator_scopes: [] };
  const missions = new ContainedMissionStore(attention, owner);
  const mission = missions.authorize(principal, {
    scope_id: scope.scope_id, spec: { goal: "synthetic diagnostic fixture" },
    claim: { repo_identity: "fixture", branch: "fixture", worktree_identity: "fixture" },
  }, 1000);
  const grant = signLocalFailureRevisionGrant({ ...samplePreview({ root_mission_id: mission.mission_id,
    scope_id: scope.scope_id, repository: "fixture/repo", pr_number: 1, branch: "fixture", rounds: 2,
    head_sha: identity.head_sha ?? H, base_sha: identity.base_sha ?? B,
    budget: { max_container_seconds: 100, max_executor_seconds: 1000, max_wall_clock_hours: 48 } }), version: 2,
    local_failure: { enabled: true, profile_id: "fixture", profile_digest: P,
      trusted_source: { repository: "fixture/trusted", commit: H, artifact_digest: E },
      diagnostic_timeout_seconds: 20, max_diagnostics_per_head: 1 } }, generateKeyPairSync("ed25519").privateKey);
  const chains = new RevisionChainStore(attention, owner, () => GRANT_NOW);
  const chain = chains.createLiveChain({ root_mission_id: mission.mission_id, repository: "fixture/repo", pr_number: 1,
    branch: "fixture", base_ref: "main", published_head: identity.head_sha ?? H, published_base: identity.base_sha ?? B, trace_id: "fixture", grant }, 1000);
  const store = new LocalFailureIntakeStore(attention, owner, () => 1000);
  const input: NewLocalFailureIntake = { intake_id: "lfi_00000000-0000-4000-8000-000000000001", chain_id: chain.chain_id, chain_revision: chain.revision,
    root_mission_id: mission.mission_id, repository: "fixture/repo", pr_number: 1, branch: "fixture", head_sha: identity.head_sha ?? H,
    tree_sha: identity.tree_sha ?? "e".repeat(40), base_ref: "main", base_sha: identity.base_sha ?? B, profile_id: "fixture", profile_digest: P,
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
  return { db, path, attention, owner, chain, chains, store, input, second, stopped, missions, principal, scope };
}

type Fixture = ReturnType<typeof setup>;
const review = (f: Fixture) => f.chains.reserve(f.chain.chain_id, f.chains.get(f.chain.chain_id).revision,
  { head: H, review_ids: [7], feedback_digest: E }, 1000);
const actions = (f: Fixture) => f.missions.authorize(f.principal, { scope_id: f.scope.scope_id,
  spec: { goal: "repair fixture", ci_repair: { root: f.input.root_mission_id } },
  claim: { repo_identity: "fixture", branch: "repair", worktree_identity: `repair-${randomUUID()}` } }, 1000);
const admit = (f: Fixture, kind: RootWriterKind) => kind === "review" ? review(f) : kind === "actions_repair" ? actions(f) : f.store.reserve(f.input);
const counts = (f: Fixture) => ["engineering_revision_reservations", "engineering_local_failure_intakes"].map(table =>
  (f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n).concat(
    (f.db.prepare("SELECT count(*) n FROM engineering_contained_missions WHERE json_type(spec_json,'$.ci_repair.root')='text'").get() as { n: number }).n);
const orderings: RootWriterKind[][] = [
  ["review", "actions_repair", "local_failure"], ["review", "local_failure", "actions_repair"],
  ["actions_repair", "review", "local_failure"], ["actions_repair", "local_failure", "review"],
  ["local_failure", "review", "actions_repair"], ["local_failure", "actions_repair", "review"],
];
for (const order of orderings) it(`admits only the first writer: ${order.join(" / ")}`, () => {
  const f = setup(), first = order[0]!;
  admit(f, first);
  for (const kind of order) {
    expect(f.db.transaction(() => checkRootAdmission(f.db, f.input.root_mission_id, kind)).immediate())
      .toEqual(kind === "review" && first === "review" ? { ok: true } : { ok: false, code: "verify_chain_busy", holder: first });
  }
  for (const kind of order.slice(1)) expect(() => admit(f, kind)).toThrow(kind === "review" ? "chain_busy" : "verify_chain_busy");
  expect(counts(f)).toEqual(first === "review" ? [1, 0, 0] : first === "local_failure" ? [0, 1, 0] : [0, 0, 1]);
});

it("requires a transaction and validates positive safe container needs", () => {
  const f = setup();
  expect(() => checkRootAdmission(f.db, f.input.root_mission_id, "review")).toThrow("root_admission_transaction_required");
  for (const seconds of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, 101]) {
    expect(f.db.transaction(() => checkRootAdmission(f.db, f.input.root_mission_id, "local_failure", {
      chain_id: f.chain.chain_id, container_seconds: seconds,
    })).immediate()).toEqual({ ok: false, code: "verify_budget_exhausted", holder: "budget" });
  }
});

it("charges the full intake cap until proven stopped and never charges executor time", () => {
  const f = setup();
  f.store.reserve(f.input);
  expect(f.chains.remainingBudget(f.chain.chain_id)).toEqual({ executor_seconds: 1000, container_seconds: 80 });
  f.store.start(f.input.intake_id, 1);
  f.store.settleStopped(f.input.intake_id, 2, f.stopped);
  expect(f.chains.remainingBudget(f.chain.chain_id)).toEqual({ executor_seconds: 1000, container_seconds: 93 });
});

it("rejects intake capacity beyond settled child usage without inserting a row", () => {
  const f = setup();
  const reserved = review(f), child = f.missions.authorize(f.principal, { scope_id: f.scope.scope_id,
    spec: { goal: "review child" }, claim: { repo_identity: "fixture", branch: "review", worktree_identity: "review" } }, 1000);
  const dispatched = f.chains.dispatch(f.chain.chain_id, reserved.chain.revision, H, child.mission_id, 1000).chain;
  f.chains.allocateChild(f.chain.chain_id, dispatched.revision, child.mission_id, { executor_seconds: 100, container_seconds: 90 }, 1000);
  f.chains.chargeLaunch(f.chain.chain_id, child.mission_id, "container", 90, 1000);
  f.db.prepare("UPDATE engineering_contained_missions SET state='failed',stop_obligation=1,revision=revision+1 WHERE mission_id=?").run(child.mission_id);
  f.db.prepare("UPDATE engineering_contained_missions SET stop_obligation=0,revision=revision+1 WHERE mission_id=?").run(child.mission_id);
  f.db.prepare("UPDATE engineering_revision_reservations SET state='void',settled_reason='fixture',updated_at=1000 WHERE chain_id=?").run(f.chain.chain_id);
  f.db.prepare("UPDATE engineering_revision_chains SET state='awaiting_review',revision=revision+1 WHERE chain_id=?").run(f.chain.chain_id);
  const chain = f.chains.get(f.chain.chain_id);
  expect(() => f.store.reserve({ ...f.input, chain_revision: chain.revision })).toThrow("verify_budget_exhausted");
  expect(f.store.containerDebit(f.chain.chain_id)).toBe(0);
});

it("rolls back admission, journal and debit together, and symmetrically rolls back review", () => {
  const f = setup();
  expect(() => f.db.transaction(() => { f.store.reserve(f.input); throw Error("injected_after_insert"); }).immediate()).toThrow("injected_after_insert");
  expect(counts(f)).toEqual([0, 0, 0]);
  expect(f.store.containerDebit(f.chain.chain_id)).toBe(0);
  expect(() => f.db.transaction(() => { review(f); throw Error("injected_after_reserve"); }).immediate()).toThrow("injected_after_reserve");
  expect(counts(f)).toEqual([0, 0, 0]);
  expect(f.store.reserve(f.input).state).toBe("reserved");
});

for (const state of ["running", "stop_unknown"] as const) it(`keeps ${state} exclusion and debit across owner replacement and chain close`, () => {
  const f = setup(); f.store.reserve(f.input); f.store.start(f.input.intake_id, 1);
  if (state === "stop_unknown") f.store.markStopUnknown(f.input.intake_id, 2, "restart");
  const owner = f.attention.claimOwner("replacement"), store = new LocalFailureIntakeStore(f.attention, owner, () => 1000);
  const chains = new RevisionChainStore(f.attention, owner, () => GRANT_NOW);
  expect(store.get(f.input.intake_id).state).toBe(state);
  expect(store.containerDebit(f.chain.chain_id)).toBe(20);
  expect(() => store.start(f.input.intake_id, store.get(f.input.intake_id).revision)).toThrow();
  for (const kind of ["review", "actions_repair", "local_failure"] as const) {
    expect(f.db.transaction(() => checkRootAdmission(f.db, f.input.root_mission_id, kind)).immediate())
      .toEqual({ ok: false, code: "verify_chain_busy", holder: "local_failure" });
  }
  chains.closeLive(f.chain.chain_id, f.chain.revision, "closed", 1000);
  expect(readRootActivity(f.db, f.input.root_mission_id).local_failure).toEqual({ intake_id: f.input.intake_id, state });
  expect(store.containerDebit(f.chain.chain_id)).toBe(20);
  for (const kind of ["review", "actions_repair", "local_failure"] as const) {
    expect(f.db.transaction(() => checkRootAdmission(f.db, f.input.root_mission_id, kind)).immediate())
      .toEqual({ ok: false, code: "verify_chain_busy", holder: "local_failure" });
  }
  store.settleStopped(f.input.intake_id, store.get(f.input.intake_id).revision, f.stopped);
  expect(readRootActivity(f.db, f.input.root_mission_id).local_failure).toBeNull();
  expect(store.containerDebit(f.chain.chain_id)).toBe(7);
});

it("preserves V1 review authority without granting intake authority", () => {
  const f = setup(), grant = { ...JSON.parse(f.chain.grant_json), version: 1 };
  f.db.prepare("UPDATE engineering_revision_chains SET grant_json=?,revision=revision+1 WHERE chain_id=?").run(JSON.stringify(grant), f.chain.chain_id);
  const chain = f.chains.get(f.chain.chain_id);
  expect(() => f.store.reserve({ ...f.input, chain_revision: chain.revision, grant_digest: sha(chain.grant_json) })).toThrow("intake_opt_in_denied");
  expect(review(f).reservation.state).toBe("reserved");
});

it("retains one diagnosis per head/profile after settlement", () => {
  const f = setup(); f.store.reserve(f.input);
  expect(() => f.store.reserve({ ...f.input, intake_id: `lfi_${randomUUID()}`, invocation_id: "duplicate" })).toThrow();
  f.store.settleNotStarted(f.input.intake_id, 1);
  expect(() => f.store.reserve({ ...f.input, intake_id: `lfi_${randomUUID()}`, invocation_id: "duplicate" })).toThrow("intake_reused");
});

for (const [holder, contender] of [["local_failure", "review"], ["actions_repair", "review"],
  ["local_failure", "actions_repair"], ["review", "actions_repair"], ["actions_repair", "local_failure"]] as const) {
  it(`blocks raw ${contender} insert while ${holder} owns the root`, () => {
    const f = setup();
    const table = contender === "review" ? "engineering_revision_reservations" : contender === "actions_repair" ? "engineering_contained_missions" : "engineering_local_failure_intakes";
    f.db.exec("BEGIN IMMEDIATE"); admit(f, contender);
    const row = f.db.prepare(`SELECT * FROM ${table}${contender === "actions_repair" ? " WHERE json_type(spec_json,'$.ci_repair.root')='text'" : ""}`).get() as Record<string, unknown>;
    f.db.exec("ROLLBACK"); admit(f, holder);
    const columns = Object.keys(row);
    expect(() => f.db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(c => `@${c}`).join(",")})`).run(row))
      .toThrow(contender === "review" ? "chain_busy" : "verify_chain_busy");
  });
}

it("refuses a child slice that would spend an unstopped intake's reserved cap", () => {
  const f = setup(), reserved = review(f);
  const child = f.missions.authorize(f.principal, { scope_id: f.scope.scope_id, spec: { goal: "review child" },
    claim: { repo_identity: "fixture", branch: "review", worktree_identity: "review" } }, 1000);
  f.chains.dispatch(f.chain.chain_id, reserved.chain.revision, H, child.mission_id, 1000);
  f.db.prepare("UPDATE engineering_contained_missions SET state='failed',stop_obligation=1,revision=revision+1 WHERE mission_id=?").run(child.mission_id);
  f.db.prepare("UPDATE engineering_contained_missions SET stop_obligation=0,revision=revision+1 WHERE mission_id=?").run(child.mission_id);
  f.db.prepare("UPDATE engineering_revision_reservations SET state='void',settled_reason='fixture',updated_at=1000 WHERE chain_id=?").run(f.chain.chain_id);
  f.db.prepare("UPDATE engineering_revision_chains SET state='awaiting_review',revision=revision+1 WHERE chain_id=?").run(f.chain.chain_id);
  const chain = f.chains.get(f.chain.chain_id);
  f.store.reserve({ ...f.input, chain_revision: chain.revision });
  expect(() => f.chains.allocateChild(f.chain.chain_id, chain.revision, child.mission_id,
    { executor_seconds: 100, container_seconds: 81 }, 1000)).toThrow("budget_exhausted");
  expect(f.chains.allocations(f.chain.chain_id)).toEqual({});
  expect(f.chains.remainingBudget(f.chain.chain_id)).toEqual({ executor_seconds: 1000, container_seconds: 80 });
});

it("keeps a terminal Actions child busy until stop is proven", () => {
  const f = setup(), child = actions(f);
  f.db.prepare("UPDATE engineering_contained_missions SET state='failed',stop_obligation=1,revision=revision+1 WHERE mission_id=?").run(child.mission_id);
  expect(readRootActivity(f.db, f.input.root_mission_id).actions_repair).toEqual({ child_mission_id: child.mission_id });
  expect(() => review(f)).toThrow("chain_busy");
  f.db.prepare("UPDATE engineering_contained_missions SET stop_obligation=0,revision=revision+1 WHERE mission_id=?").run(child.mission_id);
  expect(readRootActivity(f.db, f.input.root_mission_id).actions_repair).toBeNull();
  expect(review(f).reservation.state).toBe("reserved");
});

it("keeps an unsettled current review child busy after its reservation is voided", () => {
  const f = setup(), reserved = review(f);
  const child = f.missions.authorize(f.principal, { scope_id: f.scope.scope_id, spec: { goal: "review child" },
    claim: { repo_identity: "fixture", branch: "review", worktree_identity: "review" } }, 1000);
  f.chains.dispatch(f.chain.chain_id, reserved.chain.revision, H, child.mission_id, 1000);
  f.db.prepare("UPDATE engineering_revision_reservations SET state='void',settled_reason='fixture',updated_at=1000 WHERE chain_id=?").run(f.chain.chain_id);
  expect(readRootActivity(f.db, f.input.root_mission_id).review).toEqual({ chain_id: f.chain.chain_id });
  expect(f.db.transaction(() => checkRootAdmission(f.db, f.input.root_mission_id, "review")).immediate()).toEqual({ ok: true });
  for (const kind of ["actions_repair", "local_failure"] as const) {
    expect(f.db.transaction(() => checkRootAdmission(f.db, f.input.root_mission_id, kind)).immediate())
      .toEqual({ ok: false, code: "verify_chain_busy", holder: "review" });
  }
});

it("preserves reservation_child_busy when review reserves with an unsettled current child", () => {
  const f = setup(), reserved = review(f);
  const child = f.missions.authorize(f.principal, { scope_id: f.scope.scope_id, spec: { goal: "review child" },
    claim: { repo_identity: "fixture", branch: "review", worktree_identity: "review" } }, 1000);
  f.chains.dispatch(f.chain.chain_id, reserved.chain.revision, H, child.mission_id, 1000);
  f.db.prepare("UPDATE engineering_revision_reservations SET state='void',settled_reason='fixture',updated_at=1000 WHERE chain_id=?").run(f.chain.chain_id);
  const nextHead = "f".repeat(40);
  f.db.prepare("UPDATE engineering_revision_chains SET state='awaiting_review',published_head=?,revision=revision+1 WHERE chain_id=?").run(nextHead, f.chain.chain_id);
  expect(() => f.chains.reserve(f.chain.chain_id, f.chains.get(f.chain.chain_id).revision,
    { head: nextHead, review_ids: [8], feedback_digest: E }, 1000)).toThrow(/reservation_child_busy/);
});

it("rejects a root binding mismatch before shared admission and leaves no debit", () => {
  const f = setup();
  expect(() => f.store.reserve({ ...f.input, root_mission_id: "wrong" })).toThrow("intake_binding_denied");
  expect(f.store.containerDebit(f.chain.chain_id)).toBe(0);
});
