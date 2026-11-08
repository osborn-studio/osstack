import { createHash, randomUUID } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { canonicalJson } from "../bridge/revision-grant.js";
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

function setup(identity: Partial<Pick<NewLocalFailureIntake, "head_sha" | "tree_sha" | "base_sha">> = {}) {
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
  return { db, path, attention, owner, chain, chains, store, input, second, stopped };
}

it("reserves an immutable binding and exposes full cap and active exclusion", () => {
  const f = setup(), row = f.store.reserve(f.input);
  expect(row).toMatchObject({ ...f.input, state: "reserved", revision: 1, stop_obligation: 1, container_used_seconds: null });
  expect(f.store.containerDebit(f.chain.chain_id)).toBe(20);
  expect(f.store.activeExclusions(f.chain.chain_id).map(r => r.intake_id)).toEqual(["lfi_00000000-0000-4000-8000-000000000001"]);
  expect(f.db.pragma("foreign_key_check")).toEqual([]);
});

it("serializes duplicate and competing admissions across separate SQLite handles", () => {
  const f = setup(), other = f.second();
  f.db.exec("BEGIN IMMEDIATE");
  expect(() => other.reserve(f.input)).toThrow(/locked/);
  f.db.exec("ROLLBACK");
  f.store.reserve(f.input);
  expect(() => other.reserve(f.input)).toThrow(/intake_reused/);
  expect(() => other.reserve({ ...f.input, intake_id: `lfi_${randomUUID()}`, invocation_id: "other", profile_digest: P })).toThrow();
  expect(other.containerDebit(f.chain.chain_id)).toBe(20);
});

it("retains unknown-stop cost and exclusion across restart and forbids blind relaunch", () => {
  const f = setup(); f.store.reserve(f.input);
  const running = f.store.start("lfi_00000000-0000-4000-8000-000000000001", 1);
  const unknown = f.store.markStopUnknown("lfi_00000000-0000-4000-8000-000000000001", running.revision, "stop_unproven");
  expect(unknown).toMatchObject({ state: "stop_unknown", stop_obligation: 1 });
  const other = f.second();
  expect(other.containerDebit(f.chain.chain_id)).toBe(20);
  expect(other.activeExclusions(f.chain.chain_id)).toHaveLength(1);
  expect(() => other.start("lfi_00000000-0000-4000-8000-000000000001", unknown.revision)).toThrow(/state_denied/);
  expect(() => other.reserve({ ...f.input, intake_id: `lfi_${randomUUID()}`, invocation_id: "retry" })).toThrow();
  const done = other.settleStopped("lfi_00000000-0000-4000-8000-000000000001", unknown.revision, f.stopped);
  expect(done).toMatchObject({ state: "stopped", outcome: "reproducible_failure", stop_obligation: 0 });
  expect(other.containerDebit(f.chain.chain_id)).toBe(7);
  expect(other.activeExclusions(f.chain.chain_id)).toEqual([]);
  expect(() => other.reserve({ ...f.input, intake_id: `lfi_${randomUUID()}`, invocation_id: "retry" })).toThrow(/intake_reused/);
});

it("rolls back caller transactions and fences stale revisions and owners", () => {
  const f = setup();
  expect(() => f.db.transaction(() => { f.store.reserve(f.input); throw Error("rollback"); }).immediate()).toThrow("rollback");
  expect(f.store.containerDebit(f.chain.chain_id)).toBe(0);
  f.store.reserve(f.input);
  expect(() => f.store.start("lfi_00000000-0000-4000-8000-000000000001", 9)).toThrow("version_conflict");
  // A launch-ready transition must commit independently of caller rollback.
  expect(() => f.db.transaction(() => f.store.start("lfi_00000000-0000-4000-8000-000000000001", 1))()).toThrow("intake_nested_launch");
  const replacement = f.attention.claimOwner("replacement");
  expect(() => f.store.start("lfi_00000000-0000-4000-8000-000000000001", 1)).toThrow("stale_owner");
  const recovered = new LocalFailureIntakeStore(f.attention, replacement, () => 1000);
  expect(() => recovered.start("lfi_00000000-0000-4000-8000-000000000001", 1)).toThrow("intake_owner_changed");
  expect(recovered.markStopUnknown("lfi_00000000-0000-4000-8000-000000000001", 1, "owner_replaced").state).toBe("stop_unknown");
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
  const f = setup(); f.store.reserve(f.input); f.store.start("lfi_00000000-0000-4000-8000-000000000001", 1);
  for (const patch of [{ container_used_seconds: -1 }, { container_used_seconds: 21 },
    { container_used_seconds: 0.5 }, { proof_ref: "" }, { proof_digest: "" }, { receipt_json: "{}", evidence_digest: "" }]) {
    expect(() => f.store.settleStopped("lfi_00000000-0000-4000-8000-000000000001", 2, { ...f.stopped, ...patch })).toThrow();
    expect(f.store.containerDebit(f.chain.chain_id)).toBe(20);
    expect(f.store.get("lfi_00000000-0000-4000-8000-000000000001").revision).toBe(2);
  }
});

