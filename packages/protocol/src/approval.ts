// Approval shapes + the shared Actor identity.
//
// Extraction (architecture §1 / AGENT_COMMAND_PROTOCOL_V1 A-005): a minimal
// subset of core's ApprovalRow.
//   ApprovalRequest:  { approval_id, run_id?, action, risk, requested_at }
//   ApprovalDecision: { approval_id, approved, decided_by, decided_at, reason? }
//
// Actor lives here (used by both ApprovalDecision.decided_by and the command
// envelope's `actor`) so the dependency stays one-way (envelope -> approval),
// avoiding a schema-init cycle.
//
// A-007 deep leniency: consumer-side parsers must ignore unknown fields at
// EVERY level, not just the envelope top level — a v1.1 producer may add an
// optional field inside a nested object (e.g. actor.display_name). Each nested
// shape used by the lenient envelope parsers therefore also exports an explicit
// `.passthrough()` variant; the producer schemas stay deep-strict.

import { z } from "zod";

/**
 * A-005: `decided_by` is the FULL actor shape (type + id), never a bare id
 * string, so the A-004 human-actor rule is structurally checkable — a decision
 * whose `decided_by.type` is `agent` can be rejected at the policy layer unless
 * the profile delegates that category (`allowed_auto_changes`).
 */
const actorShape = {
  type: z.enum(["human", "agent"]),
  id: z.string().min(1),
} as const;

export const Actor = z.object(actorShape).strict();
export type Actor = z.infer<typeof Actor>;

/** Consumer-lenient Actor (A-007 deep leniency) — same shape, unknown fields ignored. */
export const ActorLenient = z.object(actorShape).passthrough();

/** Risk band of an action requiring approval. */
export const Risk = z.enum(["low", "medium", "high"]);
export type Risk = z.infer<typeof Risk>;

const approvalRequestShape = {
  approval_id: z.string().min(1),
  run_id: z.string().min(1).optional(),
  action: z.string().min(1),
  risk: Risk,
  requested_at: z.string().datetime(),
} as const;

export const ApprovalRequest = z.object(approvalRequestShape).strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

/** Consumer-lenient ApprovalRequest (A-007 deep leniency). */
export const ApprovalRequestLenient = z.object(approvalRequestShape).passthrough();

export const ApprovalDecision = z
  .object({
    approval_id: z.string().min(1),
    approved: z.boolean(),
    decided_by: Actor,
    decided_at: z.string().datetime(),
    reason: z.string().optional(),
  })
  .strict();
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;
