import { parseVerificationResultV1, verificationDedupKey } from "../bridge/verification-result.js";
import { DiagnosisStore } from "./engineering-diagnosis-store.js";
import { createHash, randomUUID } from "node:crypto";
import { expect, it, onTestFinished } from "vitest";
import { GRANT_NOW } from "../bridge/revision-grant-fixtures.js";
import { signRevisionGrant } from "../bridge/revision-grant.js";
import { signLocalFailureRevisionGrant, type LocalFailureOptIn, type LocalFailureGrantPreview } from "../bridge/revision-local-failure-grant.js";
import { diagnosisFixture, eligibleRequest } from "./diagnosis-fixtures.js";
import { dispatchedRepair, publishedRecheck, runFixture } from "./local-failure-recheck.testkit.js";
import { RevisionChainStore } from "./engineering-revision-chain-store.js";
import { ContainedMissionStore } from "./engineering-contained-store.js";
import { openDb } from "./db.js";

const now = GRANT_NOW + 1000;
const trigger = "engineering_local_failure_grant_monotonic";
function fixture(options: Parameters<typeof diagnosisFixture>[0] = {}) {
  const f = diagnosisFixture(options);
  onTestFinished(f.close);
  return f;
}
type Fixture = ReturnType<typeof fixture>;
function renewal(f: Fixture) {
  const store = new RevisionChainStore(f.attention, f.owner);
  const chain = store.get(f.input.chain_id);
  const { signature: _sig, preview_sha256: _hash, ...old } = f.facts.grant;
  const preview = { ...old, grant_id: 'rg_' + randomUUID(), issued_at: now,
    renews: { chain_id: chain.chain_id, revision: chain.revision }, head_sha: chain.published_head, base_sha: chain.published_base };
  const sign = (over: Partial<LocalFailureGrantPreview> = {}) => signLocalFailureRevisionGrant({ ...preview, ...over }, f.keys.privateKey);
  const replace = (over?: Partial<LocalFailureGrantPreview>) => store.replaceGrant(chain.chain_id, chain.revision, sign(over), now);
  const raw = (grant: unknown, id = chain.chain_id) => f.db.prepare("UPDATE engineering_revision_chains SET grant_json=?,revision=revision+1 WHERE chain_id=?").run(JSON.stringify(grant), id);
  return { store, chain, sign, replace, raw, preview };
}
function refused(f: Fixture, action: () => unknown, code: string) {
  const changes = f.db.prepare("SELECT total_changes()").pluck();
  const before = changes.get();
  expect(action).toThrow(code);
  expect(changes.get()).toEqual(before);
}
function secondChain(f: Fixture) {
  const { store, chain } = renewal(f);
  const root = new ContainedMissionStore(f.attention, f.owner).authorize(f.principal, { scope_id: f.facts.grant.scope_id,
    spec: { goal: "second chain" }, claim: { repo_identity: "second", branch: "second", worktree_identity: "second" } }, GRANT_NOW);
  const { local_failure: _opt, signature: _sig, preview_sha256: _hash, ...shared } = f.facts.grant;
  const preview = { ...shared, version: 1 as const, root_mission_id: root.mission_id, pr_number: chain.pr_number + 1 };
  const grant = signRevisionGrant(preview, f.keys.privateKey);
  const v1 = store.createLiveChain({ ...chain, ...preview, grant }, GRANT_NOW);
  return { v1, preview, store, grant };
}
it("pins the exact V1 result and grant_replaced payload", () => {
  const f = fixture();
  const { v1, preview, store, grant } = secondChain(f);
  const next = signRevisionGrant({ ...preview, grant_id: "rg_" + randomUUID(), issued_at: now, renews: { chain_id: v1.chain_id, revision: v1.revision } }, f.keys.privateKey);
  expect(store.replaceGrant(v1.chain_id, v1.revision, next, now)).toEqual({ head_consumed: false, chain: { ...v1,
    grant_json: JSON.stringify(next), updated_at: now, revision: v1.revision + 1, review_deadline: now + next.review_deadline_ms } });
  expect(JSON.parse(store.events(v1.chain_id).at(-1)!.payload_json)).toEqual({ grant_id: next.grant_id, from_grant_id: grant.grant_id,
    rounds: { from: 1, to: 1 }, expires_at: next.expires_at, budget: next.budget, restored_state: "awaiting_review", head_consumed: false });
});

