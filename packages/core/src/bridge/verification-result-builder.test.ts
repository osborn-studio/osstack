import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { passedVerificationFixture, verificationFixture } from "./verification-result-fixtures.js";
import {
  buildVerificationResult, buildVerificationWithdrawal, checkTransportConclusion, classifyRecheck,
  decideVerificationSources, parseRecheckResult, parseVerificationResultV1, verificationDedupKey,
  type RecheckBinding, type VerificationBuildInput, type VerificationBuildResult, type VerificationHarnessRecord,
  type VerificationSourceObservation, type VerificationSourceRecord, type VerificationWithdrawalInput,
} from "./verification-publish.js";

const keys = [
  "schema_version", "result_id", "attempt", "repository", "repository_id", "pr", "branch", "head_sha", "base_sha", "base_ref",
  "skill_id", "skill_version", "skill_blob", "skill_manifest_digest", "profile_id", "profile_digest", "trusted_source",
  "invocation_id", "started_at", "finished_at", "generated_at", "outcome", "failure_code", "checks", "evidence_refs",
  "evidence_digest", "runtime_provenance", "dedup_key", "supersedes_result_id", "withdraws_result_id", "withdraw_reason_code",
  "producer", "summary",
];
const newHead = "9".repeat(40);
const resultId = "00000000-0000-4000-8000-000000000003";
function input(outcome: VerificationHarnessRecord["outcome"] = "passed"): VerificationBuildInput {
  const f = outcome === "failed" ? verificationFixture() : passedVerificationFixture();
  return { result_id: resultId, attempt: 1, generated_at: f.generated_at,
    target: { ...f, head_sha: newHead }, binding: f, producer: { ...f.producer, type: "App" },
    record: { ...f, outcome, summary: "<fixture & summary>" }, supersedes_result_id: null, recheck: null };
}
function publication(built: VerificationBuildResult) {
  if (!built.ok) throw new Error(built.reason);
  return built.publication;
}
function pin(): RecheckBinding {
  const r = parseRecheckResult(JSON.stringify(verificationFixture()))!;
  return { ...r, pr_number: r.pr, original_result_id: r.result_id, new_head_sha: newHead,
    original_checks: r.checks.map(c => c.check_id).sort(), failed_check_id: r.checks.find(c => c.failure_code !== null)!.check_id };
}
function withdrawal(): VerificationWithdrawalInput {
  const f = input();
  return { result_id: "00000000-0000-4000-8000-000000000004", attempt: 2, invocation_id: f.record.invocation_id,
    started_at: f.record.started_at, finished_at: f.record.finished_at, generated_at: f.generated_at,
    withdrawn_contract_text: publication(buildVerificationResult(f)).text, withdraw_reason_code: "source_invalid",
    producer: f.producer, summary: f.record.summary };
}
function observation(object_id: number, text: string): VerificationSourceObservation {
  const parsed = parseVerificationResultV1(text);
  if (!parsed.ok) throw new Error(parsed.code);
  const r = parsed.result;
  return { source_kind: "check_run", object_id, repository_id: r.repository_id, repository: r.repository, pr: r.pr,
    observed_head_sha: r.head_sha, app_id: 201, check_name: `osstack/verify-intake/${r.skill_id}`,
    response_digest: object_id.toString(16).padStart(64, "0"), contract_digest: createHash("sha256").update(text).digest("hex"),
    verdict: { ok: true }, result: r };
}
function acceptedRow(seq: number, text: string): VerificationSourceRecord {
  const o = observation(seq, text);
  const r = o.result!;
  return { ...o, seq, pr_number: r.pr, result_id: r.result_id, attempt: r.attempt, skill_id: r.skill_id, outcome: r.outcome,
    head_sha: r.head_sha, base_sha: r.base_sha, dedup_key: r.dedup_key, withdraws_result_id: r.withdraws_result_id,
    supersedes_result_id: r.supersedes_result_id, summary: r.summary, decision: "accepted", reason_code: null,
    original_seq: null, withdraws_seq: null, intake_id: null, observed_at: 1, recorded_at: 1 };
}
const accepted = { decision: "accepted", reason_code: null, withdraws_seq: null };

it.each([
  ["passed", "success"], ["failed", "failure"], ["blocked", "action_required"], ["cancelled", "cancelled"], ["withdrawn", "cancelled"],
] as const)("publishes deterministic %s bytes and transport fields", (outcome, conclusion) => {
  const build = () => publication(outcome === "withdrawn" ? buildVerificationWithdrawal(withdrawal()) : buildVerificationResult(input(outcome)));
  const { text, result, check_run } = build();
  expect(text).toBe(build().text);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16384);
  expect(Object.keys(JSON.parse(text))).toEqual(keys);
  expect(parseVerificationResultV1(text)).toEqual({ ok: true, result });
  expect(result.outcome).toBe(outcome === "withdrawn" ? "cancelled" : outcome);
  expect(result.dedup_key).toBe(verificationDedupKey(result));
  expect(checkTransportConclusion(result, check_run)).toEqual({ ok: true });
  expect(check_run).toEqual({ name: "osstack/verify-intake/fixture-skill", external_id: result.result_id,
    head_sha: newHead, status: "completed", conclusion,
    output: { title: `OSStack verify intake: ${outcome}`, summary: "&lt;fixture &amp; summary&gt;", text } });
});

