import { afterEach, expect, it } from "vitest";
import { DiagnosisStore } from "./engineering-diagnosis-store.js";
import { verificationDedupKey } from "../bridge/verification-result.js";
import { createHash, randomUUID } from "node:crypto";
import { GRANT_NOW } from "../bridge/revision-grant-fixtures.js";
import { localFailureBindingFromLedger, type LocalVerificationReceipt } from "../bridge/local-failure.js";
import { diagnosisFixture, diagnosisRenewal, eligibleRequest } from "./diagnosis-fixtures.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
function fixture() {
  const f = diagnosisFixture();
  cleanup.push(f.close);
  return f;
}
it("registers once without a debit and binds only accepted contract bytes", () => {
  const f = fixture();
  expect(() => f.store.register({ ...f.input, contract_text: "{}" })).toThrow();
  const r = f.store.register(f.input);
  expect(r.state).toBe("registered");
  expect(f.store.register(f.input)).toEqual(r);
  expect(f.store.intakes.containerDebit(f.facts.chain_id)).toBe(0);
});
it("waits for an owner grant", () => {
  const f = fixture();
  expect(f.store.register({ ...f.input, chain_id: null })).toMatchObject({
    state: "awaiting_decision",
    reason: "verify_grant_missing",
  });
});
it.each(["source", "request"])("rolls back reservation at the %s write", (step) => {
  const f = fixture(),
    r = f.store.register(f.input);
  const table = step === "source" ? "engineering_verification_sources" : "engineering_diagnosis_requests";
  f.db.exec(`CREATE TEMP TRIGGER inject BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END`);
  expect(() => f.store.admit(r.request_id, 1, f.facts)).toThrow("injected");
  expect(f.store.get(r.request_id)).toEqual(r);
  expect(f.source.registration(f.v.result_id)?.registered.intake_id).toBeNull();
  expect(f.store.intakes.containerDebit(f.facts.chain_id)).toBe(0);
});
it("commits one intake and consumes only the canonical typed receipt once", () => {
  const f = fixture(),
    r = f.store.register(f.input),
    a = f.store.admit(r.request_id, 1, f.facts);
  if (a.status !== "admitted") throw Error(a.reason);
  expect(f.store.admit(r.request_id, 1, f.facts)).toEqual(a);
  expect(f.source.registration(f.v.result_id)?.registered.intake_id).toBe(a.intake.intake_id);
  expect(f.store.intakes.containerDebit(f.facts.chain_id)).toBe(20);
  const binding = localFailureBindingFromLedger(a.intake),
    receipt: LocalVerificationReceipt = {
      ...binding,
      version: 1,
      started_at: GRANT_NOW,
      finished_at: GRANT_NOW,
      outcome: "reproducible_failure",
      checks: [
        {
          check_id: "fixture-check",
          category: "test",
          exit_code: 1,
          result_digest: sha("result"),
        },
      ],
      bounded_redacted_summary: "fixture",
      evidence_digest: sha("evidence"),
      stop: { proven: true, proof_ref: "proof", proof_digest: sha("proof") },
    };
  expect(() => f.store.recordReceipt(r.request_id, receipt, sha("identity"))).toThrow();
  f.store.intakes.start(binding.intake_id, 1);
  const stopped = f.store.intakes.settleStopped(binding.intake_id, 2, {
    outcome: receipt.outcome,
    container_used_seconds: 1,
    receipt_json: "{}",
    evidence_digest: receipt.evidence_digest,
    proof_ref: "proof",
    proof_digest: receipt.stop.proof_digest,
  });
  for (const key of Object.keys(binding))
    expect(() => f.store.recordReceipt(r.request_id, { ...receipt, [key]: "different" }, sha("identity"))).toThrow();
  // Capture a valid insertion, then roll it back so only the writer fence can reject the forged row.
  let values: Record<string, string | number | null> = {};
  expect(() =>
    f.store.transaction(() => {
      f.store.recordReceipt(r.request_id, receipt, sha("identity"));
      values = f.db.prepare("SELECT * FROM engineering_host_receipts").get() as typeof values;
      throw Error("rollback_fixture");
    }),
  ).toThrow("rollback_fixture");
  const columns = Object.keys(values);
  const table = "engineering_host_receipts";
  const insert = f.db.prepare(
    `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map((c) => "@" + c).join(",")})`,
  );
  expect(() => insert.run({ ...values, owner_instance: "stale-owner" })).toThrow("host_receipt_binding_invalid");
  const row = f.store.recordReceipt(r.request_id, receipt, sha("identity"));
  expect(() => insert.run(values)).toThrow();
  expect(() => f.store.consumeReceipt(row.receipt_id, row.receipt_digest, "consumer")).toThrow();
  f.store.conclude(r.request_id, f.store.get(r.request_id).revision, {
    state: "eligible",
    reason: null,
  });
  for (const bad of [stopped.receipt_bytes_sha256!, f.v.evidence_digest, f.v.dedup_key, sha(f.input.contract_text), sha("random")])
    expect(() => f.store.consumeReceipt(row.receipt_id, bad, "consumer")).toThrow("host_receipt_digest_mismatch");
  expect(() => f.db.exec("DELETE FROM engineering_host_receipts")).toThrow();
  expect(() => f.db.exec("UPDATE engineering_host_receipts SET created_at=created_at")).toThrow();
  expect(() => f.db.exec("REPLACE INTO engineering_host_receipts SELECT * FROM engineering_host_receipts")).toThrow();
  expect(row.owner_generation).toBe(f.owner.generation);
  expect(() => f.store.transaction(() => {
    f.db.exec("DROP TRIGGER engineering_host_receipt_update");
    f.db.prepare("UPDATE engineering_host_receipts SET receipt_json=?").run(JSON.stringify({...receipt,bounded_redacted_summary:"changed"}));
    expect(()=>f.store.consumeReceipt(row.receipt_id,row.receipt_digest,"consumer")).toThrow("host_receipt_digest_mismatch");
    throw Error("restore_fixture");
  })).toThrow("restore_fixture");
  f.store.consumeReceipt(row.receipt_id, row.receipt_digest, "consumer");
  expect(() => f.store.consumeReceipt(row.receipt_id, row.receipt_digest, "consumer")).toThrow("host_receipt_consumed");
});

