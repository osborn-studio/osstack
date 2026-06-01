// Domain schemas for the SQLite-backed osstack state (Zod).
// These describe persisted rows; the migrations module owns the DDL.
//
// Fields in `runs` match plan v0.6 8.4 (Eng Review default for "memory schema fields").

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