it("starts repaired head attempts at one and leaves actions and host pending", () => {
  const recheck = pin();
  const request = { ...input(), recheck };
  const history = [acceptedRow(1, JSON.stringify(verificationFixture()))];
  const first = publication(buildVerificationResult(request));
  expect(decideVerificationSources(history, [observation(2, first.text)])[0]?.outcome).toEqual(accepted);
  const second = publication(buildVerificationResult({ ...request, attempt: 2 }));
  expect(decideVerificationSources(history, [observation(2, second.text)])[0]?.outcome)
    .toEqual({ decision: "rejected", reason_code: "verify_attempt_ambiguous" });
  expect(classifyRecheck(recheck, { result: parseRecheckResult(first.text), actions: null, host: null }))
    .toEqual({ state: "reverify_pending", reason: "verify_recheck_missing", missing: ["actions", "host"] });
});
it.each(["failed", "blocked", "cancelled"] as const)("can report a truthful %s recheck", outcome => {
  const recheck = pin();
  const { text } = publication(buildVerificationResult({ ...input(outcome), recheck }));
  expect(classifyRecheck(recheck, { result: parseRecheckResult(text), actions: null, host: null })).toEqual(
    outcome === "failed" ? { state: "awaiting_decision", reason: "verify_recheck_failed", missing: [] }
      : { state: "reverify_pending", reason: "verify_recheck_missing", missing: ["result", "actions", "host"] });
});
it("refuses contradictory harness outcomes", () => {
  const p = input();
  const f = input("failed");
  const c = p.record.checks[0]!;
  for (const record of [
    { ...p.record, checks: [{ ...c, exit: null }] }, { ...p.record, checks: [{ ...c, exit: 1 }] },
    { ...p.record, checks: [{ ...c, failure_code: "unexpected" }] }, { ...p.record, failure_code: "unexpected" },
    { ...p.record, checks: [] }, { ...f.record, failure_code: null }, { ...f.record, checks: [c] },
  ]) expect(buildVerificationResult({ ...p, record })).toEqual({ ok: false, reason: "builder_outcome_inconsistent" });
});
it("pins each skill, profile and trusted source field", () => {
  const f = input();
  const recheck = pin();
  for (const key of ["skill_id", "skill_version", "skill_blob", "skill_manifest_digest", "profile_id", "profile_digest", "trusted_source"] as const) {
    const value = key === "trusted_source" ? { ...f.binding.trusted_source, commit_sha: "8".repeat(40) } : f.binding[key] + "x";
    expect(buildVerificationResult({ ...f, binding: { ...f.binding, [key]: value }, recheck }), key)
      .toEqual({ ok: false, reason: "builder_binding_changed" });
  }
});
it("pins the scope, original checks and original id", () => {
  const recheck = pin();
  const f = { ...input(), recheck };
  for (const target of [{ ...f.target, repository_id: 102 }, { ...f.target, pr: 8 },
    { ...f.target, base_sha: newHead }, { ...f.target, head_sha: f.target.base_sha }])
    expect(buildVerificationResult({ ...f, target })).toEqual({ ok: false, reason: "builder_scope_mismatch" });
  for (const changed of [{ ...recheck, original_checks: [...recheck.original_checks, "other"] }, { ...recheck, failed_check_id: "other" }])
    expect(buildVerificationResult({ ...f, recheck: changed })).toEqual({ ok: false, reason: "builder_original_check_missing" });
  expect(buildVerificationResult({ ...f, supersedes_result_id: recheck.original_result_id })).toEqual({ ok: false, reason: "builder_supersedes_original" });
  expect(buildVerificationResult({ ...f, result_id: recheck.original_result_id })).toEqual({ ok: false, reason: "builder_input_invalid" });
  expect(buildVerificationResult({ ...f, supersedes_result_id: f.result_id })).toEqual({ ok: false, reason: "builder_input_invalid" });
});
it("can supersede an accepted blocked result on the repaired head", () => {
  const recheck = pin();
  const original = acceptedRow(1, JSON.stringify(verificationFixture()));
  const blocked = publication(buildVerificationResult({ ...input("blocked"), recheck }));
  expect(decideVerificationSources([original], [observation(2, blocked.text)])[0]?.outcome).toEqual(accepted);
  const retry = publication(buildVerificationResult({ ...input(), recheck, result_id: "00000000-0000-4000-8000-000000000005",
    attempt: 2, supersedes_result_id: blocked.result.result_id }));
  expect(decideVerificationSources([original, acceptedRow(2, blocked.text)], [observation(3, retry.text)])[0]?.outcome).toEqual(accepted);
});
it("withdraws the exact published result and preserves its evidence", () => {
  const w = withdrawal();
  const withdrawn = publication(buildVerificationWithdrawal(w));
  const original = JSON.parse(w.withdrawn_contract_text);
  expect(JSON.parse(withdrawn.text)).toEqual({ ...original, result_id: w.result_id, attempt: w.attempt,
    invocation_id: w.invocation_id, started_at: w.started_at, finished_at: w.finished_at, generated_at: w.generated_at,
    outcome: "cancelled", checks: [], failure_code: null, withdraws_result_id: original.result_id,
    withdraw_reason_code: w.withdraw_reason_code, summary: w.summary });
  expect(decideVerificationSources([acceptedRow(7, w.withdrawn_contract_text)], [observation(8, withdrawn.text)])[0]?.outcome)
    .toEqual({ ...accepted, withdraws_seq: 7 });
  for (const change of [{ withdrawn_contract_text: withdrawn.text, result_id: resultId }, { producer: { ...w.producer, installation_id: 999 } },
    { producer: { ...w.producer, app_id: 999 } }, { withdrawn_contract_text: "{" }, { result_id: original.result_id }])
    expect(buildVerificationWithdrawal({ ...w, ...change })).toEqual({ ok: false, reason: "builder_withdrawal_target_invalid" });
});
it("uses the host parser to refuse invalid wire fields and oversized text", () => {
  const f = input("failed");
  const c = f.record.checks[0]!;
  for (const request of [
    { ...f, record: { ...f.record, summary: "control\u0000" } }, { ...f, record: { ...f.record, summary: "password=synthetic" } },
    { ...f, record: { ...f.record, checks: Array.from({ length: 128 }, () => ({ ...c, check_id: "a".repeat(128) })) } },
    { ...f, result_id: "invalid" }, { ...f, attempt: 0 }, { ...f, record: { ...f.record, failure_code: "https://invalid.example" } },
  ]) expect(buildVerificationResult(request)).toEqual({ ok: false, reason: "builder_input_invalid" });
});
it("returns refusals for malformed callers and throwing getters", () => {
  const invalid = { ok: false, reason: "builder_input_invalid" };
  for (const value of [null, undefined, 42, {}, { get record() { throw Error("fixture"); } }]) {
    expect(buildVerificationResult(value as unknown as VerificationBuildInput)).toEqual(invalid);
    expect(buildVerificationWithdrawal(value as unknown as VerificationWithdrawalInput)).toEqual(invalid);
  }
  expect(buildVerificationWithdrawal({ ...withdrawal(), get summary(): string { throw Error("fixture"); } })).toEqual(invalid);
});
it("copies only wire fields from caller objects", () => {
  const f = input();
  const extra = { untrusted_extra: "omit this" };
  const extended = { ...f, target: { ...f.target, ...extra }, binding: { ...f.binding, ...extra, trusted_source: { ...f.binding.trusted_source, ...extra } },
    record: { ...f.record, ...extra, checks: f.record.checks.map(c => ({ ...c, ...extra })), evidence_refs: f.record.evidence_refs.map(e => ({ ...e, ...extra })),
      runtime_provenance: { ...f.record.runtime_provenance, ...extra } }, producer: { ...f.producer, ...extra } };
  expect(publication(buildVerificationResult(extended)).text).toBe(publication(buildVerificationResult(f)).text);
});

