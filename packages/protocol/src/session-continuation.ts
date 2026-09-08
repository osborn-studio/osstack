import { z } from "zod";

const Id = z.string().trim().min(1).max(256);

export const SessionGateKind = z.enum([
  "phase_continue",
  "task_authorization",
  "risk_approval",
  "external_input",
]);
export type SessionGateKind = z.infer<typeof SessionGateKind>;

/** An agent-reported request, never a grant or proof that a gate passed. */
export const SessionContinuationRequest = z.object({
  version: z.literal(1),
  gate_kind: SessionGateKind,
  phase: Id,
  next_action: z.string().trim().min(1).max(1_000),
  evidence_refs: z.array(z.object({
    evidence_id: Id,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(32),
}).strict();
export type SessionContinuationRequest = z.infer<typeof SessionContinuationRequest>;

export const SessionDecision = z.object({
  decision_id: Id,
  question: z.string().trim().min(1).max(1_000),
  // Empty choices remain valid for legacy adapters requesting free-form input.
  choices: z.array(z.object({
    choice_id: Id,
    label: z.string().trim().min(1).max(160),
  }).strict()).max(8).refine(
    (choices) => new Set(choices.map((choice) => choice.choice_id)).size === choices.length,
    "choice IDs must be unique",
  ),
  continuation: SessionContinuationRequest.optional(),
}).strict();
export type SessionDecision = z.infer<typeof SessionDecision>;
