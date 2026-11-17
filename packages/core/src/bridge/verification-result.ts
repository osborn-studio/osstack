import { createHash } from "node:crypto";
import { z } from "zod";
import { createExternalReference, type ExternalReference } from "./external-reference.js";

export type VerificationReasonCode =
  | "verify_contract_invalid" | "verify_skill_unregistered" | "verify_evidence_invalid"
  | "verify_scope_unregistered" | "verify_producer_untrusted" | "verify_stale_head"
  | "verify_base_changed" | "verify_result_expired" | "verify_duplicate"
  | "verify_read_incomplete" | "verify_attempt_ambiguous";
export type VerificationCheck = { ok: true } | { ok: false; code: VerificationReasonCode };
export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const VERIFICATION_FUTURE_SKEW_MS = 5 * 60 * 1000;

// Shared closed scalar vocabulary for the result and the independent producer policy.
export const verificationIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/);
export const verificationDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const verificationNumericIdSchema = z.number().int().positive().safe();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const uuid = z.string().uuid();
const repository = z.string().max(200).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/);
const ref = z.string().min(1).max(255).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/).refine(v =>
  !v.includes("..") && !v.includes("//") && !v.endsWith("/") && !v.endsWith(".") && !v.split("/").some(p => p.endsWith(".lock")));
const utc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/).refine(v => {
  const milliseconds = Date.parse(v);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === v.replace(/Z$/, v.includes(".") ? "Z" : ".000Z");
});
const producer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("App"), app_id: verificationNumericIdSchema, installation_id: verificationNumericIdSchema }).strict(),
  z.object({ type: z.literal("User"), actor_id: verificationNumericIdSchema, app_id: z.null() }).strict(),
]);
const evidence = z.object({
  artifact_id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  sha256: verificationDigestSchema, size: z.number().int().nonnegative().safe(),
  type: z.enum(["text/plain", "application/json", "image/png", "image/jpeg", "text/html"]),
  /** Guaranteed retention in days. The evidence reader must still verify availability. */
  retention: z.number().int().positive().safe(),
}).strict();
const wireSchema = z.object({
  schema_version: z.literal(1), result_id: uuid, attempt: verificationNumericIdSchema,
  repository, repository_id: verificationNumericIdSchema, pr: verificationNumericIdSchema, branch: ref,
  head_sha: sha, base_sha: sha, base_ref: ref,
  skill_id: verificationIdSchema, skill_version: z.string().max(64).regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/),
  skill_blob: sha, skill_manifest_digest: verificationDigestSchema,
  profile_id: verificationIdSchema, profile_digest: verificationDigestSchema,
  trusted_source: z.object({ repository, commit_sha: sha, artifact_digest: verificationDigestSchema }).strict(),
  invocation_id: uuid, started_at: utc, finished_at: utc, generated_at: utc,
  outcome: z.enum(["passed", "failed", "blocked", "cancelled"]), failure_code: verificationIdSchema.nullable(),
  checks: z.array(z.object({ check_id: verificationIdSchema, failure_code: verificationIdSchema.nullable(),
    exit: z.number().int().min(0).max(255).nullable(), result_digest: verificationDigestSchema }).strict()).max(128),
  evidence_refs: z.array(evidence).max(32), evidence_digest: verificationDigestSchema,
  runtime_provenance: z.object({ runtime_id: verificationIdSchema, runtime_digest: verificationDigestSchema,
    source_manifest_digest: verificationDigestSchema }).strict(),
  dedup_key: verificationDigestSchema, supersedes_result_id: uuid.nullable(), withdraws_result_id: uuid.nullable(),
  withdraw_reason_code: verificationIdSchema.nullable(), producer,
  summary: z.string().refine(v => Buffer.byteLength(v, "utf8") <= 4096),
}).strict();
type WireResult = z.infer<typeof wireSchema>;
export type VerificationResultV1 = Omit<WireResult, "summary"> & { summary: ExternalReference };
export type VerificationDedupBinding = Pick<WireResult, "repository_id" | "pr" | "head_sha" | "base_sha" | "skill_manifest_digest" | "profile_digest">;

/** SHA256 of a fixed-order JSON tuple, encoded as UTF-8. No object-order dependence. */
export function verificationDedupKey(binding: VerificationDedupBinding): string {
  return createHash("sha256").update(JSON.stringify([binding.repository_id, binding.pr, binding.head_sha,
    binding.base_sha, binding.skill_manifest_digest, binding.profile_digest])).digest("hex");
}

/** Syntax has already passed JSON.parse. Walk tokens to reject decoded duplicate keys,
 * including escaped aliases and keys inside array elements. Sets are per object. */
