import { z } from "zod";
import { verificationDigestSchema, verificationIdSchema, verificationNumericIdSchema, VERIFICATION_TTL_MS,
  type VerificationReasonCode } from "./verification-result.js";

const common = {
  repository_id: verificationNumericIdSchema, skill_id: verificationIdSchema, skill_manifest_digest: verificationDigestSchema,
  profile_id: verificationIdSchema, profile_digest: verificationDigestSchema,
  allowed_failure_codes: z.array(verificationIdSchema).min(1).max(128).refine(codes => new Set(codes).size === codes.length),
  ttl_ms: z.number().int().positive().max(VERIFICATION_TTL_MS), evidence_store: verificationIdSchema,
  auto_registration: z.boolean().default(false),
};
const policySchema = z.object({ schema_version: z.literal(1), producers: z.array(z.discriminatedUnion("type", [
  z.object({ ...common, type: z.literal("App"), app_id: verificationNumericIdSchema,
    installation_id: verificationNumericIdSchema, carrier: z.literal("check-run").default("check-run") }).strict(),
  // Representable for future explicitly approved readers; never enabled by the matcher below.
  z.object({ ...common, type: z.literal("User"), actor_id: verificationNumericIdSchema, app_id: z.null(),
    carrier: z.enum(["status", "review"]) }).strict(),
])).max(128) }).strict();
export type VerificationProducerPolicyV1 = z.infer<typeof policySchema>;

/** No policy means closed intake. Invalid nonempty configuration is an error, never a fallback. */
export function parseVerificationProducerPolicyV1(value: unknown):
  { ok: true; policy: VerificationProducerPolicyV1 } | { ok: false; code: VerificationReasonCode } {
  if (value == null || (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)) {
    return { ok: true, policy: { schema_version: 1, producers: [] } };
  }
  const result = policySchema.safeParse(value);
  return result.success ? { ok: true, policy: result.data } : { ok: false, code: "verify_contract_invalid" };
}

/** Identity must come from authenticated API observations. Installation scope must be
 * independently verified by the caller; a payload producer object is never an observation. */
export interface ObservedVerificationProducer {
  type: string; app_id: number | null; installation_id?: number; actor_id?: number;
  repository_id: number; carrier: string; skill_id: string; skill_manifest_digest: string;
  profile_id: string; profile_digest: string; failure_code: string | null;
}

/** A match only permits diagnosis registration. It conveys no execution or push authority. */
export function matchVerificationProducer(policy: VerificationProducerPolicyV1 | null | undefined, observed: ObservedVerificationProducer):
  { ok: true; producer: VerificationProducerPolicyV1["producers"][number] } | { ok: false; code: VerificationReasonCode } {
  const candidates = policy?.producers.filter(p => p.type === "App" && observed.type === "App"
    && observed.carrier === "check-run" && p.carrier === "check-run" && p.app_id === observed.app_id
    && p.installation_id === observed.installation_id) ?? [];
  if (!candidates.length) return { ok: false, code: "verify_producer_untrusted" };
  const scoped = candidates.filter(p => p.repository_id === observed.repository_id);
  if (!scoped.length) return { ok: false, code: "verify_scope_unregistered" };
  const bound = scoped.filter(p => p.skill_id === observed.skill_id && p.skill_manifest_digest === observed.skill_manifest_digest
    && p.profile_id === observed.profile_id && p.profile_digest === observed.profile_digest);
  const producer = bound.find(p => observed.failure_code === null || p.allowed_failure_codes.includes(observed.failure_code));
  return producer ? { ok: true, producer } : { ok: false, code: "verify_skill_unregistered" };
}
