import type { ExternalReference } from "./external-reference.js";
import type { VerificationReasonCode, VerificationResultV1 } from "./verification-result.js";

export type VerificationSourceKind = "check_run";
/** One source object, pre-classified by a reader. Identifiers are not instruction text. */
export interface VerificationSourceObservation {
  source_kind: VerificationSourceKind; object_id: number; repository_id: number; repository: string; pr: number;
  observed_head_sha: string; app_id: number; check_name: string; response_digest: string; contract_digest: string | null;
  verdict: { ok: true } | { ok: false; code: VerificationReasonCode };
  result: VerificationResultV1 | null;
}
export interface VerificationSourceRecord {
  seq: number; source_kind: VerificationSourceKind; object_id: number; repository_id: number; repository: string; pr_number: number;
  observed_head_sha: string; app_id: number; check_name: string; response_digest: string; contract_digest: string | null;
  result_id: string | null; attempt: number | null; skill_id: string | null; outcome: VerificationResultV1["outcome"] | null;
  head_sha: string | null; base_sha: string | null; dedup_key: string | null; withdraws_result_id: string | null; supersedes_result_id: string | null;
  decision: "accepted" | "rejected" | "duplicate"; reason_code: VerificationReasonCode | null;
  original_seq: number | null; withdraws_seq: number | null; summary: ExternalReference | null; intake_id: string | null;
  observed_at: number; recorded_at: number;
}
export type VerificationSourceDecision =
  | { decision: "accepted"; reason_code: null; withdraws_seq: number | null }
  | { decision: "rejected"; reason_code: VerificationReasonCode }
  | { decision: "duplicate"; reason_code: "verify_duplicate"; original_seq: number; persist: boolean };
const reject = (reason_code: VerificationReasonCode): VerificationSourceDecision => ({ decision: "rejected", reason_code });
const duplicate = (original_seq: number, persist = true): VerificationSourceDecision => ({ decision: "duplicate", reason_code: "verify_duplicate", original_seq, persist });

function decide(history: readonly VerificationSourceRecord[], o: VerificationSourceObservation): VerificationSourceDecision {
  const objects = history.filter(r => r.source_kind === o.source_kind && r.object_id === o.object_id);
  const identical = objects.find(r => r.response_digest === o.response_digest);
  if (identical) return duplicate(identical.seq, false);
  if (objects.length) return reject("verify_attempt_ambiguous");
  if (!o.verdict.ok) return reject(o.verdict.code);
  const result = o.result;
  if (!result) return reject("verify_contract_invalid");
  if (history.some(r => r.decision === "accepted" && r.result_id === result.result_id
    && (r.repository_id !== o.repository_id || r.pr_number !== o.pr))) return reject("verify_attempt_ambiguous");
  const scope = history.filter(r => r.repository_id === o.repository_id && r.pr_number === o.pr);
  const registrations = scope.filter(r => r.decision !== "rejected");
  const sameId = registrations.find(r => r.result_id === result.result_id);
  if (sameId) return sameId.contract_digest === o.contract_digest
    ? duplicate(sameId.decision === "accepted" ? sameId.seq : sameId.original_seq!) : reject("verify_attempt_ambiguous");
  const attempts = scope.filter(r => r.head_sha === result.head_sha && r.skill_id === result.skill_id
    && r.attempt !== null && r.reason_code !== "verify_attempt_ambiguous" && r.reason_code !== "verify_contract_invalid");
  const max = attempts.reduce((n, r) => Math.max(n, r.attempt ?? 0), 0);
  if (result.attempt !== max + 1) return reject("verify_attempt_ambiguous");
  const target = (id: string) => scope.find(r => r.result_id === id && r.decision === "accepted" && r.app_id === o.app_id);
  if (result.withdraws_result_id !== null) {
    const withdrawn = target(result.withdraws_result_id);
    if (!withdrawn || result.withdraws_result_id === result.result_id) return reject("verify_contract_invalid");
    const previous = scope.find(r => r.decision === "accepted" && r.withdraws_seq === withdrawn.seq);
    return previous ? duplicate(previous.seq) : { decision: "accepted", reason_code: null, withdraws_seq: withdrawn.seq };
  }
  const sameFailure = scope.find(r => r.decision === "accepted" && r.withdraws_result_id === null && r.outcome === "failed" && r.dedup_key === result.dedup_key);
  if (result.outcome === "failed" && sameFailure) return duplicate(sameFailure.seq);
  if (result.supersedes_result_id !== null && !target(result.supersedes_result_id)) return reject("verify_contract_invalid");
  return { decision: "accepted", reason_code: null, withdraws_seq: null };
}

/** Batch-local sequences start after the highest supplied seq. Stores resolve decisions against real inserted rows. */
export function decideVerificationSources(history: readonly VerificationSourceRecord[], batch: readonly VerificationSourceObservation[]): { observation: VerificationSourceObservation; outcome: VerificationSourceDecision }[] {
  const rows = [...history].sort((a, b) => a.seq - b.seq);
  let seq = rows.reduce((n, r) => Math.max(n, r.seq), 0);
  const sorted = [...batch].sort((a, b) => (a.result?.attempt ?? Infinity) - (b.result?.attempt ?? Infinity)
    || a.object_id - b.object_id || a.response_digest.localeCompare(b.response_digest));
  return sorted.map(observation => {
    const outcome = decide(rows, observation);
    if (!(outcome.decision === "duplicate" && !outcome.persist)) {
      const r = observation.result;
      rows.push({ ...observation, seq: ++seq, pr_number: observation.pr,
        result_id: r?.result_id ?? null, attempt: r?.attempt ?? null, skill_id: r?.skill_id ?? null, outcome: r?.outcome ?? null,
        head_sha: r?.head_sha ?? null, base_sha: r?.base_sha ?? null, dedup_key: r?.dedup_key ?? null,
        withdraws_result_id: r?.withdraws_result_id ?? null, supersedes_result_id: r?.supersedes_result_id ?? null, summary: r?.summary ?? null,
        decision: outcome.decision, reason_code: outcome.reason_code, original_seq: outcome.decision === "duplicate" ? outcome.original_seq : null,
        withdraws_seq: outcome.decision === "accepted" ? outcome.withdraws_seq : null, intake_id: null, observed_at: 0, recorded_at: 0 });
    }
    return { observation, outcome };
  });
}
export function verificationRegistrationState(history: readonly VerificationSourceRecord[], result_id: string): { registered: VerificationSourceRecord; withdrawn_by: VerificationSourceRecord | null; duplicates: VerificationSourceRecord[] } | null {
  const rows = [...history].sort((a, b) => a.seq - b.seq);
  const registered = rows.find(r => r.result_id === result_id && r.decision === "accepted");
  if (!registered) return null;
  return { registered, withdrawn_by: rows.find(r => r.decision === "accepted" && r.withdraws_seq === registered.seq) ?? null,
    duplicates: rows.filter(r => r.decision === "duplicate" && r.original_seq === registered.seq) };
}
