// Domain schemas for the SQLite-backed osstack state (Zod).
// These describe persisted rows; the migrations module owns the DDL.
//
// Fields in `runs` match plan v0.6 8.4 (Eng Review default for "memory schema fields").

import { AutonomyRunState } from "@osstack/protocol";
import { z } from "zod";

// ──────────────────────────────────────────────────────────────────────
// IDs
// ──────────────────────────────────────────────────────────────────────

export const TaskIdSchema = z.string().min(1);
export const RunIdSchema = z.string().min(1);
export const EventIdSchema = z.string().min(1);
export const AgentIdSchema = z.string().min(1);

// ──────────────────────────────────────────────────────────────────────
// Task: a high-level work unit submitted by Hermes (or a human).
// One task → 1..N runs (retries / fallbacks count as separate runs).
// ──────────────────────────────────────────────────────────────────────

export const TaskRow = z.object({
  task_id: TaskIdSchema,
  title: z.string(),
  description: z.string().default(""),
  hermes_session_id: z.string().nullable().default(null),
  status: z.enum(["pending", "running", "done", "failed", "cancelled"]),
  created_at: z.number(),         // unix seconds
  updated_at: z.number(),
});
export type TaskRow = z.infer<typeof TaskRow>;

// ──────────────────────────────────────────────────────────────────────
// Run: one execution attempt of a task by a chosen agent + capability.
// ──────────────────────────────────────────────────────────────────────

export const RunOutcome = z.enum([
  "completed", "failed", "cancelled", "expired",
]);
export type RunOutcome = z.infer<typeof RunOutcome>;

export const LifecyclePhase = z.enum([
  "discover", "design", "architecture", "plan",
  "code", "review", "test", "build", "release", "retro",
]);
export type LifecyclePhase = z.infer<typeof LifecyclePhase>;

export const RunRow = z.object({
  run_id: RunIdSchema,
  task_id: TaskIdSchema,
  session_id: z.string(),
  agent_id: AgentIdSchema,
  capability_id: z.string(),
  phase: LifecyclePhase,
  outcome: RunOutcome.nullable().default(null),
  started_at: z.number(),
  completed_at: z.number().nullable().default(null),
  duration_ms: z.number().nullable().default(null),
  tokens_in: z.number().int().nonnegative().default(0),
  tokens_out: z.number().int().nonnegative().default(0),
  retry_count: z.number().int().nonnegative().default(0),
  human_intervention_count: z.number().int().nonnegative().default(0),
  pii_redacted_count: z.number().int().nonnegative().default(0),
  gbrain_page_id: z.string().nullable().default(null),
  hermes_session_id: z.string().nullable().default(null),
  // step-level checkpoint marker (D17 + E0 checkpoint granularity)
  last_step: z.string().nullable().default(null),
});
export type RunRow = z.infer<typeof RunRow>;

// ──────────────────────────────────────────────────────────────────────
// Event: the canonical event log. Hermes Run Adapter replay reads from here.
// payload is stored as JSON text in SQLite (validated against HermesEventSchema
// from @osstack/hermes-adapter before insert).
// ──────────────────────────────────────────────────────────────────────

export const EventRow = z.object({
  event_id: EventIdSchema,
  run_id: RunIdSchema,
  session_id: z.string(),
  seq: z.number().int().nonnegative(),
  type: z.string(),             // discriminator from HermesEvent
  created_at: z.number(),
  terminal: z.boolean().default(false),
  payload_json: z.string(),     // serialized; parsed lazily on read
});
export type EventRow = z.infer<typeof EventRow>;

// ──────────────────────────────────────────────────────────────────────
// Agent registry row
// ──────────────────────────────────────────────────────────────────────

export const AgentRow = z.object({
  agent_id: AgentIdSchema,
  display_name: z.string(),
  cost_tier: z.enum(["low", "mid", "high"]),
  last_seen_at: z.number().nullable().default(null),
  available: z.boolean().default(true),
});
export type AgentRow = z.infer<typeof AgentRow>;

// ──────────────────────────────────────────────────────────────────────
// Approval + Clarify (durable so they survive daemon restart, per RFC)
// ──────────────────────────────────────────────────────────────────────

export const ApprovalRow = z.object({
  approval_id: z.string(),
  run_id: RunIdSchema,
  status: z.enum(["pending", "accepted", "rejected", "timed_out"]),
  action_summary: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  requested_at: z.number(),
  resolved_at: z.number().nullable().default(null),
  choice: z.string().nullable().default(null),
});
export type ApprovalRow = z.infer<typeof ApprovalRow>;