import { verificationFixture, withdrawalVerificationFixture } from "../bridge/verification-result-fixtures.js";
import { parseVerificationResultV1 } from "../bridge/verification-result.js";
import { RevisionChainStore } from "./engineering-revision-chain-store.js";
import { ContainedMissionStore } from "./engineering-contained-store.js";
function record(
  f: ReturnType<typeof fixture>,
  wire: ReturnType<typeof verificationFixture> | ReturnType<typeof withdrawalVerificationFixture>,
  accept = true,
) {
  const text = JSON.stringify(wire),
    parsed = parseVerificationResultV1(text);
  if (!parsed.ok) throw Error(parsed.code);
  return f.source.record(
    [
      {
        source_kind: "check_run",
        object_id: 2,
        repository_id: wire.repository_id,
        repository: wire.repository,
        pr: wire.pr,
        observed_head_sha: wire.head_sha,
        app_id: 201,
        check_name: "fixture",
        response_digest: sha(text),
        contract_digest: sha(text),
        verdict: accept ? { ok: true } : { ok: false, code: "verify_stale_head" },
        result: parsed.result,
      },
    ],
    2,
    2,
  );
}
it.each(["rejected", "duplicate", "passed", "blocked"])("refuses %s result without creating a request", (mode) => {
  const f = fixture(),
    wire = {
      ...verificationFixture(),
      attempt: 2,
      result_id: "00000000-0000-4000-8000-000000000099",
    };
  if (mode === "passed" || mode === "blocked") wire.outcome = mode;
  record(f, wire, mode !== "rejected");
  expect(() =>
    f.store.register({
      ...f.input,
      result_id: wire.result_id,
      contract_text: JSON.stringify(wire),
    }),
  ).toThrow("verify_scope_unregistered");
  expect(f.db.prepare("SELECT * FROM engineering_diagnosis_requests").all()).toEqual([]);
});
it.each(["register", "admit"])("closes withdrawals at %s", (step) => {
  const f = fixture(),
    prior = step === "admit" ? f.store.register(f.input) : null;
  record(f, withdrawalVerificationFixture());
  const request = prior ? f.store.admit(prior.request_id, prior.revision, f.facts).request : f.store.register(f.input);
  expect(request).toMatchObject({
    state: "diagnostic_closed",
    reason: "verify_withdrawn",
    intake_id: null,
  });
});
it.each([
  "review",
  "actions_repair",
  "local_failure",
  "budget",
  "unknown",
  "contradictory",
  "duplicate",
])("preserves current holds on %s", (kind) => {
  const f = fixture(),
    r = f.store.register(f.input),
    facts = { ...f.facts };
  if (kind === "review")
    new RevisionChainStore(f.attention, f.owner).reserve(
      facts.chain_id,
      1,
      { head: r.head_sha, review_ids: [7], feedback_digest: sha("review") },
      GRANT_NOW,
    );
  if (kind === "actions_repair")
    new ContainedMissionStore(f.attention, f.owner).authorize(
      f.principal,
      {
        scope_id: facts.grant.scope_id,
        spec: { goal: "fixture", ci_repair: { root: r.root_mission_id } },
        claim: {
          repo_identity: "fixture",
          branch: "repair",
          worktree_identity: "repair",
        },
      },
      GRANT_NOW,
    );
  if (kind === "local_failure" || kind === "duplicate") {
    const i = f.store.intakes.reserve({
      ...facts.binding,
      chain_id: facts.chain_id,
      chain_revision: 1,
      root_mission_id: r.root_mission_id,
      profile_id: r.profile_id,
      profile_digest: r.profile_digest,
      trusted_source_digest: r.trusted_source_digest,
      grant_id: facts.grant.grant_id,
      grant_digest: facts.grant_digest,
      intake_id: facts.intake_id,
      container_cap_seconds: 20,
      journal_ref: "prior",
      invocation_id: "prior",
      ci_hint_json: "{}",
    });
    if (kind === "duplicate") f.store.intakes.settleNotStarted(i.intake_id, i.revision);
  }
  if (kind === "unknown") f.db.exec("DROP TRIGGER engineering_mission_lineage_no_delete; DELETE FROM engineering_mission_lineage");
  if (kind === "contradictory")
    f.db.exec("DROP TRIGGER engineering_mission_lineage_no_update; UPDATE engineering_mission_lineage SET source_kind='supersede'");
  if (kind === "budget")
    f.db.prepare("UPDATE engineering_revision_chains SET spent_json=?,revision=revision+1 WHERE chain_id=?").run(
      JSON.stringify({
        allocations: {
          prior: {
            container_seconds: facts.grant.budget.max_container_seconds,
            container_used: 0,
          },
        },
      }),
      facts.chain_id,
    );
  const snapshot = () =>
    ["engineering_revision_reservations", "engineering_contained_missions", "engineering_local_failure_intakes"].map((t) =>
      f.db.prepare(`SELECT * FROM ${t}`).all(),
    );
  const before = snapshot();
  const expected =
    kind === "budget"
      ? "verify_budget_exhausted"
      : kind === "unknown" || kind === "contradictory"
        ? "verify_chain_lineage_unknown"
        : kind === "duplicate"
          ? "verify_duplicate"
          : "verify_chain_busy";
  expect(f.store.admit(r.request_id, r.revision, facts)).toMatchObject({
    status: "refused",
    reason: expected,
    request: { intake_id: null },
  });
  expect(snapshot()).toEqual(before);
});
it("binds a missing chain once when the owner supplies the live grant", () => {
  const f = fixture(),
    r = f.store.register({ ...f.input, chain_id: null });
  const a = f.store.admit(r.request_id, r.revision, f.facts);
  expect(a).toMatchObject({
    status: "admitted",
    request: { state: "admitted", chain_id: f.facts.chain_id },
  });
});
it("keeps a stale grant or changed candidate out of the intake journal", () => {
  const f = fixture(),
    r = f.store.register(f.input);
  for (const facts of [
    { ...f.facts, grant_digest: sha("replaced") },
    { ...f.facts, grant: { ...f.facts.grant, nonce: "f".repeat(32) } },
    { ...f.facts, binding: { ...f.facts.binding, branch: "other" } },
    {
      ...f.facts,
      profile: { ...f.facts.profile, profile_digest: sha("other") },
    },
  ]) {
    const v = f.store.get(r.request_id).revision;
    expect(f.store.admit(r.request_id, v, facts)).toMatchObject({
      status: "refused",
      reason: "verify_grant_invalid",
      request: { intake_id: null },
    });
  }
  expect(f.store.intakes.containerDebit(f.facts.chain_id)).toBe(0);
});

