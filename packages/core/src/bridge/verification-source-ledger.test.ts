import { expect, it } from "vitest";
import { parseVerificationResultV1, verificationDedupKey, type VerificationReasonCode } from "./verification-result.js";
import { verificationFixture, passedVerificationFixture, withdrawalVerificationFixture } from "./verification-result-fixtures.js";
import { decideVerificationSources, verificationRegistrationState, type VerificationSourceObservation, type VerificationSourceRecord } from "./verification-source-ledger.js";

export function observation(id = 1, payload: unknown = verificationFixture()): VerificationSourceObservation {
  const parsed = parseVerificationResultV1(JSON.stringify(payload));
  if (!parsed.ok) throw new Error(parsed.code);
  const p = parsed.result;
  return { source_kind: "check_run", object_id: id, repository_id: p.repository_id, repository: p.repository, pr: p.pr,
    observed_head_sha: p.head_sha, app_id: 201, check_name: "fixture-check", response_digest: id.toString(16).padStart(64, "0"),
    contract_digest: "c".repeat(64), verdict: { ok: true }, result: parsed.result };
}
const next = (attempt: number, passed = true) => ({ ...(passed ? passedVerificationFixture() : verificationFixture()), attempt,
  result_id: `00000000-0000-4000-8000-${String(attempt).padStart(12, "0")}` });
