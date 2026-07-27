// Hermes Run Adapter Contract — event schemas (zod).
// Source: hermes-webui/docs/rfcs/hermes-run-adapter-contract.md
//
// 13 event families. Every event is wrapped in a common Envelope so the
// runtime can replay by (run_id, seq) and the browser can deduplicate.

import { z } from "zod";

// ──────────────────────────────────────────────────────────────────────
// Envelope (shared by every event family)
// ──────────────────────────────────────────────────────────────────────

export const EventEnvelopeBase = z.object({
  event_id: z.string(),            // stable cursor (e.g. "run_123:42")
  seq: z.number().int().nonnegative(),
  run_id: z.string(),
  session_id: z.string(),
  created_at: z.number(),          // unix seconds, float OK
  terminal: z.boolean().default(false),
});

// ──────────────────────────────────────────────────────────────────────
// Event family payloads
// ──────────────────────────────────────────────────────────────────────

// Lifecycle controls available to the browser at this moment. Snapshot,
// not delta — every status event carries the current set.
export const ControlSetSchema = z.object({
  cancel: z.boolean(),
  approval_pending: z.boolean(),
  clarify_pending: z.boolean(),
  queue: z.boolean(),
  goal: z.boolean(),
});

export const RunStartedPayload = z.object({
  status: z.literal("running"),
  controls: ControlSetSchema,
  workspace: z.string().optional(),
  profile: z.string().optional(),
  model: z.string().optional(),
  toolset: z.array(z.string()).optional(),
});

export const StatusPayload = z.object({
  status: z.enum([
    "queued", "running", "awaiting_approval", "awaiting_clarify",
    "paused", "cancelling", "cancelled", "failed", "completed", "expired",
  ]),
  controls: ControlSetSchema,
  detail: z.string().optional(),
});

export const TokenDeltaPayload = z.object({
  message_id: z.string(),
  segment_id: z.string().optional(),
  delta: z.string(),
  content_type: z.enum(["text", "code", "thinking"]).default("text"),
});

export const ReasoningDeltaPayload = z.object({
  block_id: z.string(),
  delta: z.string(),
  visibility: z.enum(["visible", "collapsed", "hidden"]).default("visible"),
});

export const ReasoningDonePayload = z.object({
  block_id: z.string(),
  final: z.string(),
});

export const ProgressPayload = z.object({
  phase: z.string(),
  detail: z.string().optional(),
  tool_id: z.string().optional(),
});

export const ToolStartedPayload = z.object({
  tool_call_id: z.string(),
  name: z.string(),
  args: z.unknown(),               // sanitized; PII redactor runs upstream
  started_at: z.number(),
});

