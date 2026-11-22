import { createHash, randomUUID } from "node:crypto";
import { expect, it, onTestFinished } from "vitest";
import { checkGrantWindow } from "../bridge/diagnosis-admission.js";
import { signRevisionGrant } from "../bridge/revision-grant.js";
import { parseLocalFailureRevisionGrant, signLocalFailureRevisionGrant } from "../bridge/revision-local-failure-grant.js";
import { diagnosisFixture, diagnosisRenewal } from "./diagnosis-fixtures.js";
import { ContainedMissionStore } from "./engineering-contained-store.js";
import { LocalFailureDispatchStore } from "./engineering-local-failure-dispatch-store.js";
import { localFailureRenewalBusy, readLocalFailureCarryForward } from "./engineering-local-failure-renewal-facts.js";
import { fixture, dispatchedRepair, publishedRecheck, runFixture } from "./local-failure-recheck.testkit.js";

type Fixture = ReturnType<typeof diagnosisFixture>;
function dispatchFixture() {
  const d = fixture();
  d.input.verify = (_, chain) => {
    const grant = parseLocalFailureRevisionGrant(chain.grant_json);
    checkGrantWindow(grant, d.input.now(), Infinity, chain.budget_json);
    return { grant_digest: createHash("sha256").update(chain.grant_json).digest("hex"), principal: d.f.principal,
      check_ids: ["fixture-check"] };
  };
  return d;
}

it.each(["rounds", "executor", "container", "expiry"])("renews the exhausted %s term and dispatches once", term => {
  const { f, r, input, store } = dispatchFixture();
  const budget = { ...f.facts.grant.budget };
  if (term === "rounds") f.db.exec("UPDATE engineering_revision_chains SET rounds_used=1,revision=revision+1");
  if (term === "executor") { input.launchCaps.executor_seconds = 1500; budget.max_executor_seconds = 5000; }
  if (term === "container") { input.launchCaps.verify_seconds = 1500; budget.max_container_seconds = 5000; }
  if (term === "expiry") input.now = () => f.facts.grant.expires_at;
  expect(store.dispatch(input)).toMatchObject({ status: "refused", reason: term === "rounds" ? "verify_repair_limit"
    : term === "expiry" ? "verify_grant_invalid" : "verify_budget_exhausted" });
  diagnosisRenewal(f, input.now(), { budget, rounds: term === "rounds" ? 2 : 1 }).replace();
  const d = store.dispatch(input);
  expect(d.status).toBe("dispatched");
  expect(store.dispatch(input)).toEqual(d);
  const intake = f.store.intakes.get(r.intake_id!);
  expect(f.db.prepare("SELECT grant_id,grant_digest FROM engineering_local_failure_dispatches").all())
    .toEqual([{ grant_id: intake.grant_id, grant_digest: intake.grant_digest }]);
  expect(f.db.prepare("SELECT mission_id FROM engineering_mission_lineage WHERE source_kind='local_failure'").all()).toHaveLength(1);
});

const substitutions = ["another chain", "v1", "profile_id", "profile_digest", "artifact_digest", "repository", "commit", "first issuance"] as const;
function substitute(f: Fixture, kind: typeof substitutions[number]) {
  const { preview } = diagnosisRenewal(f, f.facts.now);
  const { local_failure: pin, renews, ...shared } = preview;
  const sign = (local_failure = pin) => signLocalFailureRevisionGrant({ ...preview, local_failure }, f.keys.privateKey);
  const source = pin.trusted_source;
  const grant = (() => {
    switch (kind) {
      case "v1": return signRevisionGrant({ ...shared, version: 1, renews }, f.keys.privateKey);
      case "another chain": return signLocalFailureRevisionGrant({ ...preview, renews: { ...renews, chain_id: 'rc_' + randomUUID() } }, f.keys.privateKey);
      case "first issuance": return signLocalFailureRevisionGrant({ ...shared, local_failure: pin }, f.keys.privateKey);
      case "profile_id": return sign({ ...pin, profile_id: "other" });
      case "profile_digest": return sign({ ...pin, profile_digest: "9".repeat(64) });
      case "repository": return sign({ ...pin, trusted_source: { ...source, repository: "other/repo" } });
      case "commit": return sign({ ...pin, trusted_source: { ...source, commit: "9".repeat(40) } });
      case "artifact_digest": return sign({ ...pin, trusted_source: { ...source, artifact_digest: "9".repeat(64) } });
    }
  })();
  // These substitutions bypass replaceGrant and its schema 64 trigger to exercise the readers independently.
  f.db.exec("DROP TRIGGER engineering_local_failure_grant_monotonic");
  f.db.prepare("UPDATE engineering_revision_chains SET grant_json=?,revision=revision+1 WHERE chain_id=?")
    .run(JSON.stringify(grant), f.input.chain_id);
}