it("freezes bindings and terminal receipt/evidence against raw SQL and REPLACE tampering", () => {
  const f = setup(); f.store.reserve(f.input);
  for (const [column, value] of Object.entries({ chain_id: "rc_other", chain_revision: 2, root_mission_id: "cm_other",
    repository: "other/repo", pr_number: 2, branch: "other", head_sha: B, tree_sha: B, base_ref: "other", base_sha: H,
    profile_id: "other", profile_digest: E, trusted_source_digest: P, grant_id: "other", grant_json: "{}", grant_digest: E,
    ci_hint_json: "{}", invocation_id: "other", journal_ref: "other", container_cap_seconds: 10,
    owner_home: "other", owner_instance: "other", owner_generation: 2, created_at: 999 })) {
    expect(() => f.db.prepare(`UPDATE engineering_local_failure_intakes SET ${column}=?,revision=revision+1 WHERE intake_id='lfi_00000000-0000-4000-8000-000000000001'`).run(value)).toThrow();
  }
  f.store.start("lfi_00000000-0000-4000-8000-000000000001", 1);
  const done = f.store.settleStopped("lfi_00000000-0000-4000-8000-000000000001", 2, f.stopped);
  expect(done.receipt_bytes_sha256).toBe(sha(f.stopped.receipt_json));
  for (const [column, value] of Object.entries({ receipt_json: "{}", receipt_bytes_sha256: P, evidence_digest: P,
    container_used_seconds: 0, state: "running", proof_ref: "other", proof_digest: P, reason: "other" })) {
    expect(() => f.db.prepare(`UPDATE engineering_local_failure_intakes SET ${column}=?,revision=revision+1 WHERE intake_id='lfi_00000000-0000-4000-8000-000000000001'`).run(value)).toThrow();
  }
  expect(() => f.db.exec("DELETE FROM engineering_local_failure_intakes")).toThrow("intake_immutable");
  expect(() => f.db.exec("INSERT OR REPLACE INTO engineering_local_failure_intakes SELECT * FROM engineering_local_failure_intakes")).toThrow();
  expect(f.store.get("lfi_00000000-0000-4000-8000-000000000001")).toEqual(done);
});

it("releases only a never-started reservation without a runner receipt and never reruns it", () => {
  const f = setup(); f.store.reserve(f.input);
  expect(() => f.store.settleStopped("lfi_00000000-0000-4000-8000-000000000001", 1, f.stopped)).toThrow();
  const unknown = f.store.markStopUnknown("lfi_00000000-0000-4000-8000-000000000001", 1, "restart_before_launch");
  expect(f.store.settleNotStarted("lfi_00000000-0000-4000-8000-000000000001", unknown.revision)).toMatchObject({ state: "stopped", outcome: "not_started", receipt_json: null });
  expect(f.store.containerDebit(f.chain.chain_id)).toBe(0);
  expect(() => f.store.reserve({ ...f.input, intake_id: `lfi_${randomUUID()}`, invocation_id: "again" })).toThrow("intake_reused");
});

it("cannot erase a launched obligation as never-started or roll back a partial settlement", () => {
  const f = setup(); f.store.reserve(f.input); f.store.start("lfi_00000000-0000-4000-8000-000000000001", 1);
  expect(() => f.store.settleNotStarted("lfi_00000000-0000-4000-8000-000000000001", 2)).toThrow();
  f.db.exec(`CREATE TRIGGER fixture_abort_settlement AFTER UPDATE ON engineering_local_failure_intakes
    WHEN NEW.state='stopped' BEGIN SELECT RAISE(ABORT,'fixture_settlement_failure'); END`);
  expect(() => f.store.settleStopped("lfi_00000000-0000-4000-8000-000000000001", 2, f.stopped)).toThrow("fixture_settlement_failure");
  expect(f.store.get("lfi_00000000-0000-4000-8000-000000000001")).toMatchObject({ state: "running", stop_obligation: 1, receipt_json: null, container_used_seconds: null, revision: 2 });
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
  expect(() => f.store.reserve({ ...f.input, intake_id: `lfi_${randomUUID()}`, invocation_id: "new-profile", chain_revision: chain.revision,
    profile_digest: E, grant_digest: sha(chain.grant_json) })).toThrow("intake_reused");
  expect(() => f.store.start("lfi_00000000-0000-4000-8000-000000000001", 1)).toThrow("intake_start_denied");
  expect(f.store.containerDebit(f.chain.chain_id)).toBe(20);
});