export const ToolUpdatedPayload = z.object({
  tool_call_id: z.string(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  partial: z.unknown().optional(),
  progress_pct: z.number().min(0).max(100).optional(),
});

export const ToolDonePayload = z.object({
  tool_call_id: z.string(),
  result: z.unknown(),
  exit_code: z.number().int().optional(),
  duration_ms: z.number().nonnegative(),
  error: z.boolean().default(false),
});

export const ApprovalRequestedPayload = z.object({
  approval_id: z.string(),
  action_summary: z.string(),
  risk: z.enum(["low", "medium", "high"]).default("medium"),
  choices: z.array(z.string()).min(1),
});

export const ApprovalResolvedPayload = z.object({
  approval_id: z.string(),
  choice: z.string(),
  status: z.enum(["accepted", "rejected", "timed_out"]),
});

export const ClarifyRequestedPayload = z.object({
  clarify_id: z.string(),
  question: z.string(),
  choices: z.array(z.string()).optional(),
  input_mode: z.enum(["choice", "free_text"]).default("free_text"),
});

export const ClarifyResolvedPayload = z.object({
  clarify_id: z.string(),
  answer: z.string(),
  status: z.enum(["answered", "timed_out", "abandoned"]),
});

export const TitleUpdatedPayload = z.object({
  title: z.string(),
  source: z.enum(["model", "user", "system"]).default("model"),
  confidence: z.number().min(0).max(1).optional(),
});

export const UsageUpdatedPayload = z.object({
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
});

export const UsageFinalPayload = UsageUpdatedPayload.extend({
  duration_ms: z.number().nonnegative(),
});

export const ErrorPayload = z.object({
  code: z.string(),                // stable, e.g. "agent_timeout"
  message: z.string(),             // safe-for-display
  detail: z.string().optional(),   // redacted diagnostics
  terminal: z.boolean(),
});

export const ReviewRuntimeIdentitySchema = z.object({
  adapter_id: z.string().min(1),
  adapter_version: z.string().min(1),
  auth_mode: z.string().min(1),
  provider_id: z.string().min(1),
  model_id: z.string().min(1),
  model_context_window: z.number().int().positive().optional(),
  reasoning_effort: z.string().min(1).optional(),
  agent_profile: z.string().min(1).optional(),
  binary_path_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  evidence_source: z.enum(["reported", "configured", "inferred"]),
}).strict();

export const ReviewJudgmentSchema = z.object({
  id: z.string().min(1),
  pass: z.boolean(),
  severity: z.enum(["warning", "error"]),
  summary: z.string().min(1),
}).strict();

export const ReviewFindingSchema = z.object({
  rule_id: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  severity: z.enum(["info", "warning", "error"]),
  message: z.string().min(1),
  file: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  evidence: z.string().min(1).optional(),
}).strict();

export const StructuredReviewSchema = z.object({
  schema_version: z.literal(1),
  verdict: z.enum([
    "approved",
    "changes_requested",
    "blocked",
    "inconclusive",
  ]),
  risk: z.enum(["read_only", "low", "medium", "high", "forbidden"]),
  markdown: z.string().min(1),
  judgments: z.array(ReviewJudgmentSchema).max(100),
  findings: z.array(ReviewFindingSchema).max(100),
  recommended_actions: z.array(z.string().min(1)).max(100),
  evidence_refs: z.array(z.string().min(1)).max(100),
  runtime_identity: ReviewRuntimeIdentitySchema,
}).strict();

export const DonePayload = z.object({
  status: z.enum(["completed", "failed", "cancelled", "expired"]),
  last_seq: z.number().int().nonnegative(),
  usage: UsageFinalPayload.optional(),
  result_summary: z.string().optional(),
  /** Optional application-neutral structured verifier extensions. */
  evaluation_judgments: z.unknown().optional(),
  implementation_deviations: z.array(z.record(z.unknown())).max(100).optional(),
  review: StructuredReviewSchema.optional(),
});

// ──────────────────────────────────────────────────────────────────────
// Discriminated union of all 13 event families
// ──────────────────────────────────────────────────────────────────────

const make = <T extends z.ZodTypeAny>(type: string, payload: T) =>
  EventEnvelopeBase.extend({
    type: z.literal(type),
    payload,
  });

export const HermesEventSchema = z.discriminatedUnion("type", [
  make("run.started", RunStartedPayload),
  make("status", StatusPayload),
  make("token.delta", TokenDeltaPayload),
  make("reasoning.delta", ReasoningDeltaPayload),
  make("reasoning.done", ReasoningDonePayload),
  make("progress", ProgressPayload),
  make("tool.started", ToolStartedPayload),
  make("tool.updated", ToolUpdatedPayload),
  make("tool.done", ToolDonePayload),
  make("approval.requested", ApprovalRequestedPayload),
  make("approval.resolved", ApprovalResolvedPayload),
  make("clarify.requested", ClarifyRequestedPayload),
  make("clarify.resolved", ClarifyResolvedPayload),
  make("title.updated", TitleUpdatedPayload),
  make("usage.updated", UsageUpdatedPayload),
  make("usage.final", UsageFinalPayload),
  make("error", ErrorPayload),
  make("done", DonePayload),
]);

export type HermesEvent = z.infer<typeof HermesEventSchema>;
export type HermesEventType = HermesEvent["type"];

// ──────────────────────────────────────────────────────────────────────
// 7 control types (browser → runtime requests)
// ──────────────────────────────────────────────────────────────────────

export const ObserveControl = z.object({
  type: z.literal("observe"),
  run_id: z.string(),
  after_seq: z.number().int().nonnegative().optional(),
  last_event_id: z.string().optional(),
});

export const StatusControl = z.object({
  type: z.literal("status"),
  run_id: z.string(),
});

export const CancelControl = z.object({
  type: z.literal("cancel"),
  run_id: z.string(),
  reason: z.string().optional(),
});

export const QueueControl = z.object({
  type: z.literal("queue"),
  run_id: z.string(),
  prompt: z.string(),
});

export const ApprovalControl = z.object({
  type: z.literal("approval"),
  approval_id: z.string(),
  choice: z.string(),
});

export const ClarifyControl = z.object({
  type: z.literal("clarify"),
  clarify_id: z.string(),
  answer: z.string(),
});

export const GoalControl = z.object({
  type: z.literal("goal"),
  run_id: z.string(),
  op: z.enum(["set", "status", "pause", "resume", "clear"]),
  goal: z.string().optional(),
});

export const HermesControlSchema = z.discriminatedUnion("type", [
  ObserveControl, StatusControl, CancelControl, QueueControl,
  ApprovalControl, ClarifyControl, GoalControl,
]);

export type HermesControl = z.infer<typeof HermesControlSchema>;
export type HermesControlType = HermesControl["type"];