// ──────────────────────────────────────────────────────────────────────
// Contract approval (R1.5) — approval record for an Execution Contract.
// A dedicated table (migration #8), NOT the run-coupled `approvals` above:
// a contract has no run at approval time. This row is the AUTHORITATIVE
// current lifecycle state (the kanban card is a best-effort projection).
// One row per contract; the same approval_id lives for the contract's
// whole lifecycle so the protocol ApprovalRequest / ApprovalDecision
// round-trip against one record. State machine:
//   pending --approve--> approved
//   pending|approved --revise--> revising --approve--> approved
//   any non-stopped --stop--> stopped (terminal)
// Every approve/revise/stop ALSO appends a ContractApprovalDecisionRow —
// the append-only history behind the `control status` trail.
// ──────────────────────────────────────────────────────────────────────

export const ContractApprovalRow = z.object({
  approval_id: z.string().min(1),
  contract_id: z.string().min(1),
  action: z.string().min(1),
  risk: z.enum(["low", "medium", "high"]),
  status: z.enum(["pending", "approved", "revising", "stopped"]),
  requested_at: z.number(),
  decided_by_type: z.enum(["human", "agent"]).nullable().default(null),
  decided_by_id: z.string().nullable().default(null),
  decided_at: z.number().nullable().default(null),
  reason: z.string().nullable().default(null),
  created_at: z.number(),
  updated_at: z.number(),
});
export type ContractApprovalRow = z.infer<typeof ContractApprovalRow>;

export const ContractApprovalDecisionRow = z.object({
  decision_id: z.string().min(1),
  approval_id: z.string().min(1),
  contract_id: z.string().min(1),
  action: z.enum(["approve", "revise", "stop"]),
  actor_type: z.enum(["human", "agent"]),
  actor_id: z.string().min(1),
  reason: z.string().nullable().default(null),
  decided_at: z.number(),
  created_at: z.number(),
});
export type ContractApprovalDecisionRow = z.infer<typeof ContractApprovalDecisionRow>;

export const ClarifyRow = z.object({
  clarify_id: z.string(),
  run_id: RunIdSchema,
  status: z.enum(["pending", "answered", "timed_out", "abandoned"]),
  question: z.string(),
  requested_at: z.number(),
  resolved_at: z.number().nullable().default(null),
  answer: z.string().nullable().default(null),
});
export type ClarifyRow = z.infer<typeof ClarifyRow>;

// ──────────────────────────────────────────────────────────────────────
// Memory facts (PartnerOS feedback loop)
//
// Each row is one durable statement of belief about a subject:
//   - subject_type:  "client" | "matter" | "workflow" | "tenant" | "agent"
//   - subject_id:    the foreign key into the relevant domain
//   - fact_type:     "preference" | "correction" | "constraint" | "observation"
//   - source_type:   how we learned it ("user_confirmation", "agent_inference",
//                    "telegram", "approval_note", "intent_extras")
//
// Why a generic table instead of a column per fact:
//   - PartnerOS's whole product premise is "every correction teaches the
//     system". The agents accumulate hundreds of small facts per client
//     over months. Trying to model them as columns would explode the
//     schema and lose provenance. A facts table with provenance + status
//     keeps the loop honest.
//
// `status` is "active" while the fact applies; "superseded" once a newer
// fact has replaced it; "archived" once a human says it's no longer true.
// This is preferred over hard delete so audits stay reconstructable.
//
// `confidence` is in [0, 1]. PartnerOS MVP writes 1.0 for user-confirmed
// facts and lower values for agent inferences.
// ──────────────────────────────────────────────────────────────────────

export const MemoryFactRow = z.object({
  fact_id: z.string().min(1),
  /**
   * Multi-tenant scope (migration #3). NULL means "default / unscoped" —
   * single-tenant installations don't need to set it. Tenant-scoped
   * reads MUST filter by tenant_id explicitly; the readFactsForSubject()
   * helper does this for you.
   */
  tenant_id: z.string().nullable().default(null),
  subject_type: z.enum(["client", "matter", "workflow", "tenant", "agent"]),
  subject_id: z.string(),
  fact_type: z.enum(["preference", "correction", "constraint", "observation"]),
  fact_text: z.string().min(1),
  source_type: z.enum([
    "user_confirmation",
    "agent_inference",
    "telegram",
    "approval_note",
    "intent_extras",
  ]),
  /** ID of the originating event (approval_id, message_id, intent_id…). Free-form. */
  source_id: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).default(1),
  status: z.enum(["active", "superseded", "archived"]).default("active"),
  created_at: z.number(),
  updated_at: z.number(),
});
export type MemoryFactRow = z.infer<typeof MemoryFactRow>;