it.each([...substitutions, "expired"] as const)("refuses dispatch under %s without consuming the receipt", kind => {
  const { f, r, input, store } = dispatchFixture();
  if (kind === "expired") {
    const renewal = diagnosisRenewal(f, f.facts.now + 1);
    renewal.replace();
    input.now = () => renewal.grant.expires_at;
  } else substitute(f, kind);
  expect(store.dispatch(input)).toMatchObject({ status: "refused", reason: "verify_grant_invalid" });
  expect(store.recover(r.request_id)).toBeNull();
  expect(f.db.prepare("SELECT mission_id FROM engineering_mission_lineage WHERE source_kind='local_failure'").all()).toEqual([]);
  expect(f.store.receipt(r.receipt_id!).consumed_by).toBeNull();
});

function gate() {
  const { f, dispatch } = dispatchedRepair();
  const child = dispatch.child_mission_id, missions = new ContainedMissionStore(f.attention, f.owner);
  f.db.prepare("UPDATE engineering_contained_missions SET state='awaiting_decision',revision=revision+1 WHERE mission_id=?").run(child);
  missions.record(child, "halted", { reason: "publication_pending" }, f.facts.now);
  const store = new LocalFailureDispatchStore(f.store);
  return { f, child, missions, fence: (now: number) => store.publicationFence(child, now) };
}

it("returns the original fence facts through two signed renewals", () => {
  const { f, fence } = gate();
  const original = fence(f.facts.now);
  expect(original.ok).toBe(true);
  for (const now of [f.facts.now + 1, f.facts.now + 2]) {
    diagnosisRenewal(f, now).replace();
    expect(fence(now)).toEqual(original);
  }
});

it.each([...substitutions, "expired", "before issuance", "wall clock"] as const)("refuses the publication fence for %s", kind => {
  const { f, fence } = gate();
  let now = f.facts.now;
  if (kind === "expired" || kind === "before issuance" || kind === "wall clock") {
    const issue = kind === "wall clock" ? now + f.facts.grant.budget.max_wall_clock_hours * 3_600_000 : now + 1;
    const renewal = diagnosisRenewal(f, issue);
    renewal.replace();
    now = kind === "expired" ? renewal.grant.expires_at : kind === "wall clock" ? issue : issue - 1;
  } else substitute(f, kind);
  expect(fence(now)).toEqual({ ok: false, reason: "verify_publish_authority_invalid" });
});

const empty = { has_intake: false, busy: false, eligible_diagnoses: [], waiting_child: null, pending_recheck: null };
function checkFacts(f: Fixture, expected: ReturnType<typeof readLocalFailureCarryForward>) {
  expect(readLocalFailureCarryForward(f.db, f.input)).toEqual(expected);
  expect(localFailureRenewalBusy(f.db, f.input.root_mission_id)).toBe(expected.busy);
  const { replace } = diagnosisRenewal(f, f.facts.now);
  if (expected.busy) expect(replace).toThrow("grant_renewal_busy");
  else expect(replace).not.toThrow();
}
it.each(["empty", "unsettled"])("reports facts for an %s chain", kind => {
  const f = diagnosisFixture();
  onTestFinished(f.close);
  if (kind === "unsettled") {
    const r = f.store.register(f.input);
    expect(f.store.admit(r.request_id, r.revision, f.facts).status).toBe("admitted");
  }
  checkFacts(f, { ...empty, busy: kind === "unsettled", has_intake: kind === "unsettled" });
});
it("lists an eligible undispatched diagnosis", () => {
  const { f, r } = fixture();
  checkFacts(f, { ...empty, has_intake: true, eligible_diagnoses: [{ request_id: r.request_id, head_sha: r.head_sha }] });
});
it("lists the gate child until an approval exists", () => {
  const { f, child, missions } = gate();
  checkFacts(f, { ...empty, has_intake: true, waiting_child: { child_mission_id: child, candidate_head: null } });
  missions.record(child, "verify_repair_approval", {}, f.facts.now);
  checkFacts(f, { ...empty, has_intake: true, busy: true });
});
it("counts both stopped attempts for the pending recheck", () => {
  const d = publishedRecheck({ rounds: 2, recheck: { timeout_seconds: 12 } });
  d.recordConfirmation();
  d.confirm();
  const row = d.open(), { runs, input } = runFixture(d, row);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { run } = runs.reserve({ ...input, invocation_id: randomUUID() });
    runs.settleNotStarted(run.run_id, run.revision, "verify_recheck_not_started");
  }
  checkFacts(d.f, { ...empty, has_intake: true, pending_recheck: { recheck_id: row.recheck_id, attempts: 2 } });
});