it.each([7, 8])("checks the root at depth %i before reserving an intake", depth => {
  const f = diagnosisFixture({ derive(missions, root, principal) {
    let parent = root;
    for (let i = 1; i <= depth; i++) {
      const child = missions.registerDerived(principal, { scope_id: root.scope_id, spec: JSON.parse(root.spec_json),
        claim: { repo_identity: "fixture", branch: String(i), worktree_identity: String(i) },
        parent_mission_id: parent.mission_id, source: { kind: "verification", id: String(i) }, idempotency_key: String(i) }, root.created_at);
      if (child.status === "waiting") throw Error(child.reason);
      parent = child.mission;
    }
    return parent;
  } });
  cleanup.push(f.close);
  const r = f.store.register(f.input);
  const result = f.store.admit(r.request_id, r.revision, f.facts);
  if (depth === 7) expect(result.status).toBe("admitted");
  else {
    expect(result).toMatchObject({ reason: "verify_chain_depth_limit" });
    expect(f.store.intakes.containerDebit(f.facts.chain_id)).toBe(0);
    expect(f.source.registration(f.v.result_id)?.registered.intake_id).toBeNull();
  }
});

it("pages only never-admitted registered requests in creation and id order", () => {
  const f = fixture();
  const admitted = f.store.register(f.input);
  expect(f.store.admit(admitted.request_id, 1, f.facts).status).toBe("admitted");
  const rows = [];
  for (let i = 1; i <= 104; i++) {
    const wire = { ...f.v, pr: i + 20, result_id: randomUUID() };
    wire.dedup_key = verificationDedupKey(wire);
    record(f, wire);
    const store = new DiagnosisStore(f.attention, f.owner, () => f.facts.now + (i % 3));
    const row = store.register({ ...f.input, result_id: wire.result_id, contract_text: JSON.stringify(wire),
      chain_id: i === 1 ? null : f.input.chain_id });
    if (i > 1) rows.push(row);
  }
  rows.sort((a,b) => a.created_at - b.created_at || a.request_id.localeCompare(b.request_id));
  expect(f.store.registered(0)).toEqual(rows.slice(0, 1));
  expect(f.store.registered(NaN)).toEqual(rows.slice(0, 1));
  expect(f.store.registered()).toEqual(rows.slice(0, 10));
  expect(f.store.registered(200)).toEqual(rows.slice(0, 100));
  expect(f.store.registered(100, rows[99])).toEqual(rows.slice(100));
});