it("accumulates debit across heads and grants without refunding prior measured usage", () => {
  const f = setup(); f.store.reserve(f.input); f.store.start("lfi_00000000-0000-4000-8000-000000000001", 1); f.store.settleStopped("lfi_00000000-0000-4000-8000-000000000001", 2, f.stopped);
  f.db.prepare("UPDATE engineering_revision_chains SET published_head=?,revision=revision+1 WHERE chain_id=?").run(B, f.chain.chain_id);
  const chain = f.chains.get(f.chain.chain_id);
  const nextId = `lfi_${randomUUID()}`;
  f.store.reserve({ ...f.input, intake_id: nextId, invocation_id: "next", chain_revision: chain.revision, head_sha: B });
  expect(f.store.containerDebit(f.chain.chain_id)).toBe(27);
  const second = f.store.start(nextId, 1);
  f.store.settleStopped(nextId, second.revision, { ...f.stopped, outcome: "passed", container_used_seconds: 20 });
  expect(f.store.containerDebit(f.chain.chain_id)).toBe(27);
});

it("retains recovery settlement after chain close but cannot launch after close or without FULL durability", () => {
  const f = setup(); f.store.reserve(f.input);
  f.db.prepare("UPDATE engineering_revision_chains SET state='closed',revision=revision+1 WHERE chain_id=?").run(f.chain.chain_id);
  expect(() => f.store.start("lfi_00000000-0000-4000-8000-000000000001", 1)).toThrow("intake_start_denied");
  f.db.pragma("synchronous=NORMAL");
  expect(() => f.store.markStopUnknown("lfi_00000000-0000-4000-8000-000000000001", 1, "closed")).toThrow("durability_required");
  f.db.pragma("synchronous=FULL");
  expect(f.store.settleNotStarted("lfi_00000000-0000-4000-8000-000000000001", 1).state).toBe("stopped");
});

it("rejects REPLACE through the partial active-chain index after a profile regrant", () => {
  const f = setup(), original = f.store.reserve(f.input);
  const grant = JSON.parse(f.chain.grant_json) as { local_failure: { profile_digest: string } };
  grant.local_failure.profile_digest = E;
  f.db.prepare("UPDATE engineering_revision_chains SET grant_json=?,revision=revision+1 WHERE chain_id=?").run(JSON.stringify(grant), f.chain.chain_id);
  const chain = f.chains.get(f.chain.chain_id);
  const replacement = { ...original, intake_id: `lfi_${randomUUID()}`, invocation_id: "replace", profile_digest: E,
    chain_revision: chain.revision, grant_json: chain.grant_json, grant_digest: sha(chain.grant_json) };
  const columns = Object.keys(replacement);
  expect(() => f.db.prepare(`INSERT OR REPLACE INTO engineering_local_failure_intakes(${columns.join(",")})
    VALUES(${columns.map(c => `@${c}`).join(",")})`).run(replacement)).toThrow();
  expect(f.store.get("lfi_00000000-0000-4000-8000-000000000001")).toEqual(original);
});

it("fences raw stale-owner updates and lets only the new owner reconcile a running obligation", () => {
  const f = setup(); f.store.reserve(f.input); f.store.start("lfi_00000000-0000-4000-8000-000000000001", 1);
  const replacement = f.attention.claimOwner("replacement");
  expect(() => f.db.exec(`UPDATE engineering_local_failure_intakes SET state='stop_unknown',reason='stale',revision=revision+1
    WHERE intake_id='lfi_00000000-0000-4000-8000-000000000001'`)).toThrow("intake_state_denied");
  expect(() => f.store.settleStopped("lfi_00000000-0000-4000-8000-000000000001", 2, f.stopped)).toThrow("stale_owner");
  const recovery = new LocalFailureIntakeStore(f.attention, replacement, () => 1000);
  const unknown = recovery.markStopUnknown("lfi_00000000-0000-4000-8000-000000000001", 2, "restart");
  expect(recovery.containerDebit(f.chain.chain_id)).toBe(20);
  expect(recovery.settleStopped("lfi_00000000-0000-4000-8000-000000000001", unknown.revision, { ...f.stopped, outcome: "cancelled" })).toMatchObject({
    owner_instance: f.owner.instance_id, writer_instance: replacement.instance_id, state: "stopped", outcome: "cancelled",
  });
});


