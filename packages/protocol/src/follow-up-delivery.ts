import { z } from "zod";
const text = (n: number) =>
  z
    .string()
    .min(1)
    .max(n)
    .refine((s) => {
      const bytes = new TextEncoder().encode(s);
      return (
        /[^\p{White_Space}\p{C}]/u.test(s) &&
        bytes.length <= n &&
        new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) === s
      );
    });
const id = z.string().uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  epoch = z.number().int().nonnegative().max(8_640_000_000_000_000),
  revision = z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER - 1);
const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const scope = { repo_path: text(4096), default_tenant: z.literal(true) };
export const FollowUpDeliveryTarget = z
  .object({
    destination_ref: ref,
    repo_path: text(4096),
    provider_id: z.literal("github_comment"),
    account_id: ref,
    host: z.literal("github.com"),
    owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/),
    repository: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/),
    issue_number: z.number().int().safe().positive(),
    target_node_id: text(256),
    actor_node_id: text(256),
  })
  .strict();
export type FollowUpDeliveryTarget = z.infer<typeof FollowUpDeliveryTarget>;
export const FollowUpDeliverySubject = z
  .object({
    domain: z.literal("osstack.follow-up-delivery.v1"),
    ...scope,
    attempt_id: id,
    provider_id: z.literal("github_comment"),
    account_id: ref,
    destination_digest: digest,
    body_sha256: digest,
    envelope_digest: digest,
  })
  .strict();
export const FollowUpDeliveryGrantBody = FollowUpDeliverySubject.extend({
  grant_id: id,
  issued_at_ms: epoch,
  expires_at_ms: epoch,
  max_calls: z.literal(1),
})
  .strict()
  .refine((g) => g.expires_at_ms > g.issued_at_ms);
export const SignedFollowUpDeliveryGrant = z
  .object({
    body: FollowUpDeliveryGrantBody,
    key_id: ref,
    signature: z.string().regex(/^[A-Za-z0-9+/]{85}[AQgw]==$/),
  })
  .strict();
export type SignedFollowUpDeliveryGrant = z.infer<typeof SignedFollowUpDeliveryGrant>;
export const FollowUpDeliveryEnvelope = z
  .object({
    ...scope,
    attempt_id: id,
    obligation_id: id,
    obligation_revision: revision,
    destination: FollowUpDeliveryTarget,
    destination_digest: digest,
    body: text(16000),
    body_sha256: digest,
    envelope_digest: digest,
  })
  .strict();
export type FollowUpDeliveryEnvelope = z.infer<typeof FollowUpDeliveryEnvelope>;
export const FollowUpDeliveryReceipt = z
  .object({
    provider_id: z.literal("github_comment"),
    account_id: ref,
    target_node_id: text(256),
    author_node_id: text(256),
    destination_digest: digest,
    body_sha256: digest,
    attempt_id: id,
    provider_message_id: text(256),
    provider_request_id: text(256),
  })
  .strict();
export type FollowUpDeliveryReceipt = z.infer<typeof FollowUpDeliveryReceipt>;
export const FollowUpDeliveryState = z.enum([
  "prepared",
  "started",
  "delivered",
  "delivery_unknown",
  "definitely_not_sent",
]);
const action = { ...scope, attempt_id: id, expected_revision: revision };
export const FollowUpDeliveryPrepareParams = z
  .object({
    ...scope,
    obligation_id: id,
    expected_obligation_revision: revision,
    destination_ref: ref,
    body: text(16000),
    idempotency_key: text(128),
  })
  .strict();
export const FollowUpDeliveryActionParams = z.object(action).strict();
export const FollowUpDeliveryAuthorizeParams = z
  .object({ ...action, grant: SignedFollowUpDeliveryGrant })
  .strict();
export const FollowUpDeliveryRevokeParams = z.object({ ...action, reason: text(1024) }).strict();
export const FollowUpDeliveryInspectParams = z.object({ ...scope, attempt_id: id }).strict();
export const FollowUpDeliveryListParams = z
  .object({
    ...scope,
    limit: z.number().int().min(1).max(50).default(20),
    after_id: id.transform((value) => value.toLowerCase()).optional(),
  })
  .strict();
export const FollowUpDeliveryAttempt = z
  .object({
    attempt_id: id,
    repo_path: text(4096),
    default_tenant: z.literal(true),
    obligation_id: id,
    obligation_revision: revision,
    state: FollowUpDeliveryState,
    revision,
    created_at_ms: epoch,
    updated_at_ms: epoch,
    envelope: FollowUpDeliveryEnvelope,
    authorization_subject: FollowUpDeliverySubject,
    authorization_status: z.enum(["missing", "active", "consumed", "revoked"]),
    qualification: z.enum([
      "qualification_pending",
      "test_only",
      "sandbox_qualified",
      "production_qualified",
    ]),
    receipt: FollowUpDeliveryReceipt.nullable(),
    receipt_sha256: digest.nullable(),
    reason: ref.nullable(),
    delivery_uncertain: z.boolean(),
    promise_fulfillment: z.literal("independent_local_obligation"),
  })
  .strict();
export type FollowUpDeliveryAttempt = z.infer<typeof FollowUpDeliveryAttempt>;
export const FollowUpDeliveryResult = z
  .object({
    schema_version: z.literal(1),
    outcome: z.enum([
      "prepared",
      "authorized",
      "revoked",
      "delivered",
      "delivery_unknown",
      "in_flight",
      "qualification_pending",
      "unchanged",
    ]),
    attempt: FollowUpDeliveryAttempt,
    duplicate: z.boolean(),
  })
  .strict();
export type FollowUpDeliveryResult = z.infer<typeof FollowUpDeliveryResult>;
export const FollowUpDeliveryListItem = FollowUpDeliveryAttempt.omit({
  envelope: true,
  authorization_subject: true,
  receipt: true,
}).extend({ destination_ref: ref, body_sha256: digest });
export const FollowUpDeliveryListResult = z
  .object({
    schema_version: z.literal(1),
    scope: z.object(scope).strict(),
    attempts: z.array(FollowUpDeliveryListItem).max(50),
    next_after_id: id.nullable(),
  })
  .strict();
export type FollowUpDeliveryListResult = z.infer<typeof FollowUpDeliveryListResult>;
