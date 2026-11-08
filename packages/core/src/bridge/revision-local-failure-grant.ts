import { createHash, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { VerificationProfileIdSchema } from "./verification-profile-id.js";
import {
  GRANT_LIMITS, RevisionGrantError, RevisionGrantPreviewSchema, RevisionGrantSchema, canonicalJson,
} from "./revision-grant.js";

/** Offline V2 contract only. No admission, clock, profile loading, store or scanner wiring.
 * V1 grants remain review-only. Adding this capability requires a newly signed V2 preview.
 */
export const LOCAL_FAILURE_SIGNING_DOMAIN = "osstack.revision-grant.v2";

const v1Fields = RevisionGrantPreviewSchema.innerType().shape;

/** Required explicit opt-in. Trusted source identifies an artifact; it never supplies commands.
 * Profile IDs use the installed-profile ASCII identity grammar (1–128 characters). Digests are lowercase SHA-256.
 */
export const LocalFailureOptInSchema = z.object({
  enabled: z.literal(true),
  profile_id: VerificationProfileIdSchema,
  profile_digest: v1Fields.protected_set_digest,
  trusted_source: z.object({
    repository: v1Fields.repository,
    commit: v1Fields.base_sha,
    artifact_digest: v1Fields.protected_set_digest,
  }).strict(),
  diagnostic_timeout_seconds: z.number().int().min(1).max(GRANT_LIMITS.max_budget.max_container_seconds),
  max_diagnostics_per_head: z.literal(1),
}).strict();
export type LocalFailureOptIn = z.infer<typeof LocalFailureOptInSchema>;

const previewObject = RevisionGrantPreviewSchema.innerType().extend({
  version: z.literal(2), local_failure: LocalFailureOptInSchema,
});

function validatePreview(value: z.infer<typeof previewObject>, ctx: z.RefinementCtx): void {
  const { local_failure, ...shared } = value;
  // Delegate all inherited rules (including the validity window) to V1. No copied defaults.
  const inherited = RevisionGrantPreviewSchema.safeParse({ ...shared, version: 1 });
  if (!inherited.success) for (const issue of inherited.error.issues) ctx.addIssue(issue);
  // Diagnostics spend container time, not executor time. Admission must also check remaining usage.
  if (local_failure.diagnostic_timeout_seconds > value.budget.max_container_seconds
    || local_failure.diagnostic_timeout_seconds > value.budget.max_wall_clock_hours * 3600) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["local_failure", "diagnostic_timeout_seconds"], message: "diagnostic_budget" });
  }
}

function fitsColumn(value: unknown): boolean {
  try { return Buffer.byteLength(canonicalJson(value)) <= GRANT_LIMITS.max_json_bytes; }
  catch { return false; }
}

export const LocalFailureGrantPreviewSchema = previewObject.superRefine(validatePreview).refine(fitsColumn, "grant_size");
export const LocalFailureRevisionGrantSchema = previewObject.extend(
  RevisionGrantSchema.innerType().pick({ preview_sha256: true, signature: true }).shape,
).superRefine((value, ctx) => {
  const { preview_sha256: _digest, signature: _signature, ...preview } = value;
  validatePreview(preview, ctx);
}).refine(fitsColumn, "grant_size");
export type LocalFailureGrantPreview = z.infer<typeof LocalFailureGrantPreviewSchema>;
export type LocalFailureRevisionGrant = z.infer<typeof LocalFailureRevisionGrantSchema>;

/** Strict object parser. No opt-in or inherited terms are defaulted. Throws `grant_invalid`. */
export function parseLocalFailureGrantPreview(value: unknown): LocalFailureGrantPreview {
  const parsed = LocalFailureGrantPreviewSchema.safeParse(value);
  if (!parsed.success) throw new RevisionGrantError("grant_invalid");
  return parsed.data;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export function localFailurePreviewDigest(preview: LocalFailureGrantPreview): string {
  return sha256(canonicalJson(parseLocalFailureGrantPreview(preview)));
}

/** Ed25519 signs the V2 domain, complete canonical preview and its SHA-256 digest. */
export function localFailureRevisionGrantSigningInput(preview: LocalFailureGrantPreview): Buffer {
  const p = parseLocalFailureGrantPreview(preview);
  return Buffer.from(canonicalJson({
    domain: LOCAL_FAILURE_SIGNING_DOMAIN, preview: p, preview_sha256: sha256(canonicalJson(p)),
  }));
}

export function signLocalFailureRevisionGrant(preview: LocalFailureGrantPreview, privateKey: KeyObject): LocalFailureRevisionGrant {
  if (privateKey.asymmetricKeyType !== "ed25519") throw new RevisionGrantError("grant_signature_invalid");
  const p = parseLocalFailureGrantPreview(preview);
  const grant = {
    ...p, preview_sha256: localFailurePreviewDigest(p),
    signature: sign(null, localFailureRevisionGrantSigningInput(p), privateKey).toString("base64"),
  };
  // A preview that fits can still exceed the column cap once signed.
  return parseLocalFailureRevisionGrant(JSON.stringify(grant));
}

/** Strict stored JSON parser, including the raw UTF-8 byte cap (4096). Does not verify authority.
 * Historical grants remain readable. Callers must enforce now < expires_at at every authority fence.
 */
export function parseLocalFailureRevisionGrant(grantJson: string): LocalFailureRevisionGrant {
  if (Buffer.byteLength(grantJson) > GRANT_LIMITS.max_json_bytes) throw new RevisionGrantError("grant_invalid");
  let value: unknown;
  try { value = JSON.parse(grantJson); } catch { throw new RevisionGrantError("grant_invalid"); }
  const parsed = LocalFailureRevisionGrantSchema.safeParse(value);
  if (!parsed.success) throw new RevisionGrantError("grant_invalid");
  return parsed.data;
}

/** Cryptographic check only, as in V1. Never throws; does not check time, revocation or host binding. */
export function verifyLocalFailureRevisionGrantSignature(grant: LocalFailureRevisionGrant, publicKey: KeyObject): boolean {
  try {
    if (publicKey.asymmetricKeyType !== "ed25519") return false;
    const parsed = LocalFailureRevisionGrantSchema.safeParse(grant);
    if (!parsed.success) return false;
    const { preview_sha256, signature, ...preview } = parsed.data;
    if (localFailurePreviewDigest(preview) !== preview_sha256) return false;
    return verify(null, localFailureRevisionGrantSigningInput(preview), publicKey, Buffer.from(signature, "base64"));
  } catch { return false; }
}
