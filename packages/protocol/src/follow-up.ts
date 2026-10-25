import { z } from "zod";
const text = (bytes: number) => z.string().min(1).max(bytes).refine(value => /[^\p{White_Space}\p{C}]/u.test(value) && new TextEncoder().encode(value).length <= bytes);
const epoch = z.number().int().nonnegative().max(8_640_000_000_000_000);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1);
const scope = { repo_path: text(4096), default_tenant: z.literal(true) };
const identity = { obligation_id: z.string().uuid(), expected_revision: revision };
export const FollowUpState = z.enum(["open", "drafted", "fulfilled_local", "waived"]);
export const FollowUpCreateParams = z.object({ ...scope, source_session_id: text(256), expected_source_version: revision,
  idempotency_key: text(128), actor: text(128), promise: text(4096), destination_ref: z.literal("local_operator"),
  resolution_condition: z.enum(["manual", "session_completed"]), due_at: epoch.nullable().default(null),
}).strict();
export const FollowUpListParams = z.object({ ...scope, limit: z.number().int().min(1).max(50).default(20), cursor: z.string().min(1).max(1024).optional(), state: FollowUpState.optional() }).strict();
export const FollowUpDraftParams = z.object({ ...scope, ...identity, actor: text(128) }).strict();
export const FollowUpResolveParams = z.object({ ...scope, ...identity, actor: text(128), reason: text(1024), mode: z.enum(["waive", "condition"]) }).strict();
export const FollowUpSourceSnapshot = z.object({ state: z.enum(["starting", "running", "awaiting_decision", "idle", "completed", "failed", "cancelled"]), version: revision, updated_at: epoch }).strict();
const draft = z.object({ text: text(8192), content_digest: z.string().regex(/^[a-f0-9]{64}$/), source: FollowUpSourceSnapshot.nullable(), source_missing: z.boolean(), created_at: epoch, delivery_state: z.literal("unsent") }).strict();
const resolution = z.object({ mode: z.enum(["waive", "condition"]), actor: text(128), reason: text(1024), source: FollowUpSourceSnapshot.nullable(), resolved_at: epoch, external_delivery: z.literal("unsupported") }).strict();
export const FollowUpObligation = z.object({ ...scope, obligation_id: z.string().uuid(), source_session_id: text(256), source_task_id: text(256), source_run_id: text(256), source_creation_version: revision, source_identity_digest: z.string().regex(/^[a-f0-9]{64}$/),
  actor: text(128), promise: text(4096), destination_ref: z.literal("local_operator"), resolution_condition: z.enum(["manual", "session_completed"]), due_at: epoch.nullable(),
  state: FollowUpState, revision, created_at: epoch, updated_at: epoch, draft: draft.nullable(), resolution: resolution.nullable(),
  source: FollowUpSourceSnapshot.nullable(), source_missing: z.boolean(), external_delivery: z.literal("unsupported"),
}).strict();
export const FollowUpMutationResult = z.object({ schema_version: z.literal(1), obligation: FollowUpObligation, duplicate: z.boolean() }).strict();
export const FollowUpListItem = FollowUpObligation.omit({ promise: true, draft: true, resolution: true }).extend({ promise_preview: z.string().max(160), has_draft: z.boolean() });
export const FollowUpListResult = z.object({ schema_version: z.literal(1), scope: z.object(scope).strict(), sampled_at_ms: epoch,
  obligations: z.array(FollowUpListItem).max(50), next_cursor: z.string().max(1024).nullable(), overdue_count: z.number().int().nonnegative(), external_delivery: z.literal("unsupported"),
}).strict();
export type FollowUpCreateParams = z.infer<typeof FollowUpCreateParams>;
export type FollowUpListParams = z.infer<typeof FollowUpListParams>;
export type FollowUpDraftParams = z.infer<typeof FollowUpDraftParams>;
export type FollowUpResolveParams = z.infer<typeof FollowUpResolveParams>;
export type FollowUpObligation = z.infer<typeof FollowUpObligation>;
export type FollowUpMutationResult = z.infer<typeof FollowUpMutationResult>;
export type FollowUpListResult = z.infer<typeof FollowUpListResult>;
export type FollowUpSourceSnapshot = z.infer<typeof FollowUpSourceSnapshot>;
