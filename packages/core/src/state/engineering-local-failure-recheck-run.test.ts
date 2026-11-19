import { AttentionStore } from "./attention-store.js";
import { randomUUID } from "node:crypto";
import { DiagnosisStore } from "./engineering-diagnosis-store.js";
import { expect, it } from "vitest";
import { withdrawalVerificationFixture } from "../bridge/verification-result-fixtures.js";
import { canonicalJson } from "../bridge/revision-grant.js";
import { localVerificationReceiptDigest } from "../bridge/local-failure.js";
import { openDb } from "./db.js";
import { LocalFailureRecheckRunStore } from "./engineering-local-failure-recheck-run-store.js";
import { RevisionChainStore } from "./engineering-revision-chain-store.js";
import { checkRootAdmission } from "./engineering-root-admission.js";
import { publishedRecheck, record, runFixture } from "./local-failure-recheck.testkit.js";
import { recheckRunObjects } from "./diagnosis-fixtures.js";

const table = "engineering_local_failure_recheck_runs";
function setup() {
  const d = publishedRecheck({ rounds: 2 });
  d.recordConfirmation();
  d.confirm();
  const row = d.open();
  return { ...d, row, ...runFixture(d, row) };
}

it("copies the published binding and returns a replay without writing", () => {
  const { f, row, chain, runs, input } = setup();
  const badInput = { ...input, head_sha: "wrong", skill_id: "wrong", conclusion_state: "host_passed" };
  const { run, created } = f.store.transaction(() => runs.reserve(badInput));
  expect(created).toBe(true);
  for (const k of [
    "recheck_id",
    "dispatch_id",
    "root_mission_id",
    "child_mission_id",
    "chain_id",
    "intake_id",
    "repository",
    "repository_id",
    "pr_number",
    "base_sha",
    "profile_id",
    "profile_digest",
    "trusted_source_digest",
    "skill_id",
    "skill_version",
    "skill_blob",
    "skill_manifest_digest",
    "original_result_id",
    "original_source_seq",
    "failed_check_id",
    "original_checks_json"
  ] as const)
    expect(run[k], k).toEqual(row[k]);
  expect(run).toMatchObject({
    head_sha: row.new_head_sha,
    branch: chain().branch,
    base_ref: chain().base_ref,
    chain_revision: chain().revision,
    attempt: 1,
    state: "reserved",
    conclusion_state: null
  });
  const changes = f.db.prepare("SELECT total_changes()").pluck(),
    before = changes.get();
  expect(runs.reserve({ ...input, invocation_id: "different" })).toEqual({ run, created: false });
  expect(changes.get()).toBe(before);
  expect(() => f.store.transaction(() => runs.start(run.run_id, 1))).toThrow("recheck_run_nested_launch");
  expect(() => runs.start(run.run_id, 2)).toThrow("version_conflict");
  expect(runs.get(run.run_id)).toEqual(run);
});

function insertReview(d: ReturnType<typeof setup>) {
  d.f.db
    .prepare(`INSERT INTO engineering_revision_reservations(repository,pr_number,head_sha,chain_id,review_ids_json,feedback_digest,state,created_at,updated_at)
    VALUES(?,?,?,?,'[1]',?,'reserved',1,1)`)
    .run(d.row.repository, d.row.pr_number, d.row.new_head_sha, d.row.chain_id, "a".repeat(64));
}
function insertActions(d: ReturnType<typeof setup>) {
  d.f.db
    .prepare(`INSERT INTO engineering_contained_missions(mission_id,scope_id,owner_principal_id,owner_client_session_id,spec_digest,spec_json,state,revision,created_at,updated_at)
    SELECT ?,scope_id,owner_principal_id,owner_client_session_id,spec_digest,?,'authorized',1,created_at,updated_at FROM engineering_contained_missions WHERE mission_id=?`)
    .run(`cm_${randomUUID()}`, JSON.stringify({ ci_repair: { root: d.row.root_mission_id } }), d.row.root_mission_id);
}
it.each([
  ["missing", "recheck_run_state_denied"],
  ["sealed", "recheck_run_state_denied"],
  ["withdrawn", "verify_withdrawn"],
  ["head", "verify_stale_head"],
  ["base", "verify_base_changed"],
  ["digest", "recheck_run_grant_mismatch"],
  ["grant", "recheck_run_grant_mismatch"],
  ["review", "verify_chain_busy"],
  ["intake", "verify_chain_busy"],
  ["actions", "verify_chain_busy"],
  ["budget", "verify_budget_exhausted"]
])("refuses reservation for %s", (condition, code) => {
  const d = setup(),
    { f, row, input, runs } = d;
  switch (condition) {
    case "missing":
      input.recheck_id = "missing";
      break;
    case "sealed":
      d.ledger.evaluate({ recheck_id: row.recheck_id, now: d.now, result: d.add({ skill_version: "2.0.0" }) });
      break;
    case "withdrawn":
      record(f, withdrawalVerificationFixture());
      break;
    case "head":
      f.db.exec("UPDATE engineering_revision_chains SET published_head=published_base,revision=revision+1");
      break;
    case "base":
      f.db.exec("UPDATE engineering_revision_chains SET published_base=published_head,revision=revision+1");
      break;
    case "digest":
      input.grant_digest = "0".repeat(64);
      break;
    case "grant":
      input.grant_id = "other";
      break;
    case "review":
      insertReview(d);
      break;
    case "actions":
      insertActions(d);
      break;
    case "intake":
      f.store.intakes.reserve({
        ...f.store.intakes.get(row.intake_id),
        intake_id: `lfi_${randomUUID()}`,
        invocation_id: randomUUID(),
        head_sha: row.new_head_sha,
        chain_revision: d.chain().revision
      });
      break;
    case "budget":
      input.container_cap_seconds = f.facts.grant.budget.max_container_seconds;
      break;
  }
  expect(() => runs.reserve(input)).toThrow(code);
  expect(runs.forRecheck(row.recheck_id)).toEqual([]);
});

