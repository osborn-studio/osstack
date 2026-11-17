/** Synthetic contracts only; numeric identities are not an installed producer. */
import { createHash } from "node:crypto";

export const VERIFICATION_NOW = Date.parse("2026-11-16T12:02:00Z");
export function verificationFixture() {
  const binding = {
    repository_id: 101, pr: 7, head_sha: "a".repeat(40), base_sha: "b".repeat(40),
    skill_manifest_digest: "c".repeat(64), profile_digest: "d".repeat(64),
  };
  return {
    schema_version: 1, result_id: "00000000-0000-4000-8000-000000000001", attempt: 1,
    repository: "fixture-owner/fixture-repo", ...binding, branch: "fixture-branch", base_ref: "main",
    skill_id: "fixture-skill", skill_version: "1.0.0", skill_blob: "e".repeat(40), profile_id: "fixture-profile",
    trusted_source: { repository: "fixture-owner/fixture-harness", commit_sha: "e".repeat(40), artifact_digest: "f".repeat(64) },
    invocation_id: "00000000-0000-4000-8000-000000000002",
    started_at: "2026-11-16T12:00:00Z", finished_at: "2026-11-16T12:01:00Z", generated_at: "2026-11-16T12:02:00Z",
    outcome: "failed", failure_code: "assertion_failed",
    checks: [{ check_id: "fixture-check", failure_code: "assertion_failed", exit: 1, result_digest: "1".repeat(64) }],
    evidence_refs: [{ artifact_id: "fixture-artifact", sha256: "2".repeat(64), size: 12, type: "text/plain", retention: 30 }],
    evidence_digest: "3".repeat(64),
    runtime_provenance: { runtime_id: "fixture-runtime", runtime_digest: "4".repeat(64), source_manifest_digest: "5".repeat(64) },
    dedup_key: createHash("sha256").update(JSON.stringify([binding.repository_id, binding.pr, binding.head_sha, binding.base_sha, binding.skill_manifest_digest, binding.profile_digest])).digest("hex"),
    supersedes_result_id: null, withdraws_result_id: null, withdraw_reason_code: null,
    producer: { type: "App", app_id: 201, installation_id: 301 }, summary: "Synthetic assertion failed",
  };
}
export function passedVerificationFixture() {
  return { ...verificationFixture(), outcome: "passed", failure_code: null,
    checks: [{ check_id: "fixture-check", failure_code: null, exit: 0, result_digest: "1".repeat(64) }] };
}
export function withdrawalVerificationFixture() {
  return { ...verificationFixture(), result_id: "00000000-0000-4000-8000-000000000003", attempt: 2,
    outcome: "cancelled", failure_code: null, checks: [],
    withdraws_result_id: "00000000-0000-4000-8000-000000000001", withdraw_reason_code: "source_invalid" };
}

/** Each mutation isolates one invalid boundary. */
export const invalidVerificationFixtures: ReadonlyArray<readonly [string, (value: ReturnType<typeof verificationFixture>) => unknown]> = [
  ["version", v => ({ ...v, schema_version: 2 })],
  ["extra field", v => ({ ...v, argv: [] })],
  ["nested extra field", v => ({ ...v, trusted_source: { ...v.trusted_source, redirect: "elsewhere" } })],
  ["check extra field", v => ({ ...v, checks: [{ ...v.checks[0], command: "echo" }] })],
  ["runtime extra field", v => ({ ...v, runtime_provenance: { ...v.runtime_provenance, image: "fixture" } })],
  ["producer extra field", v => ({ ...v, producer: { ...v.producer, permissions: [] } })],
  ["evidence redirect", v => ({ ...v, evidence_refs: [{ ...v.evidence_refs[0], redirect: "elsewhere" }] })],
  ["UUID", v => ({ ...v, result_id: "invalid" })],
  ["invocation UUID", v => ({ ...v, invocation_id: "invalid" })],
  ["short SHA", v => ({ ...v, head_sha: "abcdef0" })],
  ["64 hex SHA", v => ({ ...v, base_sha: "a".repeat(64) })],
  ["uppercase SHA", v => ({ ...v, head_sha: "A".repeat(40) })],
  ["repository", v => ({ ...v, repository: "owner/repo/extra" })],
  ["PR", v => ({ ...v, pr: 0 })],
  ["repository id", v => ({ ...v, repository_id: 0 })],
  ["attempt", v => ({ ...v, attempt: 1.5 })],
  ["outcome", v => ({ ...v, outcome: "unknown" })],
  ["time order", v => ({ ...v, finished_at: "2026-11-16T11:00:00Z" })],
  ["generation order", v => ({ ...v, generated_at: "2026-11-16T12:00:30Z" })],
  ["UTC timestamp", v => ({ ...v, started_at: "2026-11-16T12:00:00+00:00" })],
  ["invalid calendar", v => ({ ...v, started_at: "2026-02-30T12:00:00Z" })],
  ["summary size", v => ({ ...v, summary: "x".repeat(4097) })],
  ["summary UTF8 size", v => ({ ...v, summary: "界".repeat(1366) })],
  ["control character", v => ({ ...v, summary: "bad\u0000text" })],
  ["evidence count", v => ({ ...v, evidence_refs: Array.from({ length: 33 }, () => v.evidence_refs[0]) })],
  ["evidence URL", v => ({ ...v, evidence_refs: [{ ...v.evidence_refs[0], artifact_id: "https://invalid.example/x" }] })],
  ["evidence path", v => ({ ...v, evidence_refs: [{ ...v.evidence_refs[0], artifact_id: "/tmp/evidence" }] })],
  ["evidence command", v => ({ ...v, evidence_refs: [{ ...v.evidence_refs[0], artifact_id: "sh -c echo" }] })],
  ["evidence hash", v => ({ ...v, evidence_refs: [{ ...v.evidence_refs[0], sha256: "bad" }] })],
  ["evidence size", v => ({ ...v, evidence_refs: [{ ...v.evidence_refs[0], size: -1 }] })],
  ["evidence retention", v => ({ ...v, evidence_refs: [{ ...v.evidence_refs[0], retention: 0 }] })],
  ["evidence type", v => ({ ...v, evidence_refs: [{ ...v.evidence_refs[0], type: "shell" }] })],
  ["evidence Windows path", v => ({ ...v, evidence_refs: [{ ...v.evidence_refs[0], artifact_id: "C:\\fixture\\evidence" }] })],
  ["evidence UNC path", v => ({ ...v, evidence_refs: [{ ...v.evidence_refs[0], artifact_id: "\\\\fixture\\evidence" }] })],
  ["evidence secret", v => ({ ...v, evidence_refs: [{ ...v.evidence_refs[0], artifact_id: "gh" + "p_" + "x".repeat(36) }] })],
  ["dedup mismatch", v => ({ ...v, dedup_key: "0".repeat(64) })],
  ["supersede UUID", v => ({ ...v, supersedes_result_id: "bad" })],
  ["withdraw UUID", v => ({ ...v, withdraws_result_id: "bad" })],
  ["withdraw outcome", v => ({ ...v, withdraws_result_id: "00000000-0000-4000-8000-000000000003", withdraw_reason_code: "source_invalid" })],
  ["secret", v => ({ ...v, summary: "gh" + "p_" + "x".repeat(36) })],
  ["secret assignment", v => ({ ...v, summary: "password=synthetic" })],
  ["private key", v => ({ ...v, summary: "-----BEGIN " + "PRIVATE KEY-----" })],
  ["session secret", v => ({ ...v, summary: "ey" + "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.synthetic" })],
];