export const PitfallLessonRow = z.object({
  pitfall_id: z.string().min(1),
  family: z.string().min(1),
  fingerprint: z.string().min(1),
  tech_stack_json: z.string(),
  symptom: z.string().min(1),
  resolution: z.string().min(1),
  /** Frozen legacy mixed counter; not evidence of verified effectiveness. */
  verified_count: z.number().int().nonnegative(),
  source_run_ids_json: z.string(),
  /** Explicit failure observations; legacy source history is not backfilled. */
  observation_run_ids_json: z.string().default("[]"),
  status: z.enum(["active", "archived"]).default("active"),
  tenant_id: z.string().nullable().default(null),
  created_at: z.number(),
  updated_at: z.number(),
  last_seen_at: z.number(),
});
export type PitfallLessonRow = z.infer<typeof PitfallLessonRow>;

// ──────────────────────────────────────────────────────────────────────
// Supervisor control plane (migration 6). Persisted rows for the recursive
// control plane. Timestamps are REAL epoch seconds; arrays are JSON strings;
// `adversarial` is stored 0/1 (SQLite has no boolean).
// ──────────────────────────────────────────────────────────────────────

export const FeedbackAssetRow = z.object({
  asset_id: z.string().min(1),
  repo_id: z.string().min(1),
  source_trace_id: z.string().min(1),
  kind: z.string().min(1),
  failure_family: z.string().min(1),
  summary: z.string().min(1),
  evidence_json: z.string(),
  suggested_storage_path: z.string().nullable().default(null),
  status: z.enum(["proposed", "accepted", "rejected", "superseded"]).default("proposed"),
  created_at: z.number(),
  updated_at: z.number(),
});
export type FeedbackAssetRow = z.infer<typeof FeedbackAssetRow>;

export const ImprovementProposalRow = z.object({
  proposal_id: z.string().min(1),
  repo_id: z.string().min(1),
  source_asset_ids_json: z.string(),
  target: z.string().min(1),
  risk: z.enum(["low", "medium", "high"]),
  title: z.string().min(1),
  rationale: z.string().min(1),
  proposed_changes_json: z.string(),
  required_gates_json: z.string(),
  status: z.enum(["draft", "needs_human", "approved", "applied", "rejected", "blocked"]).default("draft"),
  created_at: z.number(),
  updated_at: z.number(),
});
export type ImprovementProposalRow = z.infer<typeof ImprovementProposalRow>;

export const EvaluatorVersionRow = z.object({
  evaluator_id: z.string().min(1),
  repo_id: z.string().min(1),
  kind: z.string().min(1),
  version: z.string().min(1),
  title: z.string().min(1),
  rubric: z.string().min(1),
  implementation_ref: z.string().nullable().default(null),
  status: z.enum(["candidate", "frozen", "retired", "rejected"]).default("candidate"),
  created_at: z.number(),
  updated_at: z.number(),
});
export type EvaluatorVersionRow = z.infer<typeof EvaluatorVersionRow>;

export const EvaluatorEpochRow = z.object({
  epoch_id: z.string().min(1),
  repo_id: z.string().min(1),
  frozen_evaluator_id: z.string().min(1),
  started_at: z.number(),
  ended_at: z.number().nullable().default(null),
  anchor_case_ids_json: z.string(),
  challenger_evaluator_ids_json: z.string(),
  promotion_decision_json: z.string().nullable().default(null),
});
export type EvaluatorEpochRow = z.infer<typeof EvaluatorEpochRow>;