it("releases provably unstarted attempts and caps them at three", () => {
  const { runs, input } = setup();
  for (const attempt of [1, 2, 3]) {
    const { run, created } = runs.reserve({ ...input, invocation_id: randomUUID() });
    expect(created).toBe(true);
    expect(run.attempt).toBe(attempt);
    // @ts-expect-error a JavaScript caller cannot choose another conclusion
    expect(() => runs.settleNotStarted(run.run_id, 1, "verify_stale_head")).toThrow("recheck_run_state_denied");
    const reason = attempt === 1 ? "verify_profile_unavailable" : "verify_recheck_not_started";
    expect(runs.settleNotStarted(run.run_id, 1, reason)).toMatchObject({
      outcome: "not_started",
      container_used_seconds: 0,
      receipt_id: null,
      proof_ref: "journal:not_started:" + run.invocation_id,
      conclusion_state: "awaiting_decision",
      conclusion_reason: reason
    });
    expect(runs.active(input.recheck_id)).toBeUndefined();
    expect(runs.hostProof(input.recheck_id)).toBeNull();
  }
  expect(runs.forRecheck(input.recheck_id).map((r) => r.attempt)).toEqual([1, 2, 3]);
  expect(() => runs.reserve(input)).toThrow("recheck_run_attempts_exhausted");
});

it("keeps all four writers excluded until stop and charges only settled usage", () => {
  const d = setup(),
    { f, row, runs, input, settle } = d;
  const chains = new RevisionChainStore(f.attention, f.owner);
  const left = () => chains.remainingBudget(row.chain_id).container_seconds;
  const before = left();
  const admission = (kind: Parameters<typeof checkRootAdmission>[2], seconds = 1) =>
    f.store.transaction(() =>
      checkRootAdmission(f.db, row.root_mission_id, kind, { chain_id: row.chain_id, container_seconds: seconds })
    );
  // Capture a valid raw intake insert on this head before reserving the run.
  f.db.exec("BEGIN IMMEDIATE");
  const intake = f.store.intakes.reserve({ ...f.store.intakes.get(row.intake_id), intake_id: `lfi_${randomUUID()}`,
    invocation_id: randomUUID(), head_sha: row.new_head_sha, chain_revision: d.chain().revision });
  f.db.exec("ROLLBACK");
  const columns = Object.keys(intake);
  const insertIntake = f.db.prepare(`INSERT INTO engineering_local_failure_intakes (${columns.join(",")})
    VALUES (${columns.map(c=>"@"+c).join(",")})`);
  const inserts = [
    () => insertReview(d),
    () => insertActions(d),
    () => insertIntake.run(intake),
    () =>
      f.db.exec("INSERT INTO engineering_local_failure_dispatches SELECT * FROM engineering_local_failure_dispatches")
  ];
  const { run } = runs.reserve(input);
  for (const state of ["reserved", "running", "stop_unknown"] as const) {
    if (state === "running") runs.start(run.run_id, 1);
    if (state === "stop_unknown") runs.markStopUnknown(run.run_id, 2);
    for (const kind of ["review", "actions_repair", "local_failure", "recheck"] as const)
      expect(admission(kind)).toEqual({ ok: false, code: "verify_chain_busy", holder: "recheck" });
    for (const [i, insert] of inserts.entries())
      expect(insert).toThrow(i === 0 ? /^chain_busy$/ : /^verify_chain_busy$/);
    expect(left()).toBe(before - input.container_cap_seconds);
    expect(runs.reserve(input)).toEqual({ created: false, run: runs.get(run.run_id) });
  }
  settle(runs.get(run.run_id));
  expect(left()).toBe(before - 2);
  for (const kind of ["review", "actions_repair", "local_failure", "recheck"] as const) {
    expect(admission(kind, left())).toEqual({ ok: true });
    expect(admission(kind, left() + 1)).toMatchObject({ code: "verify_budget_exhausted" });
  }
  // The original dispatch journal still prohibits a second dispatch on this root.
  for (const [i, insert] of inserts.entries()) {
    f.db.exec("SAVEPOINT probe");
    try {
      if (i < 3) expect(insert).not.toThrow();
      else expect(insert).toThrow(/dispatch_/);
    } finally {
      f.db.exec("ROLLBACK TO probe; RELEASE probe");
    }
  }
});

