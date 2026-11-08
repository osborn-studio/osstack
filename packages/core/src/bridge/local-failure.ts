import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./revision-grant.js";
import { LocalFailureRepositorySchema } from "./local-failure-repository.js";
import { VerificationProfileIdSchema } from "./verification-profile-id.js";

/** Offline data contracts only. Parsing, digests and eligibility do not authenticate host evidence,
 * verify a grant, or authorize repair. Resolve receipts from the host ledger, never client/CI JSON. */
export const LOCAL_FAILURE_LIMITS = {
  max_text_bytes: 256, max_summary_bytes: 4096, max_checks: 64, max_proof_ref_bytes: 1024,
  max_timestamp: 8_640_000_000_000_000,
} as const;
export type LocalFailureErrorCode =
  | "ci_failure_hint_invalid" | "local_failure_binding_invalid" | "local_verification_receipt_invalid";
export class LocalFailureError extends Error {
  constructor(readonly code: LocalFailureErrorCode) { super(code); this.name = "LocalFailureError"; }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ledger text excludes control characters.
const NO_CONTROL = /^[^\u0000-\u001f\u007f-\u009f]+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: summaries allow tabs and LF, but no terminal controls.
const SUMMARY_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const text = (max: number = LOCAL_FAILURE_LIMITS.max_text_bytes) => z.string().min(1).max(max).regex(NO_CONTROL)
  .refine(value => value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= max);
const token = (max: number = LOCAL_FAILURE_LIMITS.max_text_bytes) => text(max).refine(value => /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value));
const fullSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const positiveInteger = z.number().int().safe().min(1);
const timestamp = z.number().int().safe().min(0).max(LOCAL_FAILURE_LIMITS.max_timestamp);

/** Untrusted wake-up metadata. It deliberately has no logs, argv, commands, or review IDs.
 * The authenticated read adapter must separately establish producer, freshness and complete pagination. */
export const CiFailureHintSchema = z.object({
  repository: LocalFailureRepositorySchema, pr: positiveInteger, head: fullSha, app_id: positiveInteger, check_run_id: positiveInteger,
  name: text(), status: z.literal("completed"), conclusion: z.literal("failure"), observed_at: timestamp,
}).strict();
export type CiFailureHint = z.infer<typeof CiFailureHintSchema>;

/** Host-generated UUID-style key shared by ledger and feedback references. */
export const LocalFailureIntakeIdSchema = z.string().length(40).regex(/^lfi_[0-9a-f-]{36}$/);

const bindingFields = {
  intake_id: LocalFailureIntakeIdSchema, chain_id: token(), root_mission_id: token(), grant_id: token(),
  repository: LocalFailureRepositorySchema, pr: positiveInteger, branch: text(255), head: fullSha, tree: fullSha,
  base_ref: text(255), base_sha: fullSha, profile_id: VerificationProfileIdSchema, profile_digest: digest,
  trusted_source_digest: digest, invocation_id: token(),
};
/** Expected identity supplied independently by the host ledger and pinned profile. Compare every field exactly. */
export const LocalFailureBindingSchema = z.object(bindingFields).strict();
export type LocalFailureBinding = z.infer<typeof LocalFailureBindingSchema>;
/** Database column names are an internal representation, never receipt aliases. */
export type LocalFailureLedgerBinding = Omit<LocalFailureBinding, "pr" | "head" | "tree"> & {
  pr_number: number; head_sha: string; tree_sha: string;
};
/** Explicit data projection only. This does not authenticate a ledger row or grant authority. */
export function localFailureBindingFromLedger(row: LocalFailureLedgerBinding): LocalFailureBinding {
  return parseLocalFailureBinding({
    intake_id: row.intake_id, chain_id: row.chain_id, root_mission_id: row.root_mission_id, grant_id: row.grant_id,
    repository: row.repository, pr: row.pr_number, branch: row.branch, head: row.head_sha, tree: row.tree_sha,
    base_ref: row.base_ref, base_sha: row.base_sha, profile_id: row.profile_id, profile_digest: row.profile_digest,
    trusted_source_digest: row.trusted_source_digest, invocation_id: row.invocation_id,
  });
}
const bindingKeys = Object.keys(bindingFields) as (keyof LocalFailureBinding)[];
const checkSchema = z.object({
  check_id: token(), category: token(64), exit_code: z.number().int().min(0).max(255).nullable(), result_digest: digest,
}).strict();
export const LocalVerificationReceiptSchema = z.object({
  version: z.literal(1), ...bindingFields, started_at: timestamp, finished_at: timestamp,
  // A stopped timeout may be recorded, but is never a reproducible code failure.
  outcome: z.enum(["passed", "reproducible_failure", "infrastructure_error", "cancelled", "timeout"]),
  checks: z.array(checkSchema).min(1).max(LOCAL_FAILURE_LIMITS.max_checks)
    .refine(checks => new Set(checks.map(check => check.check_id)).size === checks.length),
  bounded_redacted_summary: z.string().max(LOCAL_FAILURE_LIMITS.max_summary_bytes)
    .refine(value => !SUMMARY_CONTROL.test(value) && Buffer.byteLength(value, "utf8") <= LOCAL_FAILURE_LIMITS.max_summary_bytes),
  evidence_digest: digest,
  stop: z.object({ proven: z.literal(true), proof_ref: text(LOCAL_FAILURE_LIMITS.max_proof_ref_bytes), proof_digest: digest }).strict(),
}).strict().refine(value => value.finished_at >= value.started_at, "receipt_time_order");
export type LocalVerificationReceipt = z.infer<typeof LocalVerificationReceiptSchema>;