it("pages dispatchable requests by creation time and id and excludes held roots", () => {
  const f = fixture();
  const seed = eligibleRequest(f);
  expect(f.store.dispatchable()).toEqual([{ ...seed, reopened_by: null }]);
  diagnosisRenewal(f, GRANT_NOW + 1).replace();
  // Project independent read-side cases, including incomplete rows that today's writer rejects.
  for (const name of ["diagnosis_requests", "host_receipts", "local_failure_dispatches", "contained_events"]) {
    f.db.exec(`CREATE TEMP TABLE engineering_${name} AS SELECT * FROM main.engineering_${name} WHERE 0`);
  }
  const rows = [];
  for (let i = 0; i < 110; i++) {
    const row = { ...seed, created_at: i % 3, request_id: randomUUID(), root_mission_id: randomUUID(),
      receipt_id: randomUUID(), chain_id: i === 2 ? null : seed.chain_id, state: i === 0 ? "registered" : "eligible" };
    const columns = Object.keys(row);
    f.db.prepare(`INSERT INTO engineering_diagnosis_requests (${columns}) VALUES (${columns.map(k => "@" + k)})`)
      .run({ ...row, receipt_id: i === 1 ? null : row.receipt_id });
    if (i !== 6) f.db.prepare("INSERT INTO engineering_host_receipts(receipt_id, request_id, consumed_at) VALUES(?,?,?)")
      .run(row.receipt_id, i === 7 ? randomUUID() : row.request_id, i === 3 ? seed.created_at : null);
    if (i === 4) f.db.prepare("INSERT INTO engineering_local_failure_dispatches(root_mission_id,request_id) VALUES(?,?)")
      .run(row.root_mission_id, randomUUID());
    if (i === 5) f.db.prepare("INSERT INTO engineering_contained_events(mission_id,kind) VALUES(?,'local_failure_dispatch_refused')")
      .run(row.root_mission_id);
    if (i === 3 || i === 4) f.db.prepare("INSERT INTO engineering_contained_events(mission_id,kind,created_at) VALUES(?,'local_failure_dispatch_refused',?)")
      .run(row.root_mission_id, GRANT_NOW);
    if (i > 7) rows.push({ ...row, reopened_by: null });
  }
  rows.sort((a, b) => a.created_at - b.created_at || a.request_id.localeCompare(b.request_id));
  expect(f.store.dispatchable(0)).toEqual(rows.slice(0, 1));
  expect(f.store.dispatchable(NaN)).toEqual(rows.slice(0, 1));
  expect(f.store.dispatchable()).toEqual(rows.slice(0, 10));
  expect(f.store.dispatchable(200)).toEqual(rows.slice(0, 100));
  expect(f.store.dispatchable(100, rows[99])).toEqual(rows.slice(100));
});