export const AnchorCaseRow = z.object({
  case_id: z.string().min(1),
  repo_id: z.string().min(1),
  source_trace_id: z.string().nullable().default(null),
  input_summary: z.string().min(1),
  expected_verdict: z.enum(["accept", "reject", "needs_human"]),
  expected_failure_family: z.string().nullable().default(null),
  evidence_refs_json: z.string(),
  // Stored as 0/1 in SQLite; the repository layer coerces to boolean.
  adversarial: z.number().int(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type AnchorCaseRow = z.infer<typeof AnchorCaseRow>;

export const ScoreQuarantineRow = z.object({
  quarantine_id: z.string().min(1),
  repo_id: z.string().min(1),
  score_id: z.string().min(1),
  evaluator_id: z.string().min(1),
  reason: z.string().min(1),
  created_at: z.number(),
});
export type ScoreQuarantineRow = z.infer<typeof ScoreQuarantineRow>;

// Guarded Git autonomy (migration 17). The transition trail is append-only
// authority; the projection is the O(1) crash-recovery checkpoint.
const AutonomySha256Text = z.string().regex(/^[a-f0-9]{64}$/);
const AutonomyPersistedJsonText = z.string().superRefine((value, context) => {
  try {
    JSON.parse(value);
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "value must be valid JSON text",
    });
  }
});

export const AutonomyRunTransitionRow = z
  .object({
    transition_id: z.string().min(1),
    autonomy_run_id: z.string().min(1),
    seq: z.number().int().positive(),
    from_state: AutonomyRunState.nullable(),
    to_state: AutonomyRunState,
    event_json: AutonomyPersistedJsonText,
    contract_decision_id: z.string().min(1).nullable(),
    occurred_at: z.number().finite(),
  })
  .strict();
export type AutonomyRunTransitionRow = z.infer<
  typeof AutonomyRunTransitionRow
>;

export const AutonomyRunProjectionRow = z
  .object({
    autonomy_run_id: z.string().min(1),
    task_id: z.string().min(1),
    repo_id: z.string().min(1),
    workspace_path: z.string().min(1),
    state: AutonomyRunState,
    revision: z.number().int().positive(),
    contract_sha256: AutonomySha256Text,
    diff_sha256: AutonomySha256Text.nullable(),
    preflight_risk_json: AutonomyPersistedJsonText.nullable(),
    post_diff_risk_json: AutonomyPersistedJsonText.nullable(),
    approval_json: AutonomyPersistedJsonText.nullable(),
    routing_json: AutonomyPersistedJsonText.nullable(),
    budget_json: AutonomyPersistedJsonText,
    attempt_json: AutonomyPersistedJsonText,
    candidate_proof_json: AutonomyPersistedJsonText.nullable(),
    git_delivery_json: AutonomyPersistedJsonText.nullable(),
    deploy_json: AutonomyPersistedJsonText.nullable(),
    rollback_json: AutonomyPersistedJsonText.nullable(),
    final_proof_json: AutonomyPersistedJsonText.nullable(),
    last_transition_id: z.string().min(1),
    created_at: z.number().finite(),
    updated_at: z.number().finite(),
  })
  .strict();
export type AutonomyRunProjectionRow = z.infer<
  typeof AutonomyRunProjectionRow
>;

export const AutonomyDeployFreezeRow = z
  .object({
    repo_id: z.string().min(1),
    target: z.literal("production"),
    frozen: z.union([z.literal(0), z.literal(1)]),
    reason: z.string().min(1),
    source_run_id: z.string().min(1),
    frozen_at: z.number().finite(),
    cleared_at: z.number().finite().nullable(),
    cleared_by_type: z.literal("human").nullable(),
    cleared_by_id: z.string().min(1).nullable(),
    clear_reason: z.string().min(1).nullable(),
    clear_decision_sha256: AutonomySha256Text.nullable(),
    clear_key_id: z.string().min(1).nullable(),
  })
  .strict();
export type AutonomyDeployFreezeRow = z.infer<
  typeof AutonomyDeployFreezeRow
>;
// ──────────────────────────────────────────────────────────────────────
// Resumable native-agent sessions (migration #21)
// ──────────────────────────────────────────────────────────────────────

export const AgentSessionState = z.enum([
  "starting", "running", "awaiting_decision", "idle",
  "completed", "failed", "cancelled",
]);
export type AgentSessionState = z.infer<typeof AgentSessionState>;

export const AgentSessionRow = z.object({
  session_id: z.string().min(1),
  task_id: TaskIdSchema,
  run_id: RunIdSchema,
  agent_id: AgentIdSchema,
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  native_session_id: z.string().min(1).nullable(),
  repo_path: z.string().max(4096),
  state: AgentSessionState,
  resume_supported: z.boolean(),
  version: z.number().int().positive(),
  updated_at: z.number().nonnegative(),
}).strict();
export type AgentSessionRow = z.infer<typeof AgentSessionRow>;

export const SessionTurnRow = z.object({
  turn_id: z.string().min(1),
  session_id: z.string().min(1),
  ordinal: z.number().int().positive(),
  state: AgentSessionState,
  assistant_text: z.string(),
  decision_json: z.string().nullable(),
  created_at: z.number().nonnegative(),
  updated_at: z.number().nonnegative(),
}).strict();
export type SessionTurnRow = z.infer<typeof SessionTurnRow>;

export const SessionMessageRow = z.object({
  message_id: z.string().min(1),
  session_id: z.string().min(1),
  turn_id: z.string().min(1),
  direction: z.enum(["inbound", "outbound"]),
  kind: z.string().min(1),
  payload_json: z.string(),
  state: z.enum(["pending", "accepted", "applied", "failed"]),
  created_at: z.number().nonnegative(),
  applied_at: z.number().nonnegative().nullable(),
}).strict();
export type SessionMessageRow = z.infer<typeof SessionMessageRow>;