const pinChanges: Record<string, (old: LocalFailureOptIn) => LocalFailureOptIn> = {
  profile_id: old => ({ ...old, profile_id: "changed" }),
  profile_digest: old => ({ ...old, profile_digest: "9".repeat(64) }),
  repository: old => ({ ...old, trusted_source: { ...old.trusted_source, repository: "other/repo" } }),
  commit: old => ({ ...old, trusted_source: { ...old.trusted_source, commit: "9".repeat(40) } }),
  artifact_digest: old => ({ ...old, trusted_source: { ...old.trusted_source, artifact_digest: "9".repeat(64) } }),
};
it.each(Object.entries(pinChanges))("freezes %s after a stopped intake at both boundaries", (_field, change) => {
  const f = fixture();
  eligibleRequest(f);
  const { replace, raw, sign, preview } = renewal(f);
  const local_failure = change(preview.local_failure);
  refused(f, () => replace({ local_failure }), "grant_opt_in_changed");
  refused(f, () => raw(sign({ local_failure })), "grant_opt_in_changed");
});
it.each(["identical", "raise", "add"] as const)("records only the V2 renewal terms for %s", mode => {
  const f = fixture(mode === "add" ? {} : { recheck: { timeout_seconds: 10 } });
  const { store, chain, sign, preview } = renewal(f);
  const opt = preview.local_failure;
  const changed = mode === "identical" ? [] : ["pin", "diagnostic_timeout_seconds", mode === "add" ? "recheck_added" : "recheck_timeout_seconds"];
  const next = sign(mode === "identical" ? {} : { rounds: 2, budget: { ...preview.budget, max_container_seconds: 4000 },
    local_failure: { ...opt, profile_id: "new-pin", diagnostic_timeout_seconds: 21, recheck: { enabled: true, timeout_seconds: 11 } } });
  expect(store.replaceGrant(chain.chain_id, chain.revision, next, now)).toEqual({ head_consumed: false,
    chain: { ...chain, revision: chain.revision + 1, updated_at: now, grant_json: JSON.stringify(next), review_deadline: now + next.review_deadline_ms } });
  expect(JSON.parse(store.events(chain.chain_id).at(-1)!.payload_json)).toEqual({ grant_id: next.grant_id, from_grant_id: f.facts.grant.grant_id,
    rounds: { from: 1, to: next.rounds }, expires_at: next.expires_at, budget: next.budget, restored_state: "awaiting_review", head_consumed: false,
    version: 2, local_failure: { profile_id: next.local_failure.profile_id, profile_digest: opt.profile_digest, recheck: true, changed } });
});
it("preserves shared refusal codes and leaves no writes", () => {
  const f = fixture({ rounds: 2, recheck: { timeout_seconds: 10 } });
  const { replace, raw, preview, sign, chain, store } = renewal(f);
  const opt = preview.local_failure;
  for (const over of [{ renews: { ...preview.renews, chain_id: "rc_" + randomUUID() } }, { renews: { ...preview.renews, revision: 4 } }, { grant_id: f.facts.grant.grant_id }])
    refused(f, () => replace(over), "grant_binding_mismatch");
  for (const key of Object.keys(preview.budget) as (keyof typeof preview.budget)[])
    refused(f, () => replace({ budget: { ...preview.budget, [key]: preview.budget[key] - 1 } }), "grant_not_monotonic");
  refused(f, () => replace({ rounds: 1 }), "grant_not_monotonic");
  refused(f, () => store.replaceGrant(chain.chain_id, chain.revision, sign(), preview.expires_at), "grant_expired");
  for (const local_failure of [{ ...opt, diagnostic_timeout_seconds: 19 }, { ...opt, recheck: undefined }, { ...opt, recheck: { enabled: true as const, timeout_seconds: 9 } }]) {
    refused(f, () => replace({ local_failure }), "grant_not_monotonic");
    refused(f, () => raw(sign({ local_failure })), "grant_not_monotonic");
  }
  const { local_failure: _opt, ...shared } = preview;
  const downgrade = signRevisionGrant({ ...shared, version: 1 }, f.keys.privateKey);
  refused(f, () => store.replaceGrant(chain.chain_id, chain.revision, downgrade, now), "grant_not_monotonic");
  refused(f, () => raw(downgrade), "grant_not_monotonic");
  refused(f, () => store.replaceGrant(chain.chain_id, chain.revision, { ...sign(), signature: "" }, now), "grant_invalid");
  raw({ ...sign(), signature: "" });
  refused(f, () => store.replaceGrant(chain.chain_id, chain.revision + 1, sign(), now), "chain_grant_unreadable");
});
function upgradeFixture(f: Fixture) {
  const { v1, preview, grant, store } = secondChain(f);
  const { sign, raw } = renewal(f);
  const shared = { ...preview, grant_id: "rg_" + randomUUID(), issued_at: now, renews: { chain_id: v1.chain_id, revision: v1.revision } };
  const upgrade = (over: Partial<LocalFailureGrantPreview> = {}) => sign({ ...shared, version: 2, ...over });
  return { v1, shared, grant, store, upgrade, raw };
}
it("upgrades a V1 grant and enforces V2 rules on subsequent renewals", () => {
  const f = fixture();
  const { v1, store, upgrade, shared, raw } = upgradeFixture(f);
  const next = upgrade();
  const { chain } = store.replaceGrant(v1.chain_id, v1.revision, next, now);
  expect(chain).toEqual({ ...v1, grant_json: JSON.stringify(next), revision: v1.revision + 1, updated_at: now, review_deadline: now + next.review_deadline_ms });
  for (const key of ["rounds_used", "budget_json", "spent_json", "published_head", "published_base", "state"] as const) expect(chain[key]).toBe(v1[key]);
  const event = store.events(chain.chain_id).at(-1)!;
  expect(event.kind).toBe("grant_replaced");
  expect(JSON.parse(event.payload_json)).toMatchObject({ version: 2, local_failure: {
    profile_id: next.local_failure.profile_id, profile_digest: next.local_failure.profile_digest, recheck: false, changed: ["upgrade"],
  } });
  const terms = { grant_id: "rg_" + randomUUID(), renews: { chain_id: chain.chain_id, revision: chain.revision } };
  const downgrade = signRevisionGrant({ ...shared, ...terms }, f.keys.privateKey);
  refused(f, () => store.replaceGrant(chain.chain_id, chain.revision, downgrade, now), "grant_not_monotonic");
  refused(f, () => raw(downgrade, chain.chain_id), "grant_not_monotonic");
  expect(store.replaceGrant(chain.chain_id, chain.revision, upgrade(terms), now).chain.revision).toBe(chain.revision + 1);
});
it("enforces the shared binding, limits and validity window on an upgrade", () => {
  const f = fixture({ rounds: 2 });
  const { v1, shared, grant, store, upgrade } = upgradeFixture(f);
  const replace = (over: Partial<LocalFailureGrantPreview>, at = now) => store.replaceGrant(v1.chain_id, v1.revision, upgrade(over), at);
  for (const over of [{ renews: { ...shared.renews, chain_id: "rc_" + randomUUID() } }, { renews: { ...shared.renews, revision: 4 } },
    { grant_id: grant.grant_id }, { scope_id: "9".repeat(64) }, { protected_set_digest: "9".repeat(64) }])
    refused(f, () => replace(over), "grant_binding_mismatch");
  refused(f, () => replace({ rounds: 1 }), "grant_not_monotonic");
  for (const key of Object.keys(shared.budget) as (keyof typeof shared.budget)[])
    refused(f, () => replace({ budget: { ...shared.budget, [key]: shared.budget[key] - 1 } }), "grant_not_monotonic");
  refused(f, () => replace({}, shared.expires_at), "grant_expired");
  refused(f, () => replace({ issued_at: now + 1 }), "grant_expired");
});
it("follows the V1 renewal rules for a review reservation and an unsettled push", () => {
  const f = fixture();
  const { v1, shared, store, upgrade } = upgradeFixture(f);
  const checkBoth = (revision: number, code: string) => {
    const renews = { chain_id: v1.chain_id, revision };
    for (const next of [signRevisionGrant({ ...shared, renews }, f.keys.privateKey), upgrade({ renews })])
      refused(f, () => store.replaceGrant(v1.chain_id, revision, next, now), code);
  };
  const reserved = store.reserve(v1.chain_id, v1.revision, { head: v1.published_head, review_ids: [7], feedback_digest: "d".repeat(64) }, now);
  checkBoth(reserved.chain.revision, "state_denied");
  const child = f.input.root_mission_id;
  const dispatched = store.dispatch(v1.chain_id, reserved.chain.revision, v1.published_head, child, now).chain;
  const push = store.recordIntent(v1.chain_id, dispatched.revision, { kind: "push", branch: v1.branch,
    expected_old_head: v1.published_head, expected_base_sha: v1.published_base, new_head: "9".repeat(40), child_mission_id: child }, now);
  checkBoth(store.stopLive(v1.chain_id, push.chain.revision, "grant_expired", now).revision, "intent_unsettled");
});
it.each(["root", "chain"])("refuses an upgrade with an intake on the %s", mode => {
  const f = fixture();
  const { v1, store, upgrade } = upgradeFixture(f);
  const request = f.store.register(f.input);
  const admitted = f.store.admit(request.request_id, request.revision, f.facts);
  if (admitted.status !== "admitted") throw Error(admitted.reason);
  // A V1 chain cannot create an intake. Rebind this fixture row to simulate inconsistent historical data.
  f.db.exec("DROP TRIGGER engineering_local_failure_fixed");
  f.db.prepare("UPDATE engineering_local_failure_intakes SET root_mission_id=?, chain_id=?,state='running',started_at=updated_at,revision=revision+1 WHERE intake_id=?")
    .run(v1.root_mission_id, mode === "chain" ? v1.chain_id : f.input.chain_id, admitted.intake.intake_id);
  refused(f, () => store.replaceGrant(v1.chain_id, v1.revision, upgrade(), now), mode === "chain" ? "grant_opt_in_changed" : "grant_renewal_busy");
});
it("after the upgrade a failure on the bound head can be diagnosed once", () => {
  const f = fixture();
  const { v1, store, upgrade } = upgradeFixture(f);
  const wire = { ...f.v, pr: v1.pr_number, result_id: randomUUID() };
  wire.dedup_key = verificationDedupKey(wire);
  const contract_text = JSON.stringify(wire);
  const digest = (s: string) => createHash("sha256").update(s).digest("hex");
  const parsed = parseVerificationResultV1(contract_text);
  if (!parsed.ok) throw Error(parsed.code);
  f.source.record([{ source_kind: "check_run", object_id: 2, repository_id: wire.repository_id, repository: wire.repository,
    pr: wire.pr, observed_head_sha: wire.head_sha, app_id: 201, check_name: "fixture", response_digest: digest(contract_text),
    contract_digest: digest(contract_text), verdict: { ok: true }, result: parsed.result }], 2, 2);
  const diagnoses = new DiagnosisStore(f.attention, f.owner, () => now);
  const request = diagnoses.register({ ...f.input, result_id: wire.result_id, contract_text, root_mission_id: v1.root_mission_id, chain_id: v1.chain_id });
  expect(request).toMatchObject({ state: "awaiting_decision", reason: "verify_grant_missing", intake_id: null });
  const grant = upgrade();
  const binding = { ...f.facts.binding, pr_number: wire.pr };
  const facts = { ...f.facts, now, grant, grant_digest: digest(JSON.stringify(grant)), chain_id: v1.chain_id, binding };
  expect(diagnoses.admit(request.request_id, request.revision, facts)).toMatchObject({ status: "refused", reason: "verify_grant_invalid" });
  store.replaceGrant(v1.chain_id, v1.revision, grant, now);
  const admitted = diagnoses.admit(request.request_id, diagnoses.get(request.request_id).revision, facts);
  if (admitted.status !== "admitted") throw Error(admitted.reason);
  const intake = admitted.intake;
  expect(intake).toMatchObject({ chain_id: v1.chain_id, head_sha: v1.published_head, profile_digest: grant.local_failure.profile_digest });
  diagnoses.intakes.settleNotStarted(intake.intake_id, intake.revision);
  expect(() => diagnoses.intakes.reserve({ ...intake, intake_id: "lfi_" + randomUUID(), invocation_id: randomUUID() })).toThrow("intake_reused");
});
it("keeps state and unsettled push refusals", () => {
  const f = fixture();
  const { store, chain } = renewal(f);
  const reserved = store.reserve(chain.chain_id, chain.revision, { head: chain.published_head, review_ids: [7], feedback_digest: "d".repeat(64) }, now);
  refused(f, () => renewal(f).replace(), "state_denied");
  const child = secondChain(f).v1.root_mission_id;
  const dispatched = store.dispatch(chain.chain_id, reserved.chain.revision, chain.published_head, child, now).chain;
  const { intent, chain: publishing } = store.recordIntent(chain.chain_id, dispatched.revision, { kind: "push", branch: chain.branch,
    expected_old_head: chain.published_head, new_head: "9".repeat(40), expected_base_sha: chain.published_base, child_mission_id: child }, now);
  store.stopLive(chain.chain_id, publishing.revision, "grant_expired", now);
  refused(f, () => renewal(f).replace(), "intent_unsettled");
  store.settleIntent(intent.intent_id, "uncertain", now, "test");
  refused(f, () => renewal(f).replace(), "intent_unsettled");
});

