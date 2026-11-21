import { createHash, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideVerificationSources, parseVerificationResultV1, type VerificationSourceObservation, type VerificationSourceRecord,
} from "@osstack/core/verification-publish";
import { afterEach, expect, it } from "vitest";
import { createFileAttemptLedger, type AttemptLedger, type AttemptLedgerEntry } from "./attempt-ledger.js";
import { abandonVerification, publishVerification, type PublishOutcome } from "./publish.js";
import { config, FakeGithub, marker, now, request, uuid } from "./testkit/fixtures.js";

const path = join(tmpdir(), randomUUID());
afterEach(async () => { await rm(path, { force: true }); await rm(path + ".lock", { force: true }); });
function setup() {
  const github = new FakeGithub(), binding = config(), file = createFileAttemptLedger(path);
  let failAppend: AttemptLedgerEntry["kind"] | null = null;
  let next = 100;
  const ledger: AttemptLedger = { withLock: action => file.withLock(s => action({
    get entries() { return s.entries; },
    async append(e) {
      if (e.kind === failAppend) { failAppend = null; throw new Error(marker); }
      await s.append(e);
    },
  })) };
  const deps = { github, ledger, now, uuid: () => uuid(next++) };
  const signal = new AbortController().signal;
  const safe = (outcome: PublishOutcome) => { expect(JSON.stringify(outcome)).not.toContain(marker); return outcome; };
  return { github, binding, deps, signal, fault: (kind: AttemptLedgerEntry["kind"]) => { failAppend = kind; },
    entries: () => file.withLock(async s => s.entries),
    publish: (q: unknown = request(), operator = false) => publishVerification(deps, binding, q, { signal, operator }).then(safe),
    abandon: (id = uuid(2)) => abandonVerification(deps, binding, id, { signal }).then(safe) };
}
const refused = (reason: string, detail: string | null = null) => ({ ok: false, reason, detail });

it.each([["passed", "success"], ["failed", "failure"], ["blocked", "action_required"]] as const)(
  "publishes one completed %s result", async (outcome, conclusion) => {
    const h = setup(), q = request(outcome);
    expect(await h.publish(q)).toEqual({ ok: true, status: "published", result_id: uuid(100), attempt: 1, check_run_id: 1 });
    expect(h.github.writes).toBe(1);
    const run = h.github.runs[0]!;
    expect(run).toMatchObject({ name: "osstack/verify-intake/fixture-skill", head_sha: q.head_sha, external_id: uuid(100),
      status: "completed", conclusion });
    expect(parseVerificationResultV1(run.output.text)).toMatchObject({ ok: true, result: { attempt: 1, outcome, generated_at: "2026-11-16T12:02:00Z" } });
    expect(await h.entries()).toMatchObject([{ kind: "intent", text: run.output.text }, { kind: "published", check_run_id: 1 }]);
    expect(h.github.signals.every(s => s === h.signal)).toBe(true);
    const gets = h.github.paths.length;
    expect(await h.publish(q)).toMatchObject({ status: "already_published", attempt: 1, check_run_id: 1, result_id: uuid(100) });
    expect(h.github.paths).toHaveLength(gets);
    expect(h.github.writes).toBe(1);
  });

it("allows a fresh attempt after failure to store the intent", async () => {
  const h = setup();
  h.fault("intent");
  expect(await h.publish()).toEqual(refused("ledger_unavailable"));
  expect(h.github.writes).toBe(0);
  expect(await h.entries()).toEqual([]);
  expect(await h.publish()).toMatchObject({ status: "published", attempt: 1 });
  expect(h.github.writes).toBe(1);
});

it("keeps an unconfirmed intent open until the operator confirms absence", async () => {
  const h = setup();
  h.github.throwCreate = 1;
  expect(await h.publish()).toEqual(refused("write_unconfirmed"));
  expect(await h.publish()).toEqual(refused("write_unconfirmed"));
  const next = request("passed", 3);
  expect(await h.publish(next)).toEqual(refused("unresolved_intent", uuid(2)));
  expect(h.github.writes).toBe(1);
  expect(await h.abandon()).toEqual({ ok: true, status: "abandoned", result_id: uuid(100), attempt: 1, check_run_id: null });
  expect(await h.abandon()).toEqual(refused("not_open"));
  expect(await h.publish()).toEqual(refused("invocation_abandoned"));
  expect(await h.publish(next)).toMatchObject({ status: "published", attempt: 1 });
  expect(h.github.writes).toBe(2);
});

it.each(["publish", "abandon"] as const)("recovers via %s after resolution append fails", async command => {
  const h = setup();
  h.fault("published");
  expect(await h.publish()).toEqual(refused("ledger_unavailable"));
  expect(await h.entries()).toHaveLength(1);
  expect(await h[command]()).toMatchObject({ status: "recovered", check_run_id: 1, attempt: 1 });
  expect(h.github.writes).toBe(1);
  expect(await h.abandon()).toEqual(refused("not_open"));
});