const bridge = dirname(fileURLToPath(import.meta.url));
const packages = resolve(bridge, "../../..");
const entry = join(bridge, "verification-publish.ts");
const builder = join(bridge, "verification-result-builder.ts");
const mentionsKit = /verification-result-builder|verification-publish/;
it("exposes the kit only at its dedicated package subpath", () => {
  for (const pkg of readdirSync(packages)) {
    const src = join(packages, pkg, "src");
    if (!existsSync(src)) continue;
    for (const name of readdirSync(src, { recursive: true, encoding: "utf8" })) {
      if (!/\.[cm]?[jt]sx?$/.test(name) || /\.test\.[cm]?[jt]sx?$/.test(name)) continue;
      const file = join(src, name);
      if (file !== builder && file !== entry) expect(readFileSync(file, "utf8"), file).not.toMatch(mentionsKit);
    }
  }
  const manifest = JSON.parse(readFileSync(join(packages, "core/package.json"), "utf8"));
  expect(manifest.exports["./verification-publish"]).toEqual({ types: "./dist/bridge/verification-publish.d.ts",
    import: "./dist/bridge/verification-publish.js", default: "./dist/bridge/verification-publish.js" });
});
it("keeps the transitive source imports local and free of I/O", () => {
  const seen = new Set<string>();
  function visit(file: string) {
    if (seen.has(file)) return;
    seen.add(file);
    expect(file.startsWith(bridge + sep), file).toBe(true);
    const source = readFileSync(file, "utf8");
    expect(source, file).not.toMatch(/better-sqlite3|\.\.\/state\/|["']node:(?:fs|child_process|net|https?)(?:\/|["'])/);
    for (const [, specifier] of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g))
      visit(resolve(dirname(file), specifier!.replace(/\.js$/, ".ts")));
  }
  visit(entry);
  for (const file of [entry, builder])
    expect(readFileSync(file, "utf8"), file).not.toMatch(/Date\.now|new Date\(|randomUUID|Math\.random|process\.env|fetch\(/);
});