it("stores exact observation bytes with no canonical host receipt digest alias", () => {
  // This host-shaped test vector follows frozen efbea370. It does not authenticate host evidence.
  const f = setup();
  const receipt = { version: 1, intake_id: `lfi_${randomUUID()}`, chain_id: f.input.chain_id,
    root_mission_id: f.input.root_mission_id, grant_id: f.input.grant_id, repository: f.input.repository,
    pr: f.input.pr_number, branch: f.input.branch, head: f.input.head_sha, tree: f.input.tree_sha,
    base_ref: f.input.base_ref, base_sha: f.input.base_sha, profile_id: f.input.profile_id,
    profile_digest: P, trusted_source_digest: E, invocation_id: f.input.invocation_id,
    started_at: 1000, finished_at: 1001, outcome: "reproducible_failure",
    checks: [{ check_id: "fixture", category: "test", exit_code: 1, result_digest: E }],
    bounded_redacted_summary: "synthetic observation", evidence_digest: E,
    stop: { proven: true, proof_ref: "fixture-stop", proof_digest: E } };
  // Canonical receipt identity uses parsed data, canonical JSON and a domain. Raw bytes do not.
  const canonicalHostDigest = sha(canonicalJson({ domain: "osstack.local-verification-receipt.v1", receipt }));
  const observations = [JSON.stringify(receipt), JSON.stringify(receipt, null, 2)];
  const byteDigests: Array<string | null> = [];
  for (const receiptJson of observations) {
    const fixture = setup(); fixture.store.reserve(fixture.input); fixture.store.start(fixture.input.intake_id, 1);
    const stopped = fixture.store.settleStopped(fixture.input.intake_id, 2, { ...fixture.stopped, receipt_json: receiptJson });
    expect(stopped.receipt_json).toBe(receiptJson);
    expect(stopped.receipt_bytes_sha256).toBe(sha(receiptJson));
    expect(stopped.receipt_bytes_sha256).not.toBe(canonicalHostDigest);
    expect(stopped).not.toHaveProperty("receipt_digest");
    expect(fixture.second().get(fixture.input.intake_id)).toEqual(stopped);
    byteDigests.push(stopped.receipt_bytes_sha256);
  }
  expect(JSON.parse(observations[0]!)).toEqual(JSON.parse(observations[1]!));
  for (const receiptJson of observations) {
    expect(sha(canonicalJson({ domain: "osstack.local-verification-receipt.v1", receipt: JSON.parse(receiptJson) }))).toBe(canonicalHostDigest);
  }
  expect(byteDigests[0]).not.toBe(byteDigests[1]);
});

it("keeps a timed out invocation excluded at full cap until the host reconciles stop", () => {
  const f = setup(); f.store.reserve(f.input); f.store.start(f.input.intake_id, 1);
  const unknown = f.store.markStopUnknown(f.input.intake_id, 2, "timeout_stop_unproven");
  const timeout: StoppedDiagnostic = { ...f.stopped, outcome: "timeout", container_used_seconds: 20 };
  expect(() => f.store.settleStopped(f.input.intake_id, unknown.revision, { ...timeout, proof_ref: "" })).toThrow();
  expect(() => f.store.settleNotStarted(f.input.intake_id, unknown.revision)).toThrow();
  expect(() => f.store.start(f.input.intake_id, unknown.revision)).toThrow();
  expect(f.store.containerDebit(f.chain.chain_id)).toBe(20);
  expect(f.store.activeExclusions(f.chain.chain_id)).toHaveLength(1);
  expect(f.store.get(f.input.intake_id)).toMatchObject({ state: "stop_unknown", stop_obligation: 1, outcome: null });
  // Only after actual stop reconciliation may the host supply its verified proof references.
  const done = f.store.settleStopped(f.input.intake_id, unknown.revision, timeout);
  expect(done).toMatchObject({ state: "stopped", outcome: "timeout", stop_obligation: 0 });
  expect(done).not.toHaveProperty("receipt_digest");
  expect(f.store.containerDebit(f.chain.chain_id)).toBe(20);
  expect(f.store.activeExclusions(f.chain.chain_id)).toEqual([]);
  expect(() => f.store.settleStopped(f.input.intake_id, done.revision, f.stopped)).toThrow();
  expect(f.store.get(f.input.intake_id)).toEqual(done);
  expect(() => f.store.reserve({ ...f.input, intake_id: `lfi_${randomUUID()}`, invocation_id: "timeout-retry" })).toThrow("intake_reused");
});


