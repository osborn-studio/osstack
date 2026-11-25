import { z } from "zod";

export const DecisionSource = z.enum([
  "session", "contained_mission", "ci_repair", "revision_chain", "autonomy", "hermes", "loop", "probe",
]);
export type DecisionSource = z.infer<typeof DecisionSource>;
export const DecisionsListParams = z.object({
  credential: z.string().min(32).max(4096).optional(),
  scope_id: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
}).strict();
export type DecisionsListParams = z.infer<typeof DecisionsListParams>;
export const PendingDecision = z.object({
  source: DecisionSource,
  source_id: z.string().min(1).max(1024),
  scope_id: z.string().nullable(),
  // Epoch milliseconds. Null means the waiting entry is not in a durable journal.
  waiting_since: z.number().finite().nonnegative().nullable(),
  summary: z.string().max(240).refine(s => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s), "single line"),
  allowed_answers: z.array(z.string().max(256)).max(16),
  answer_command: z.object({ name: z.string().max(128), required_params: z.array(z.string().max(128)).max(16),
    alternatives: z.array(z.object({ name: z.string().max(128), required_params: z.array(z.string().max(128)).max(16) }).strict()).max(4).optional(),
  }).strict(),
  requires_local_signature: z.boolean(),
  source_revision: z.string().max(128).nullable(),
}).strict();
export type PendingDecision = z.infer<typeof PendingDecision>;
export const DecisionsListResult = z.object({
  items: z.array(PendingDecision).max(100),
  failures: z.array(z.object({ source: DecisionSource, code: z.enum(["read_failed", "permission_denied", "source_unavailable"]) }).strict()).max(8),
  next_cursor: z.string().max(2048).nullable(),
}).strict();
export type DecisionsListResult = z.infer<typeof DecisionsListResult>;

export const DecisionsAnswerParams = z.object({
  credential: z.string().min(32).max(4096),
  source: DecisionSource,
  source_id: z.string().min(1).max(1024),
  answer: z.string().min(1).max(256),
  params: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.string().max(16000)).refine(value => Object.keys(value).length <= 16).default({}),
  answer_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  source_revision: z.string().min(1).max(128),
}).strict();
export type DecisionsAnswerParams = z.infer<typeof DecisionsAnswerParams>;
export const DecisionsAnswerResult = z.object({
  accepted: z.boolean(),
  replay: z.boolean(),
  outcome: z.enum(["applied", "accepted", "unknown", "conflict", "stale", "local_only", "not_answerable", "refused"]),
  code: z.string().max(128).nullable(),
  current: z.object({ state: z.string().max(128), item: PendingDecision.nullable() }).strict(),
  local_command: z.string().max(128).optional(),
}).strict();
export type DecisionsAnswerResult = z.infer<typeof DecisionsAnswerResult>;

const probeId = z.string().regex(/^[0-9a-f]{32}$/);
export const DecisionsTryCreateParams = DecisionsAnswerParams.pick({ credential: true });
export const DecisionsTryStatusParams = DecisionsTryCreateParams.extend({ probe_id: probeId });
export const DecisionsTryContinueParams = DecisionsTryStatusParams;
export const DecisionsTryResult = z.object({
  probe_id: probeId,
  state: z.enum(["pending", "answered", "continued", "expired"]),
  revision: z.number().int().positive(),
  created_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
  answer: z.string().nullable(),
  continued_at: z.number().int().nonnegative().nullable(),
  created: z.boolean().optional(),
}).strict();
export type DecisionsTryResult = z.infer<typeof DecisionsTryResult>;