it.each(["reserved","running","stop_unknown","stopped"])("checks a %s intake", state => {
  const f = fixture();
  const r = f.store.register(f.input);
  const admitted = f.store.admit(r.request_id, r.revision, f.facts);
  if (admitted.status !== "admitted") throw Error(admitted.reason);
  const id = admitted.intake.intake_id;
  if (state === "running") f.store.intakes.start(id, 1);
  if (state === "stop_unknown") f.store.intakes.markStopUnknown(id, 1, "test");
  if (state === "stopped") f.store.intakes.settleNotStarted(id, 1);
  const { replace } = renewal(f);
  if (state === "stopped") expect(replace().chain.revision).toBe(2);
  else refused(f, replace, "grant_renewal_busy");
});
it.each(["reserved","running","stop_unknown","stopped"])("checks a %s recheck run", state => {
  const d = publishedRecheck({ rounds: 2, recheck: { timeout_seconds: 12 } });
  d.recordConfirmation();
  d.confirm();
  const { runs, input } = runFixture(d, d.open());
  const { run } = runs.reserve(input);
  if (state === "running") runs.start(run.run_id, 1);
  if (state === "stop_unknown") runs.markStopUnknown(run.run_id, 1);
  if (state === "stopped") runs.settleNotStarted(run.run_id, 1, "verify_recheck_not_started");
  const { replace, chain } = renewal(d.f);
  if (state === "stopped") expect(replace().chain.revision).toBe(chain.revision + 1);
  else refused(d.f, replace, "grant_renewal_busy");
});
it.each(["executing", "settled", "gate", "approved", "obligation", "later halt", "missing halt"])("checks child at %s", state => {
  const { f, dispatch } = dispatchedRepair();
  const child = dispatch.child_mission_id;
  const missions = new ContainedMissionStore(f.attention, f.owner);
  f.db.prepare("UPDATE engineering_contained_missions SET state=?,stop_obligation=?,revision=revision+1 WHERE mission_id=?")
    .run(state === "executing" ? "executing" : state === "settled" ? "failed" : "awaiting_decision", state === "obligation" ? 1 : 0, child);
  if (state !== "missing halt") missions.record(child, "halted", { reason: "publication_pending" }, now);
  if (state === "approved") missions.record(child, "verify_repair_approval", {}, now);
  if (state === "later halt") missions.record(child, "halted", {}, now);
  const { replace, chain } = renewal(f);
  if (state === "gate" || state === "settled") expect(replace().chain.revision).toBe(chain.revision + 1);
  else refused(f, replace, "grant_renewal_busy");
});
it("rejects absent or malformed JSON terms on direct writes", () => {
  const f = fixture({ recheck: { timeout_seconds: 10 } });
  const { raw, sign } = renewal(f);
  const next = sign(), opt = next.local_failure;
  for (const version of [null, undefined, "2"]) refused(f, () => raw({ ...next, version }), "grant_not_monotonic");
  for (const enabled of [undefined, 1, false]) refused(f, () => raw({ ...next, local_failure: { ...opt, enabled } }), "grant_not_monotonic");
  for (const value of [undefined, null, "100", true, {}]) {
    refused(f, () => raw({ ...next, local_failure: { ...opt, diagnostic_timeout_seconds: value } }), "grant_not_monotonic");
    refused(f, () => raw({ ...next, local_failure: { ...opt, recheck: { enabled: true, timeout_seconds: value } } }), "grant_not_monotonic");
  }
  const { store, chain } = renewal(f);
  const shadow = store.createShadowChain(chain, now);
  raw(JSON.parse(shadow.grant_json), shadow.chain_id);
  refused(f, () => raw(next, shadow.chain_id), "grant_shadow_fixed");
});
it("refuses ambiguous duplicate fields in a direct V2 write", () => {
  const f = fixture();
  const { chain, sign } = renewal(f);
  const json = JSON.stringify(sign()).replace('"version":2', '"version":2,"version":1');
  refused(f, () => f.db.prepare("UPDATE engineering_revision_chains SET grant_json=?,revision=revision+1 WHERE chain_id=?")
    .run(json, chain.chain_id), "grant_not_monotonic");
});
it("upgrades a populated schema 63 with only one new trigger", () => {
  const d = publishedRecheck({ legacy: 63, rounds: 2 });
  d.recordConfirmation();
  d.confirm();
  const { runs, input } = runFixture(d, d.open());
  runs.reserve(input);
  secondChain(d.f);
  const { db, path } = d.f;
  const objects = (conn: typeof db) => conn.prepare("SELECT name,type,sql FROM sqlite_schema ORDER BY name").all() as {name:string;type:string}[];
  const schema = objects(db);
  const rows = (conn: typeof db) => schema.filter(o => o.type === "table").map(o => conn.prepare(`SELECT * FROM "${o.name}"`).all());
  const before = rows(db);
  db.close();
  const migrated = openDb({ path });
  try {
    expect(migrated.pragma("user_version", { simple: true })).toBe(65);
    expect(objects(migrated).filter(o => ![trigger, "decision_probes", "decision_probes_answer_id", "decision_probes_pending_expiry"].includes(o.name))).toEqual(schema);
    expect(objects(migrated).find(o => o.name === trigger)?.type).toBe("trigger");
    expect(rows(migrated)).toEqual(before);
  } finally { migrated.close(); }
});