it("confirms a stored write even when the create reply is lost", async () => {
  const h = setup();
  h.github.lostReply = true;
  expect(await h.publish()).toMatchObject({ status: "published" });
  expect(h.github.writes).toBe(1);
});

it.each(["head_moved", "base_moved", "fork_id", "fork_null", "pr_not_open", "repo_off", "skill_off",
  "name_wrong", "number_wrong", "base_id_wrong", "unusable", "get_throw", "get_fail", "bad_request", "bad_invocation", "bad_exit", "lock"])(
  "refuses %s before any write", async scenario => {
    const h = setup(), q = request(), pr = h.github.pr;
    let body: unknown = q, reason = scenario, detail = null;
    switch (scenario) {
      case "head_moved": pr.head.sha = "f".repeat(40); break;
      case "base_moved": pr.base.sha = "e".repeat(40); break;
      case "fork_id": pr.head.repo = { id: 102 }; reason = "fork"; break;
      case "fork_null": pr.head.repo = null; reason = "fork"; break;
      case "pr_not_open": pr.state = "closed"; break;
      case "repo_off": q.repository_id++; reason = "not_allowlisted"; break;
      case "skill_off": q.skill_id += "-other"; reason = "not_allowlisted"; break;
      case "name_wrong": pr.base.repo.full_name += "-other"; reason = "scope_mismatch"; break;
      case "number_wrong": pr.number++; reason = "scope_mismatch"; break;
      case "base_id_wrong": pr.base.repo.id++; reason = "scope_mismatch"; break;
      case "unusable": pr.head.sha = marker; reason = "read_failed"; break;
      case "get_throw": h.github.throwGet = 1; reason = "read_failed"; break;
      case "get_fail": h.github.failGet = 1; reason = "read_failed"; break;
      case "bad_request": body = null; reason = "request_invalid"; break;
      case "bad_invocation": body = { ...q, record: { invocation_id: 1 } }; reason = "request_invalid"; break;
      case "bad_exit": q.record.checks[0]!.exit = 1; reason = "build_refused"; detail = "builder_outcome_inconsistent"; break;
      case "lock": await writeFile(path + ".lock", ""); reason = "ledger_unavailable"; break;
    }
    expect(await h.publish(body)).toEqual(refused(reason, detail));
    expect(h.github.writes).toBe(0);
  });

it.each(["automatic", "skill_version", "skill_blob", "skill_manifest_digest", "profile_id", "profile_digest",
  "repository", "commit_sha", "artifact_digest", "missing_check"] as const)("holds the binding and original checks for %s", async field => {
  const h = setup();
  expect(await h.publish(request("failed"))).toMatchObject({ status: "published" });
  const b = h.binding.allow[0]!, q = request("passed", 3);
  let reason = "binding_changed";
  if (field === "automatic") reason = "already_verified";
  else if (field === "missing_check") {
    reason = "original_check_missing";
    q.head_sha = h.github.pr.head.sha = "f".repeat(40);
    q.record.checks[0]!.check_id = "other-check";
  } else if (field === "repository" || field === "commit_sha" || field === "artifact_digest") {
    b.trusted_source[field] = field === "repository" ? "fixture-owner/other" : "0".repeat(b.trusted_source[field].length);
  } else {
    b[field] = field === "skill_version" ? "2.0.0" : field === "profile_id" ? "other" : "0".repeat(b[field].length);
  }
  expect(await h.publish(q, field !== "automatic")).toEqual(refused(reason));
  expect(h.github.writes).toBe(1);
});

it.each(["text", "name", "head_sha", "external_id", "status", "conclusion", "app", "id", "multiple",
  "bad_count", "over_limit", "list_failure", "detail_failure"] as const)("keeps the intent open for %s", async fault => {
  const h = setup();
  h.github.failGet = 2;
  expect(await h.publish()).toEqual(refused("write_unconfirmed"));
  const run = h.github.runs[0]!;
  h.github.listOverride = { total_count: 1, check_runs: [structuredClone(run)] };
  let reason = "readback_mismatch";
  if (fault === "multiple") h.github.listOverride = { total_count: 2, check_runs: [run, run] };
  else if (fault === "bad_count" || fault === "over_limit") {
    h.github.listOverride = fault === "bad_count" ? { total_count: 1, check_runs: [] } : { total_count: 101, check_runs: Array(101).fill(run) };
    reason = "read_failed";
  } else if (fault === "list_failure" || fault === "detail_failure") {
    h.github.throwGet = h.github.paths.length + (fault === "list_failure" ? 1 : 2);
    reason = "read_failed";
  } else if (fault === "text") run.output.text += marker;
  else if (fault === "app") run.app.id++;
  else if (fault === "id") {
    // Return a different object id from the requested detail route.
    const get = h.github.get.bind(h.github);
    h.github.get = async (p, opts) => p.endsWith("/check-runs/1") ? { ok: true, body: { ...run, id: 2 } } : get(p, opts);
  } else Object.assign(run, { [fault]: marker });
  expect(await h.publish()).toEqual(refused(reason));
  if (reason === "readback_mismatch") expect(await h.abandon()).toEqual(refused(reason));
  expect(await h.entries()).toHaveLength(1);
  expect(h.github.writes).toBe(1);
});

