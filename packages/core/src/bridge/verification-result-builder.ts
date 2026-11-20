import { createHash } from "node:crypto";
import { classifyRecheck, parseRecheckResult, type RecheckBinding } from "./recheck.js";
import { canonicalJson } from "./revision-grant.js";
import { checkTransportConclusion, parseVerificationResultV1, verificationDedupKey, type VerificationResultV1 } from "./verification-result.js";

/** What the fixed harness measured. Values only; never a command. */
export interface VerificationHarnessRecord {
  invocation_id: string;
  started_at: string;
  finished_at: string;
  outcome: VerificationResultV1["outcome"];
  failure_code: string | null;
  checks: readonly VerificationResultV1["checks"][number][];
  evidence_refs: readonly { artifact_id: string; sha256: string; size: number; type: string; retention: number }[];
  evidence_digest: string;
  runtime_provenance: VerificationResultV1["runtime_provenance"];
  summary: string;
}

export interface VerificationBuildInput {
  result_id: string;
  attempt: number;
  generated_at: string;
  /** The PR as the publisher just read it from GitHub. */
  target: Pick<VerificationResultV1, "repository" | "repository_id" | "pr" | "branch" | "base_ref" | "base_sha" | "head_sha">;
  /** The publisher's pinned skill and profile. */
  binding: Pick<VerificationResultV1, "skill_id" | "skill_version" | "skill_blob" | "skill_manifest_digest" | "profile_id" | "profile_digest" | "trusted_source">;
  producer: { type: "App"; app_id: number; installation_id: number };
  record: VerificationHarnessRecord;
  /** An earlier result on the same head. Never the original of a recheck. */
  supersedes_result_id: string | null;
  recheck: RecheckBinding | null;
}

export interface VerificationWithdrawalInput {
  result_id: string;
  attempt: number;
  invocation_id: string;
  started_at: string;
  finished_at: string;
  generated_at: string;
  /** The exact published contract text of the result being withdrawn. */
  withdrawn_contract_text: string;
  withdraw_reason_code: string;
  producer: VerificationBuildInput["producer"];
  summary: string;
}

export type VerificationBuildRefusal =
  | "builder_input_invalid" | "builder_outcome_inconsistent" | "builder_scope_mismatch"
  | "builder_binding_changed" | "builder_original_check_missing" | "builder_supersedes_original"
  | "builder_withdrawal_target_invalid";

export interface VerificationPublication {
  text: string;
  result: VerificationResultV1;
  check_run: {
    name: string;
    head_sha: string;
    external_id: string;
    status: "completed";
    conclusion: "success" | "failure" | "action_required" | "cancelled";
    output: { title: string; summary: string; text: string };
  };
}

export type VerificationBuildResult =
  | { ok: true; publication: VerificationPublication }
  | { ok: false; reason: VerificationBuildRefusal };

const refuse = (reason: VerificationBuildRefusal) => ({ ok: false, reason }) as const;
const isObject = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value);
const conclusions = { passed: "success", failed: "failure", blocked: "action_required", cancelled: "cancelled" } as const;