function hasDuplicateKeys(text: string): boolean {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s{}[\],:]+/gu) ?? [];
  let cursor = 0;
  let duplicate = false;
  function visit(): void {
    const token = tokens[cursor++];
    if (token === "{") {
      const keys = new Set<string>();
      while (tokens[cursor] !== "}") {
        const key: string = JSON.parse(tokens[cursor++]!);
        if (keys.has(key)) duplicate = true;
        keys.add(key);
        cursor++; // colon
        visit();
        if (tokens[cursor] !== ",") break;
        cursor++;
      }
      cursor++;
    } else if (token === "[") {
      while (tokens[cursor] !== "]") {
        visit();
        if (tokens[cursor] !== ",") break;
        cursor++;
      }
      cursor++;
    }
  }
  visit();
  return duplicate;
}

/** Conservative rejection of transport locations, executable text and recognizable credentials.
 * Machine identifiers have narrower schemas; summary is reference data, never executable. */
function unsafeString(value: string, referenceOnly = false): boolean {
  const credential = new RegExp("(?:gh[pousr]_" + "[A-Za-z0-9]{20,}|github_pat_" + "[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)" + "[A-Z0-9]{16}|eyJ" + "[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+|xox[baprs]-" + "[A-Za-z0-9-]{10,}|AIza" + "[A-Za-z0-9_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\\s+\\S+|(?:password|secret|token|api[_-]?key)\\s*[:=]\\s*\\S+)", "i");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject forbidden controls in decoded external data.
  return /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
    || (!referenceOnly && /(?:[a-z][a-z0-9+.-]*:\/\/|\b(?:https?|ftp|ssh|git|mailto|data|javascript|file):|\bwww\.|(?:^|\s)(?:\/|\\\\|[A-Za-z]:[\\/]|~[\\/])|\$\(|`|\b(?:sh|bash|zsh|cmd|powershell)\s|(?:^|\s)(?:curl|wget|sudo|exec|eval|docker|podman|rm|chmod|node|python|npm|pnpm|echo|printf|git|ls|cat|touch)\s|[;&|]{1,2}\s*\w)/iu.test(value))
    || credential.test(value);
}
function unsafePayload(value: unknown): boolean {
  if (typeof value === "string") return unsafeString(value);
  if (Array.isArray(value)) return value.some(unsafePayload);
  if (value !== null && typeof value === "object") return Object.entries(value).some(([key, item]) => unsafeString(key) || unsafePayload(item));
  return false;
}

export function parseVerificationResultV1(text: string): { ok: true; result: VerificationResultV1 } | { ok: false; code: VerificationReasonCode } {
  const invalid = { ok: false, code: "verify_contract_invalid" } as const;
  if (Buffer.byteLength(text, "utf8") > 16384) return invalid;
  try {
    const value: unknown = JSON.parse(text);
    if (hasDuplicateKeys(text)) return invalid;
    const parsed = wireSchema.safeParse(value);
    if (!parsed.success) return { ok: false, code: parsed.error.issues.some(issue => issue.path[0] === "evidence_refs") ? "verify_evidence_invalid" : "verify_contract_invalid" };
    const v = parsed.data;
    const { summary, ...fields } = v;
    if (unsafeString(summary, true) || unsafePayload(fields)) return invalid;
    if (Date.parse(v.started_at) > Date.parse(v.finished_at) || Date.parse(v.finished_at) > Date.parse(v.generated_at)
      || v.dedup_key !== verificationDedupKey(v)
      || (v.withdraws_result_id !== null && (v.outcome !== "cancelled" || v.withdraw_reason_code === null))
      || (v.withdraws_result_id === null && v.withdraw_reason_code !== null)) return invalid;
    return { ok: true, result: { ...v, summary: createExternalReference(`${v.result_id}:summary`, v.summary) } };
  } catch {
    return invalid;
  }
}

export function checkFreshness(result: VerificationResultV1, hostNowMs: number): VerificationCheck {
  const age = hostNowMs - Date.parse(result.generated_at);
  return Number.isFinite(age) && age <= VERIFICATION_TTL_MS && age >= -VERIFICATION_FUTURE_SKEW_MS
    ? { ok: true } : { ok: false, code: "verify_result_expired" };
}

export function checkTransportConclusion(result: VerificationResultV1, transport: { status: string; conclusion: string | null }): VerificationCheck {
  const terminalFailure = ["failure", "neutral", "cancelled", "timed_out", "action_required", "stale", "skipped"];
  const expected = result.withdraws_result_id !== null ? transport.conclusion === "cancelled"
    : result.outcome === "failed" ? transport.conclusion === "failure"
    : result.outcome === "passed" ? transport.conclusion === "success"
    : transport.conclusion !== null && terminalFailure.includes(transport.conclusion);
  return transport.status === "completed" && expected ? { ok: true } : { ok: false, code: "verify_contract_invalid" };
}