export function parseCiFailureHint(value: unknown): CiFailureHint {
  const parsed = CiFailureHintSchema.safeParse(value);
  if (!parsed.success) throw new LocalFailureError("ci_failure_hint_invalid");
  return parsed.data;
}
export function parseLocalFailureBinding(value: unknown): LocalFailureBinding {
  const parsed = LocalFailureBindingSchema.safeParse(value);
  if (!parsed.success) throw new LocalFailureError("local_failure_binding_invalid");
  return parsed.data;
}
/** Shape validation only. A proven flag and digest in supplied JSON are not proof of host provenance or stop. */
export function parseLocalVerificationReceipt(value: unknown): LocalVerificationReceipt {
  const parsed = LocalVerificationReceiptSchema.safeParse(value);
  if (!parsed.success) throw new LocalFailureError("local_verification_receipt_invalid");
  return parsed.data;
}

const profileCheckSchema = z.object({
  check_id: token(), category: token(64),
  failure_exit_codes: z.array(z.number().int().min(1).max(255)).min(1).max(255)
    .refine(codes => new Set(codes).size === codes.length),
}).strict();
const profileChecksSchema = z.array(profileCheckSchema).min(1).max(LOCAL_FAILURE_LIMITS.max_checks)
  .refine(checks => new Set(checks.map(check => check.check_id)).size === checks.length);
/** Complete trusted profile check contract, not definitions selected by the candidate or CI payload. */
export type LocalFailureProfileCheck = z.infer<typeof profileCheckSchema>;
export type LocalFailureEligibility =
  | { eligible: true }
  | { eligible: false; reason: "binding_mismatch"; field: keyof LocalFailureBinding }
  | { eligible: false; reason: "invalid_receipt" | "invalid_binding" | "outcome_ineligible" | "invalid_profile_checks" | "checks_mismatch" | "failure_not_reproduced" };

/** Pure eligibility predicate, not repair authority. The caller must establish receipt/stop/evidence provenance,
 * trusted profile ownership, signed v2 opt-in, freshness, owner fencing and budget before atomic dispatch. */
export function localFailureEligibility(receipt: unknown, binding: unknown, profileChecks: unknown): LocalFailureEligibility {
  const parsedReceipt = LocalVerificationReceiptSchema.safeParse(receipt);
  if (!parsedReceipt.success) return { eligible: false, reason: "invalid_receipt" };
  const parsedBinding = LocalFailureBindingSchema.safeParse(binding);
  if (!parsedBinding.success) return { eligible: false, reason: "invalid_binding" };
  const value = parsedReceipt.data;
  for (const field of bindingKeys) {
    if (value[field] !== parsedBinding.data[field]) return { eligible: false, reason: "binding_mismatch", field };
  }
  if (value.outcome !== "reproducible_failure") return { eligible: false, reason: "outcome_ineligible" };
  const trustedChecks = profileChecksSchema.safeParse(profileChecks);
  if (!trustedChecks.success) return { eligible: false, reason: "invalid_profile_checks" };
  if (value.checks.length !== trustedChecks.data.length) return { eligible: false, reason: "checks_mismatch" };
  let failed = false;
  for (const check of value.checks) {
    const expected = trustedChecks.data.find(item => item.check_id === check.check_id);
    if (!expected || expected.category !== check.category) return { eligible: false, reason: "checks_mismatch" };
    if (check.exit_code === 0) continue;
    if (check.exit_code === null || !expected.failure_exit_codes.includes(check.exit_code)) {
      return { eligible: false, reason: "failure_not_reproduced" };
    }
    failed = true;
  }
  return failed ? { eligible: true } : { eligible: false, reason: "failure_not_reproduced" };
}

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
/** Integrity identifier only. Matching this digest never establishes host authority. */
export function localVerificationReceiptDigest(receipt: unknown): string {
  return hash({ domain: "osstack.local-verification-receipt.v1", receipt: parseLocalVerificationReceipt(receipt) });
}
const dedupSchema = z.object({ chain_id: bindingFields.chain_id, head: fullSha, profile_digest: digest });
/** Mirrors unique (chain_id, head, profile_digest). Regrant, intake and invocation changes cannot buy a retry.
 * Extra binding fields are deliberately projected away; this helper does not validate a complete binding. */
export function localFailureDedupKey(binding: unknown): string {
  const parsed = dedupSchema.safeParse(binding);
  if (!parsed.success) throw new LocalFailureError("local_failure_binding_invalid");
  return hash({ domain: "osstack.local-failure-dedup.v1", ...parsed.data });
}