function publish(input: VerificationBuildInput, withdraws_result_id: string | null, withdraw_reason_code: string | null): VerificationBuildResult {
  const { result_id, attempt, generated_at, target, binding, record, producer, supersedes_result_id, recheck } = input;
  const { repository, repository_id, pr, branch, head_sha, base_sha, base_ref } = target;
  const { skill_id, skill_version, skill_blob, skill_manifest_digest, profile_id, profile_digest } = binding;
  const { repository: sourceRepository, commit_sha, artifact_digest } = binding.trusted_source;
  const trusted_source = { repository: sourceRepository, commit_sha, artifact_digest };
  const { outcome, failure_code, checks: measured } = record;
  if (!Array.isArray(measured)) return refuse("builder_input_invalid");
  const checks = Array.from(measured, ({ check_id, failure_code, exit, result_digest }) => ({ check_id, failure_code, exit, result_digest }));
  if (outcome === "passed" && (failure_code !== null || !checks.length || checks.some(c => c.failure_code !== null || c.exit !== 0)))
    return refuse("builder_outcome_inconsistent");
  if (outcome === "failed" && (failure_code === null || !checks.some(c => c.failure_code !== null)))
    return refuse("builder_outcome_inconsistent");
  if (supersedes_result_id === result_id) return refuse("builder_input_invalid");
  if (recheck !== null) {
    if (result_id === recheck.original_result_id) return refuse("builder_input_invalid");
    if (supersedes_result_id === recheck.original_result_id) return refuse("builder_supersedes_original");
    if (repository_id !== recheck.repository_id || pr !== recheck.pr_number || base_sha !== recheck.base_sha || head_sha !== recheck.new_head_sha)
      return refuse("builder_scope_mismatch");
    const digest = createHash("sha256").update(canonicalJson(trusted_source)).digest("hex");
    if (skill_id !== recheck.skill_id || skill_version !== recheck.skill_version || skill_blob !== recheck.skill_blob
      || skill_manifest_digest !== recheck.skill_manifest_digest || profile_id !== recheck.profile_id
      || profile_digest !== recheck.profile_digest || digest !== recheck.trusted_source_digest) return refuse("builder_binding_changed");
    const ids = new Set(checks.map(c => c.check_id));
    if (!Array.isArray(recheck.original_checks)) return refuse("builder_input_invalid");
    if (!ids.has(recheck.failed_check_id) || recheck.original_checks.some(id => !ids.has(id))) return refuse("builder_original_check_missing");
  }
  const { invocation_id, started_at, finished_at, evidence_refs, evidence_digest, summary } = record;
  const { runtime_id, runtime_digest, source_manifest_digest } = record.runtime_provenance;
  if (!Array.isArray(evidence_refs)) return refuse("builder_input_invalid");
  const text = JSON.stringify({
    schema_version: 1, result_id, attempt, repository, repository_id, pr, branch, head_sha, base_sha, base_ref,
    skill_id, skill_version, skill_blob, skill_manifest_digest, profile_id, profile_digest, trusted_source,
    invocation_id, started_at, finished_at, generated_at, outcome, failure_code, checks,
    evidence_refs: Array.from(evidence_refs, ({ artifact_id, sha256, size, type, retention }) => ({ artifact_id, sha256, size, type, retention })),
    evidence_digest, runtime_provenance: { runtime_id, runtime_digest, source_manifest_digest },
    dedup_key: verificationDedupKey({ repository_id, pr, head_sha, base_sha, skill_manifest_digest, profile_digest }),
    supersedes_result_id, withdraws_result_id, withdraw_reason_code,
    producer: { type: producer.type, app_id: producer.app_id, installation_id: producer.installation_id }, summary,
  });
  const parsed = parseVerificationResultV1(text);
  if (!parsed.ok) return refuse("builder_input_invalid");
  const { result } = parsed;
  const conclusion = conclusions[outcome];
  if (!checkTransportConclusion(result, { status: "completed", conclusion }).ok) return refuse("builder_input_invalid");
  if (recheck !== null) {
    const verdict = classifyRecheck(recheck, { result: parseRecheckResult(text), actions: null, host: null });
    if (verdict.reason === "verify_recheck_binding_changed") return refuse("builder_binding_changed");
    if (outcome === "passed" && (verdict.state !== "reverify_pending" || verdict.missing.includes("result")))
      return refuse("builder_input_invalid");
  }
  return { ok: true, publication: { text, result, check_run: {
    name: `osstack/verify-intake/${result.skill_id}`, head_sha: result.head_sha, external_id: result.result_id,
    status: "completed", conclusion, output: { title: `OSStack verify intake: ${withdraws_result_id === null ? outcome : "withdrawn"}`, summary: result.summary.content, text },
  } } };
}

export function buildVerificationResult(input: VerificationBuildInput): VerificationBuildResult {
  try {
    if (!isObject(input)) return refuse("builder_input_invalid");
    const { target, binding, record, producer, recheck, supersedes_result_id } = input;
    if (![target, binding, record, producer].every(isObject) || (recheck !== null && !isObject(recheck))
      || (supersedes_result_id !== null && typeof supersedes_result_id !== "string")) return refuse("builder_input_invalid");
    return publish({ target, binding, record, producer, recheck, supersedes_result_id,
      result_id: input.result_id, attempt: input.attempt, generated_at: input.generated_at }, null, null);
  } catch {
    return refuse("builder_input_invalid");
  }
}

export function buildVerificationWithdrawal(input: VerificationWithdrawalInput): VerificationBuildResult {
  try {
    if (!isObject(input)) return refuse("builder_input_invalid");
    const parsed = parseVerificationResultV1(input.withdrawn_contract_text);
    const result_id = input.result_id;
    if (!parsed.ok || parsed.result.withdraws_result_id !== null || parsed.result.result_id === result_id)
      return refuse("builder_withdrawal_target_invalid");
    const target = parsed.result;
    const producer = target.producer;
    const supplied = input.producer;
    if (producer.type !== "App" || !supplied || supplied.type !== producer.type || supplied.app_id !== producer.app_id
      || supplied.installation_id !== producer.installation_id) return refuse("builder_withdrawal_target_invalid");
    if (typeof input.withdraw_reason_code !== "string") return refuse("builder_input_invalid");
    return publish({ target, binding: target, producer, result_id, attempt: input.attempt, generated_at: input.generated_at,
      supersedes_result_id: null, recheck: null, record: {
        invocation_id: input.invocation_id, started_at: input.started_at, finished_at: input.finished_at,
        outcome: "cancelled", failure_code: null, checks: [], evidence_refs: target.evidence_refs,
        evidence_digest: target.evidence_digest, runtime_provenance: target.runtime_provenance, summary: input.summary,
      } }, target.result_id, input.withdraw_reason_code);
  } catch {
    return refuse("builder_input_invalid");
  }
}