function row(o = observation(), seq = 1): VerificationSourceRecord {
  const r = o.result!;
  return { ...o, seq, pr_number: o.pr, result_id: r.result_id, attempt: r.attempt, skill_id: r.skill_id, outcome: r.outcome,
    head_sha: r.head_sha, base_sha: r.base_sha, dedup_key: r.dedup_key, withdraws_result_id: r.withdraws_result_id,
    supersedes_result_id: r.supersedes_result_id, summary: r.summary, decision: "accepted", reason_code: null,
    original_seq: null, withdraws_seq: null, intake_id: null, observed_at: 1, recorded_at: 1 };
}
const outcomes = (history: VerificationSourceRecord[], batch: VerificationSourceObservation[]) => decideVerificationSources(history, batch).map(x => x.outcome);
it("accepts first results and distinguishes re-reads from edits", () => {
  expect(outcomes([], [observation()])).toEqual([{ decision: "accepted", reason_code: null, withdraws_seq: null }]);
  expect(outcomes([row()], [observation()])[0]).toEqual({ decision: "duplicate", reason_code: "verify_duplicate", original_seq: 1, persist: false });
  expect(outcomes([row()], [{ ...observation(), response_digest: "e".repeat(64) }])[0]).toMatchObject({ reason_code: "verify_attempt_ambiguous" });
  expect(outcomes([{ ...row(), decision: "rejected", reason_code: "verify_stale_head" }], [{ ...observation(), response_digest: "e".repeat(64) }])[0]).toMatchObject({ reason_code: "verify_attempt_ambiguous" });
});
it("deduplicates result ids only for identical contract bytes", () => {
  expect(outcomes([row()], [observation(2)])[0]).toEqual({ decision: "duplicate", reason_code: "verify_duplicate", original_seq: 1, persist: true });
  expect(outcomes([row()], [{ ...observation(2), contract_digest: "e".repeat(64) }])[0]).toMatchObject({ reason_code: "verify_attempt_ambiguous" });
});
it("requires contiguous attempts and orders batches deterministically", () => {
  const a = observation(); const b = observation(2, next(2)); const c = observation(3, next(3));
  expect(outcomes([], [b, a])).toEqual(outcomes([], [a, b]));
  expect(outcomes([], [b, a]).map(x => x.decision)).toEqual(["accepted", "accepted"]);
  expect(outcomes([row()], [c])[0]).toMatchObject({ reason_code: "verify_attempt_ambiguous" });
  expect(outcomes([row(), row(b, 2)], [observation(4, { ...next(2), result_id: next(4).result_id })])[0]).toMatchObject({ reason_code: "verify_attempt_ambiguous" });
  expect(outcomes([row(b, 2)], [a])[0]).toMatchObject({ reason_code: "verify_attempt_ambiguous" });
});
it("deduplicates failed semantics while a new head has its own sequence", () => {
  expect(outcomes([row()], [observation(2, next(2, false))])[0]).toMatchObject({ decision: "duplicate", original_seq: 1, persist: true });
  const p = { ...next(1, false), head_sha: "f".repeat(40), result_id: next(4).result_id };
  p.dedup_key = verificationDedupKey(p);
  expect(outcomes([row()], [observation(4, p)])[0]?.decision).toBe("accepted");
});
it("validates withdrawals, preserves registration and deduplicates repeated withdrawals", () => {
  const original = row(); const w = observation(2, withdrawalVerificationFixture());
  expect(outcomes([original], [w])[0]).toMatchObject({ decision: "accepted", withdraws_seq: 1 });
  const withdrawal = { ...row(w, 2), withdraws_seq: 1 };
  expect(verificationRegistrationState([original, withdrawal], original.result_id!)).toEqual({ registered: original, withdrawn_by: withdrawal, duplicates: [] });
  expect(original.withdraws_seq).toBeNull();
  const repeated = observation(3, { ...withdrawalVerificationFixture(), attempt: 3, result_id: next(5).result_id });
  expect(outcomes([original, withdrawal], [repeated])[0]).toMatchObject({ decision: "duplicate", original_seq: 2 });
  for (const h of [[], [{ ...original, pr_number: 99 }], [{ ...original, app_id: 999 }]]) {
    const first = { ...w, result: { ...w.result!, attempt: h.some(r => r.pr_number === 7) ? 2 : 1 } };
    expect(outcomes(h, [first])[0]).toMatchObject({ reason_code: "verify_contract_invalid" });
  }
  expect(outcomes([], [{ ...w, result: { ...w.result!, attempt: 1, withdraws_result_id: w.result!.result_id } }])[0]).toMatchObject({ reason_code: "verify_contract_invalid" });
});
it("validates supersedes targets", () => {
  expect(outcomes([row()], [observation(2, { ...next(2), supersedes_result_id: next(9).result_id })])[0]).toMatchObject({ reason_code: "verify_contract_invalid" });
  expect(outcomes([row()], [observation(2, { ...next(2), supersedes_result_id: row().result_id })])[0]?.decision).toBe("accepted");
});
it.each<VerificationReasonCode>(["verify_stale_head", "verify_base_changed", "verify_result_expired", "verify_producer_untrusted", "verify_scope_unregistered", "verify_skill_unregistered", "verify_contract_invalid", "verify_evidence_invalid"])("retains %s without registering or advancing", code => {
  const bad = { ...observation(), verdict: { ok: false as const, code }, result: null };
  expect(outcomes([], [bad])[0]).toEqual({ decision: "rejected", reason_code: code });
  expect(outcomes([], [bad, observation(2)])[0]?.decision).toBe("accepted");
  expect(verificationRegistrationState([{ ...row(), decision: "rejected", reason_code: code }], row().result_id!)).toBeNull();
});
it("counts expired identified attempts but rejects gaps", () => {
  const expired = { ...observation(), verdict: { ok: false as const, code: "verify_result_expired" as const } };
  expect(outcomes([], [expired, observation(2, next(2, false))]).map(x => x.decision)).toEqual(["rejected", "accepted"]);
  expect(outcomes([], [expired, observation(3, next(3, false))])[1]).toMatchObject({ reason_code: "verify_attempt_ambiguous" });
});
it.each<VerificationReasonCode>(["verify_attempt_ambiguous", "verify_contract_invalid"])("does not advance identified %s attempts", reason_code => {
  const history = [{ ...row(), decision: "rejected" as const, reason_code }];
  expect(outcomes(history, [observation(2, next(2, false))])[0]).toMatchObject({ reason_code: "verify_attempt_ambiguous" });
  expect(outcomes(history, [observation(3, next(1, false))])[0]?.decision).toBe("accepted");
});