it("rejects noncanonical intake IDs before inserting capacity", () => {
  const f = setup();
  for (const intakeId of ["lf_legacy", "lfi_short", `lfi_${"a".repeat(35)}`, `lfi_${"a".repeat(37)}`,
    `lfi_${"A".repeat(36)}`, `lfi_${"g".repeat(36)}`, `lfi_${"a".repeat(35)}_`,
    `lfi_${"a".repeat(35)}\n`, `lfi_${"a".repeat(36)}\0`, `LFI_${"a".repeat(36)}`, `lfi_${"a".repeat(35)}\0`]) {
    expect(() => f.store.reserve({ ...f.input, intake_id: intakeId })).toThrow("intake_identity_invalid");
    expect(f.store.containerDebit(f.chain.chain_id)).toBe(0);
  }
});

it("accepts canonical generated intake IDs and both full lowercase SHA lengths", () => {
  for (const length of [40, 64]) {
    const f = setup({ head_sha: "a".repeat(length), tree_sha: "e".repeat(length), base_sha: "b".repeat(length) });
    const input = { ...f.input, intake_id: `lfi_${randomUUID()}` };
    expect(input.intake_id).toMatch(/^lfi_[0-9a-f-]{36}$/);
    expect(f.store.reserve(input)).toMatchObject(input);
    const running = f.store.start(input.intake_id, 1);
    expect(f.store.settleStopped(input.intake_id, running.revision, f.stopped).state).toBe("stopped");
  }
});

it("rejects abbreviated, overlong, uppercase and nonhex SHAs in every identity field", () => {
  const f = setup();
  for (const field of ["head_sha", "tree_sha", "base_sha"] as const) {
    for (const value of ["a".repeat(39), "a".repeat(41), "a".repeat(63), "a".repeat(65),
      "A".repeat(40), "A".repeat(64), "g".repeat(40), "g".repeat(64), `${"a".repeat(39)}\n`, `${"a".repeat(40)}\n`, `${"a".repeat(40)}\0`]) {
      expect(() => f.store.reserve({ ...f.input, [field]: value })).toThrow("intake_identity_invalid");
      expect(f.store.containerDebit(f.chain.chain_id)).toBe(0);
    }
  }
});

it("enforces canonical identity checks in SQL independently of the input parser", () => {
  const f = setup();
  const insert = (row: Record<string, unknown>) => {
    const columns = Object.keys(row);
    f.db.prepare(`INSERT INTO engineering_local_failure_intakes(${columns.join(",")})
      VALUES(${columns.map(c => `@${c}`).join(",")})`).run(row);
  };
  // Capture a valid reserved row, then remove it by rollback so all insertion guards still apply.
  f.db.exec("BEGIN IMMEDIATE");
  const valid = f.store.reserve({ ...f.input, intake_id: `lfi_${randomUUID()}` });
  f.db.exec("ROLLBACK");
  for (const intakeId of ["lf_legacy", `lfi_${"a".repeat(35)}`, `lfi_${"g".repeat(36)}`,
    `lfi_${"A".repeat(36)}`, `lfi_${"a".repeat(35)}\n`, `lfi_${"a".repeat(35)}\0`, `lfi_${"a".repeat(36)}\0`]) {
    expect(() => insert({ ...valid, intake_id: intakeId })).toThrow(/CHECK constraint/);
  }
  for (const field of ["head_sha", "tree_sha", "base_sha"] as const) {
    for (const value of ["a".repeat(41), "a".repeat(63), "A".repeat(40), "g".repeat(64), `${"a".repeat(39)}\0`, `${"a".repeat(40)}\0`]) {
      // Align chain identity for this test so only the journal SHA constraint can reject the row.
      const row = { ...valid, [field]: value };
      f.db.prepare("UPDATE engineering_revision_chains SET published_head=?,published_base=?,revision=revision+1 WHERE chain_id=?")
        .run(row.head_sha, row.base_sha, f.chain.chain_id);
      row.chain_revision = f.chains.get(f.chain.chain_id).revision;
      expect(() => insert(row)).toThrow(/CHECK constraint/);
    }
  }
  expect(f.store.containerDebit(f.chain.chain_id)).toBe(0);
});