it.each([
  ["passed", "host_passed", null],
  ["reproducible_failure", "awaiting_decision", "verify_recheck_host_failed"],
  ["infrastructure_error", "awaiting_decision", "verify_infrastructure_error"],
  ["timeout", "awaiting_decision", "verify_infrastructure_error"],
  ["cancelled", "awaiting_decision", "verify_infrastructure_error"]
] as const)("settles %s once with its canonical receipt and conclusion", (outcome, state, reason) => {
  const { f, runs, input, receipt, settle } = setup();
  const { run } = runs.reserve(input),
    running = runs.start(run.run_id, 1);
  const expected = receipt(running, outcome);
  const stopped = settle(running, outcome);
  expect(stopped).toMatchObject({
    outcome,
    receipt_digest: localVerificationReceiptDigest(expected),
    receipt_json: canonicalJson(expected),
    evidence_digest: expected.evidence_digest,
    proof_ref: expected.stop.proof_ref,
    proof_digest: expected.stop.proof_digest,
    conclusion_state: state,
    conclusion_reason: reason
  });
  expect(runs.reserve(input)).toEqual({ run: stopped, created: false });
  if (outcome === "passed") {
    const proof = runs.hostProof(input.recheck_id);
    expect(proof).toMatchObject({ receipt_id: stopped.receipt_id, receipt_digest: stopped.receipt_digest });
    expect(new LocalFailureRecheckRunStore(f.store).hostProof(input.recheck_id)).toEqual(proof);
  } else expect(runs.hostProof(input.recheck_id)).toBeNull();
  for (const change of ["receipt_digest=profile_digest", "conclusion_reason='verify_stop_unproven'", "reason='change'"])
    expect(() => f.db.exec(`UPDATE ${table} SET ${change},revision=revision+1`)).toThrow("recheck_run_immutable");
});

it.each(["head", "base", "withdrawn", "unknown"] as const)("preserves the receipt when %s intervenes", (cause) => {
  const { f, runs, input, settle } = setup(),
    { run } = runs.reserve(input);
  let running = runs.start(run.run_id, 1);
  if (cause === "head")
    f.db.exec("UPDATE engineering_revision_chains SET published_head=published_base,revision=revision+1");
  if (cause === "base")
    f.db.exec("UPDATE engineering_revision_chains SET published_base=published_head,revision=revision+1");
  if (cause === "withdrawn") record(f, withdrawalVerificationFixture());
  if (cause === "unknown") {
    running = runs.markStopUnknown(run.run_id, 2);
    record(f, withdrawalVerificationFixture());
    expect(() => f.db.exec(`UPDATE ${table} SET conclusion_reason='verify_withdrawn',revision=revision+1`)).toThrow(
      "recheck_run_immutable"
    );
  }
  expect(settle(running)).toMatchObject({
    outcome: "passed",
    conclusion_state: cause === "withdrawn" ? "closed" : "awaiting_decision",
    conclusion_reason: {
      head: "verify_stale_head",
      base: "verify_base_changed",
      withdrawn: "verify_withdrawn",
      unknown: "verify_stop_unproven"
    }[cause]
  });
  expect(runs.hostProof(input.recheck_id)).toBeNull();
});