function observed(run: FakeGithub["runs"][number]) {
  const parsed = parseVerificationResultV1(run.output.text);
  if (!parsed.ok) throw new Error(parsed.code);
  const r = parsed.result;
  return { source_kind: "check_run", object_id: run.id, repository_id: r.repository_id, repository: r.repository, pr: r.pr,
    observed_head_sha: r.head_sha, app_id: run.app.id, check_name: run.name, response_digest: r.result_id,
    contract_digest: createHash("sha256").update(run.output.text).digest("hex"), verdict: { ok: true }, result: r } satisfies VerificationSourceObservation;
}

it.each(["expired", "recheck"] as const)("builds an attempt accepted by the host after %s", async scenario => {
  const h = setup(), next = request("passed", 3);
  expect(await h.publish(request("failed"))).toMatchObject({ status: "published", attempt: 1 });
  if (scenario === "recheck") next.head_sha = h.github.pr.head.sha = "f".repeat(40);
  const attempt = scenario === "expired" ? 2 : 1;
  expect(await h.publish(next, scenario === "expired")).toMatchObject({ status: "published", attempt });
  const first = observed(h.github.runs[0]!), second = observed(h.github.runs[1]!);
  expect(second.result).toMatchObject({ attempt, supersedes_result_id: null });
  const r = first.result;
  const history: VerificationSourceRecord[] = [{ ...first, seq: 1, pr_number: r.pr, result_id: r.result_id, attempt: r.attempt,
    skill_id: r.skill_id, outcome: r.outcome, head_sha: r.head_sha, base_sha: r.base_sha, dedup_key: r.dedup_key,
    withdraws_result_id: null, supersedes_result_id: null, decision: scenario === "expired" ? "rejected" : "accepted",
    reason_code: scenario === "expired" ? "verify_result_expired" : null, original_seq: null, withdraws_seq: null,
    summary: r.summary, intake_id: null, observed_at: 0, recorded_at: 0 }];
  expect(decideVerificationSources(history, [second])[0]!.outcome.decision).toBe("accepted");
});

it("returns the host's closed refusal before storing or writing a conflicting result", async () => {
  const h = setup();
  expect(await h.publish()).toMatchObject({ status: "published" });
  h.deps.uuid = () => uuid(100);
  expect(await h.publish(request("passed", 3), true)).toEqual(refused("host_would_reject", "verify_attempt_ambiguous"));
  expect(await h.entries()).toHaveLength(2);
  expect(h.github.writes).toBe(1);
});

it("requires an allowlisted repository to abandon, even when the intent is open", async () => {
  const h = setup();
  h.github.failCreate = 1;
  expect(await h.publish()).toEqual(refused("write_unconfirmed"));
  h.binding.allow[0]!.repository_id++;
  const gets = h.github.paths.length;
  expect(await h.abandon()).toEqual(refused("not_open"));
  expect(h.github.paths).toHaveLength(gets);
  expect(await h.entries()).toHaveLength(1);
});

it("stops when the pin's stored contract cannot be parsed", async () => {
  const h = setup();
  expect(await h.publish()).toMatchObject({ status: "published" });
  const lines = (await h.entries()).map(e => JSON.stringify(e.kind === "intent" ? { ...e, text: marker } : e));
  await writeFile(path, lines.join("\n") + "\n");
  expect(await h.publish(request("passed", 3), true)).toEqual(refused("ledger_unavailable"));
  expect(h.github.writes).toBe(1);
});

it("reports a different direct readback immediately and preserves the intent", async () => {
  const h = setup(), get = h.github.get.bind(h.github);
  h.github.get = async (p, opts) => {
    const reply = await get(p, opts);
    return p.endsWith("/check-runs/1") ? { ok: true, body: { ...h.github.runs[0], name: marker } } : reply;
  };
  expect(await h.publish()).toEqual(refused("readback_mismatch"));
  expect(await h.entries()).toHaveLength(1);
  expect(h.github.writes).toBe(1);
});