it("requires an own-chain V2 renewal strictly newer than every root refusal", () => {
  const f = fixture(), r = eligibleRequest(f);
  const chains = new RevisionChainStore(f.attention, f.owner);
  const missions = new ContainedMissionStore(f.attention, f.owner);
  const renew = (at: number) => {
    diagnosisRenewal(f, at).replace();
    const event = chains.events(f.input.chain_id).filter(e =>
      e.kind === "grant_replaced" && JSON.parse(e.payload_json).version === 2 && e.created_at === at).at(-1)!;
    return event.seq;
  };
  const refuse = (reason: string, at: number) => missions.record(r.root_mission_id, "local_failure_dispatch_refused",
    { state: "awaiting_decision", reason }, at);
  const t = GRANT_NOW + 2;
  renew(t - 1);
  expect(f.store.dispatchable()).toEqual([{ ...r, reopened_by: null }]);
  refuse("verify_repair_limit", t);
  expect(f.store.dispatchable()).toEqual([]);
  renew(t);
  expect(f.store.dispatchable()).toEqual([]);

  const other = chains.createShadowChain({ ...f.facts.binding, root_mission_id: r.root_mission_id,
    published_head: r.head_sha, published_base: r.base_sha, trace_id: "fixture" }, t);
  chains.appendEvent(other.chain_id, "grant_replaced", { version: 2 }, t + 1);
  chains.appendEvent(f.input.chain_id, "grant_replaced", {}, t + 1);
  expect(f.store.dispatchable()).toEqual([]);

  const first = renew(t + 2);
  expect(f.store.dispatchable()).toEqual([{ ...r, reopened_by: first }]);
  refuse("verify_budget_exhausted", t + 3);
  expect(f.store.dispatchable()).toEqual([]);
  const second = renew(t + 4);
  expect(second).toBeGreaterThan(first);
  expect(f.store.dispatchable()).toEqual([{ ...r, reopened_by: second }]);
  const latest = renew(t + 5);
  expect(f.store.dispatchable()).toEqual([{ ...r, reopened_by: latest }]);
  const receipt = f.store.receipt(r.receipt_id!);
  f.store.consumeReceipt(receipt.receipt_id, receipt.receipt_digest, "fixture-consumer");
  expect(f.store.dispatchable()).toEqual([]);
});