it.each([
  "head",
  "withdrawn",
  "receipt_json",
  "receipt_digest",
  "malformed JSON"
] as const)("withholds a previously available proof after %s changes", (cause) => {
  const { f, runs, input, settle } = setup(),
    { run } = runs.reserve(input);
  settle(runs.start(run.run_id, 1));
  expect(runs.hostProof(input.recheck_id)).not.toBeNull();
  if (cause === "head")
    f.db.exec("UPDATE engineering_revision_chains SET published_head=published_base,revision=revision+1");
  else if (cause === "withdrawn") record(f, withdrawalVerificationFixture());
  else {
    // Disable the two update guards on this isolated database to simulate damaged durable evidence.
    f.db.exec(
      "DROP TRIGGER engineering_local_failure_recheck_run_fixed; DROP TRIGGER engineering_local_failure_recheck_run_flow"
    );
    if (cause === "malformed JSON") {
      f.db.pragma("ignore_check_constraints=ON");
      f.db.prepare(`UPDATE ${table} SET receipt_json=?`).run("{");
      f.db.pragma("ignore_check_constraints=OFF");
    } else f.db.prepare(`UPDATE ${table} SET ${cause}=?`).run(cause === "receipt_json" ? "{}" : "a".repeat(64));
  }
  expect(runs.hostProof(input.recheck_id)).toBeNull();
});

it("rejects invalid transitions, modified bindings and invalid receipts atomically", () => {
  const { f, runs, input, receipt, settle } = setup(),
    { run } = runs.reserve(input);
  expect(() => settle(run)).toThrow("recheck_run_state_denied");
  expect(() => f.db.exec(`DELETE FROM ${table}`)).toThrow("recheck_run_immutable");
  expect(() => f.db.exec(`REPLACE INTO ${table} SELECT * FROM ${table}`)).toThrow("recheck_run_reused");
  for (const field of [
    "skill_id",
    "repository",
    "grant_id",
    "head_sha",
    "tree_sha",
    "original_checks_json",
    "owner_home",
    "journal_ref"
  ])
    expect(() =>
      f.db.exec(`UPDATE ${table} SET ${field}='other',state='running',started_at=updated_at,revision=revision+1`)
    ).toThrow("recheck_run_immutable");
  const running = runs.start(run.run_id, 1);
  expect(() => runs.start(run.run_id, 2)).toThrow("recheck_run_state_denied");
  expect(() => runs.settleNotStarted(run.run_id, 2, "verify_recheck_not_started")).toThrow("recheck_run_state_denied");
  const good = receipt(running);
  for (const patch of [
    { branch: "other" },
    { started_at: good.started_at - 1 },
    { finished_at: good.started_at - 1 },
    {}
  ]) {
    expect(() =>
      runs.settleStopped(run.run_id, 2, {
        receipt: { ...good, ...patch },
        run_identity_digest: "a".repeat(64),
        container_used_seconds: Object.keys(patch).length ? 0 : run.container_cap_seconds + 1
      })
    ).toThrow("recheck_run_receipt_binding_invalid");
    expect(runs.get(run.run_id)).toEqual(running);
  }
  const unknown = runs.markStopUnknown(run.run_id, 2);
  expect(() => runs.markStopUnknown(run.run_id, 3)).toThrow("recheck_run_state_denied");
  expect(() => runs.start(run.run_id, 3)).toThrow("recheck_run_state_denied");
  expect(() => runs.settleNotStarted(run.run_id, 3, "verify_profile_unavailable")).toThrow("recheck_run_state_denied");
  const stopped = settle(unknown);
  for (const change of [
    () => runs.markStopUnknown(run.run_id, 4),
    () => runs.start(run.run_id, 4),
    () => settle(stopped)
  ])
    expect(change).toThrow();
  expect(runs.get(run.run_id)).toEqual(stopped);
});

it("retains exclusion when a reservation enters stop_unknown without a launch timestamp", () => {
  const { runs, input } = setup(),
    { run } = runs.reserve(input);
  expect(runs.markStopUnknown(run.run_id, 1)).toMatchObject({ state: "stop_unknown", started_at: null });
  expect(runs.reserve(input).created).toBe(false);
});

