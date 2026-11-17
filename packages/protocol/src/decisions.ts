import { z } from "zod";

export const DecisionSource = z.enum([
  "session", "contained_mission", "ci_repair", "revision_chain", "autonomy", "hermes", "loop",
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
  failures: z.array(z.object({ source: DecisionSource, code: z.enum(["read_failed", "permission_denied", "source_unavailable"]) }).strict()).max(7),
  next_cursor: z.string().max(2048).nullable(),
}).strict();
export type DecisionsListResult = z.infer<typeof DecisionsListResult>;