it("migrates a populated schema 62 ledger without rewriting existing rows or objects", () => {
  const d = publishedRecheck({ legacy: 62 });
  d.recordConfirmation();
  d.confirm();
  d.open();
  const { db, path } = d.f;
  const objects = (conn: typeof db) =>
    conn.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all() as { name: string; type: string }[];
  const schema = objects(db),
    tables = schema.filter((o) => o.type === "table");
  const rows = (conn: typeof db) => tables.map((t) => conn.prepare(`SELECT * FROM "${t.name}"`).all());
  const before = rows(db);
  db.close();
  const next = openDb({ path });
  try {
    const after = objects(next);
    expect(next.pragma("user_version", { simple: true })).toBe(63);
    expect(after.filter((o) => schema.some((p) => p.name === o.name))).toEqual(schema);
    expect(after.filter((o) => !schema.some((p) => p.name === o.name)).map((o) => o.name)).toEqual(
      [...recheckRunObjects].sort()
    );
    expect(rows(next)).toEqual(before);
    expect(next.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
  } finally {
    next.close();
  }
});

it.each(["revision", "ledger", "withdrawn", "owner"] as const)("fences launch after %s changes", (change) => {
  const d = setup(),
    { f, runs, input } = d,
    { run } = runs.reserve(input);
  let launcher = runs;
  if (change === "revision") f.db.exec("UPDATE engineering_revision_chains SET revision=revision+1");
  if (change === "ledger")
    d.ledger.evaluate({ recheck_id: d.row.recheck_id, now: d.now, result: d.add({ skill_version: "9.9.9" }) });
  if (change === "withdrawn") record(f, withdrawalVerificationFixture());
  if (change === "owner")
    launcher = new LocalFailureRecheckRunStore(
      new DiagnosisStore(f.attention, f.attention.claimOwner("replacement")),
      () => d.now
    );
  expect(() => launcher.start(run.run_id, 1)).toThrow(
    change === "withdrawn" ? "verify_withdrawn" : "recheck_run_start_denied"
  );
  expect(launcher.get(run.run_id)).toEqual(run);
  if (change === "owner")
    expect(launcher.settleNotStarted(run.run_id, 1, "verify_recheck_not_started").state).toBe("stopped");
});

it("checks each copied binding and insert fence even on direct SQL", () => {
  const { f, runs, input } = setup();
  f.db.exec("BEGIN IMMEDIATE");
  const { run } = runs.reserve(input);
  f.db.exec("ROLLBACK");
  const cols = Object.keys(run);
  const insert = f.db.prepare(
    `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`
  );
  for (const key of [
    "recheck_id",
    "dispatch_id",
    "root_mission_id",
    "child_mission_id",
    "chain_id",
    "intake_id",
    "repository",
    "repository_id",
    "pr_number",
    "head_sha",
    "base_sha",
    "profile_id",
    "profile_digest",
    "trusted_source_digest",
    "skill_id",
    "skill_version",
    "skill_blob",
    "skill_manifest_digest",
    "original_result_id",
    "original_source_seq",
    "failed_check_id",
    "original_checks_json",
    "chain_revision",
    "branch",
    "base_ref",
    "grant_id"
  ] as const) {
    const value = run[key];
    expect(() => insert.run({ ...run, [key]: typeof value === "number" ? value + 1 : "different" }), key).toThrow(
      "recheck_run_binding_denied"
    );
  }
  for (const patch of [
    { attempt: 2 },
    { revision: 2 },
    { owner_instance: "other" },
    { writer_instance: "other" },
    { state: "running" },
    { receipt_json: "{}" },
    { conclusion_state: "host_passed" }
  ])
    expect(() => insert.run({ ...run, ...patch })).toThrow("recheck_run_insert_denied");
  expect(() => insert.run({ ...run, container_cap_seconds: f.facts.grant.budget.max_container_seconds })).toThrow(
    "verify_budget_exhausted"
  );
  expect(insert.run(run).changes).toBe(1);
});

it("reissues the same proof after reopening the database with a new owner", () => {
  const { f, runs, input, settle } = setup(),
    { run } = runs.reserve(input);
  settle(runs.start(run.run_id, 1));
  const proof = runs.hostProof(input.recheck_id);
  expect(proof).not.toBeNull();
  f.db.close();
  const db = openDb({ path: f.path });
  try {
    db.pragma("synchronous=FULL");
    const attention = new AttentionStore(db, f.path);
    const restored = new LocalFailureRecheckRunStore(new DiagnosisStore(attention, attention.claimOwner("restart")));
    const changes = db.prepare("SELECT total_changes()").pluck(),
      before = changes.get();
    expect(restored.hostProof(input.recheck_id)).toEqual(proof);
    expect(changes.get()).toBe(before);
  } finally {
    db.close();
  }
});
