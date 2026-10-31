// Loop layer types — the vocabulary of the osstack Loop Engineering system.
//
// Aligned with the LE five-stage cycle:
//   Discover → Plan → Execute → Verify → Iterate
//
// And the six LE primitives:
//   Automations / Worktrees / Skills / Connectors / Sub-agents / State

import { z } from "zod";
import { LoopBudgetStatus } from "./budget.js";
import { TaskAuthorization } from "./discovery-policy.js";
import { EvaluationResult, EvaluationSpec } from "./evaluation-spec.js";
import { CandidateBatchBinding, CandidateEvidence } from "./candidate-policy.js";

// ── Discover phase ────────────────────────────────────────────────────

export const DiscoverSource = z.enum([
  "git_diff",
  "gh_issue",
  "github_branch",
  "ci_log",
  "task_queue",
  "manual",
]);
export type DiscoverSource = z.infer<typeof DiscoverSource>;

/** A unit of work discovered by a scanner. */
export const Task = z.object({
  task_id: z.string(),
  /** Capability kind needed, e.g. "code.fix", "review.code" */
  capability: z.string(),
  /** Natural-language prompt the agent will receive */
  prompt: z.string(),
  priority: z.number().min(0).max(100).default(50),
  source: DiscoverSource,
  /** Optional structured context (file paths, line ranges, error messages) */
  context: z.record(z.unknown()).optional(),
  /** First-class evaluation harness specs. Verifier emits per-spec results. */
  evaluation: z.array(EvaluationSpec).optional(),
  candidateBatch: CandidateBatchBinding.optional(),
});
export type Task = z.infer<typeof Task>;

// ── Plan phase ─────────────────────────────────────────────────────────

export const StopConditionType = z.enum([
  "tests_pass",
  "lint_clean",
  "typecheck_clean",
  "review_approved",
  "max_iterations",
  "custom",
]);
export type StopConditionType = z.infer<typeof StopConditionType>;

export const StopCondition = z.object({
  type: StopConditionType,
  params: z.record(z.string()).optional(),
});
export type StopCondition = z.infer<typeof StopCondition>;

/** The output of planning: which agent, where, how many tries, when to stop. */
export const ExecutionPlan = z.object({
  plan_id: z.string(),
  task: Task,
  agent_id: z.string(),
  worktree_path: z.string().optional(),
  max_iterations: z.number().min(1).max(10).default(3),
  stop_condition: StopCondition,
});
export type ExecutionPlan = z.infer<typeof ExecutionPlan>;

// ── Execute phase ──────────────────────────────────────────────────────
// (reuses @osstack/agents AgentTask + AgentAdapter, not re-defined here)

// ── Verify phase ───────────────────────────────────────────────────────

export const IssueSeverity = z.enum(["error", "warning", "info"]);
export type IssueSeverity = z.infer<typeof IssueSeverity>;

export const Issue = z.object({
  severity: IssueSeverity,
  file: z.string().optional(),
  line: z.number().optional(),
  message: z.string(),
  rule: z.string().optional(),
});
export type Issue = z.infer<typeof Issue>;

/**
 * A verifier-reported difference between the agreed design and the observed
 * implementation. This stays deliberately product-neutral: consumers decide
 * whether and how to turn the signal into follow-up work.
 */
export const ImplementationDeviation = z
  .object({
    deviation_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,127}$/),
    question: z.string().trim().min(1).max(4_000),
    category: z.string().trim().min(1).max(128),
    doc_type: z.enum(["product", "tech", "test"]),
    impact: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    irreversibility: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    uncertainty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    required: z.boolean(),
    destination_hint: z.string().trim().min(1).max(128),
    evidence: z
      .array(
        z
          .object({
            path: z.string().trim().min(1).max(1_024),
            line: z.number().int().positive().optional(),
            symbol: z.string().trim().min(1).max(512).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
export type ImplementationDeviation = z.infer<typeof ImplementationDeviation>;

export const ReviewArtifact = z.object({
  schema_version: z.literal(1),
  reviewer_agent_id: z.string().min(1),
  verdict: z.enum([
    "approved",
    "changes_requested",
    "blocked",
    "inconclusive",
  ]),
  risk: z.enum(["read_only", "low", "medium", "high", "forbidden"]),
  markdown: z.string().min(1),
  judgments: z.array(z.object({
    id: z.string().min(1),
    pass: z.boolean(),
    severity: z.enum(["warning", "error"]),
    summary: z.string().min(1),
  }).strict()).max(100),
  findings: z.array(z.object({
    rule_id: z.string().min(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    severity: z.enum(["info", "warning", "error"]),
    message: z.string().min(1),
    file: z.string().optional(),
    line: z.number().int().positive().optional(),
    evidence: z.string().optional(),
  }).strict()).max(100),
  recommended_actions: z.array(z.string().min(1)).max(100),
  evidence_refs: z.array(z.string().min(1)).max(100),
  runtime_identity: z.record(z.unknown()),
}).strict();
export type ReviewArtifact = z.infer<typeof ReviewArtifact>;

export const Verdict = z.object({
  pass: z.boolean(),
  score: z.number().min(0).max(1),
  issues: z.array(Issue).default([]),
  reviewer_agent_id: z.string(),
  summary: z.string(),
  verify_commands: z.array(z.object({
    command: z.string(),
    exit_code: z.number(),
    duration_ms: z.number(),
    /** Host process-group exit evidence; absent is unqualified, not success. */
    exit_confirmed: z.boolean().optional(),
    summary: z.string().optional(),
  })).optional(),
  /** Per-evaluation-spec results (explicit task specs plus implicit legacy specs). */
  evaluations: z.array(EvaluationResult).optional(),
  implementation_deviations: z.array(ImplementationDeviation).max(100).optional(),
  review_artifacts: z.array(ReviewArtifact).max(100).optional(),
});
export type Verdict = z.infer<typeof Verdict>;

// ── Iterate phase ──────────────────────────────────────────────────────

/**
 * Structured feedback derived from a failed Verdict and handed to the next
 * attempt through AgentTask.context.iteration_feedback.
 */
export const IterationFeedback = z.object({
  /** 1-based attempt number the feedback was derived from. */
  attempt: z.number(),
  verdict_summary: z.string(),
  blocking_issues: z.array(Issue).default([]),
  /** Failed evaluation spec ids from the previous attempt. */
  failed_evaluations: z.array(z.string()).default([]),
  suggested_focus: z.array(z.string()).default([]),
  previous_diff_summary: z.string().optional(),
});
export type IterationFeedback = z.infer<typeof IterationFeedback>;

export const IterationAction = z.enum(["continue", "stop", "escalate"]);
export type IterationAction = z.infer<typeof IterationAction>;

export const IterationOutcome = z.discriminatedUnion("action", [
  z.object({ action: z.literal("continue"), reason: z.string() }),
  z.object({ action: z.literal("stop"), reason: z.string() }),
  z.object({ action: z.literal("escalate"), reason: z.string(), escalate_to: z.enum(["human", "hermes"]) }),
]);
export type IterationOutcome = z.infer<typeof IterationOutcome>;

// ── State persistence ──────────────────────────────────────────────────

export const CommandAudit = z.object({
  command: z.string(),
  exit_code: z.number(),
  duration_ms: z.number(),
  summary: z.string().optional(),
});
export type CommandAudit = z.infer<typeof CommandAudit>;

export const IssueAudit = z.object({
  severity: IssueSeverity,
  message: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
  rule: z.string().optional(),
});
export type IssueAudit = z.infer<typeof IssueAudit>;

// Durable, auditable evidence of a Hub publication attempt (Phase 2B). Identity
// is the logical release digest + storage_key — NEVER a dist/packages path or a
// Mac-mini absolute store path. release_id/digest appear ONLY on a successful
// published result; blocked/error carry status + reasons but no release identity.
// ── Shared identity validators + redaction (Phase 2B) ────────────────────
// One source of truth so the evidence MAPPER and the persisted SCHEMA can never
// disagree (a value the mapper keeps always passes the schema — otherwise a
// malformed Hub field would crash the non-gating publish finalizer).
export const ASSET_ID_RE = /^[a-z0-9][a-z0-9._-]+$/;
export const RELEASE_ID_RE = /^[a-z0-9][a-z0-9-]*__[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*@[0-9][0-9A-Za-z.-]*$/;
export const NAMESPACE_STR_RE = /^(personal|organization)\/[a-z0-9][a-z0-9-]*$/;
const LOCATOR_SHAPE_RE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*){2}$/;

/** A logical relative locator: correct shape AND not a dist/packages path. */
export function isSafeLocator(v: unknown): v is string {
  return typeof v === "string" && LOCATOR_SHAPE_RE.test(v) && !/(^|\/)dist\/packages(\/|$)/i.test(v) && !/^dist\//i.test(v);
}
export const safeAssetId = (v: unknown): string | undefined => (typeof v === "string" && ASSET_ID_RE.test(v) ? v : undefined);
export const safeReleaseId = (v: unknown): string | undefined => (typeof v === "string" && RELEASE_ID_RE.test(v) ? v : undefined);
export const safeNamespace = (v: unknown): string | undefined => (typeof v === "string" && NAMESPACE_STR_RE.test(v) ? v : undefined);
export const safeStorageKey = (v: unknown): string | undefined => (isSafeLocator(v) ? v : undefined);

/** Mask absolute paths, dist/packages, and common secret tokens in free text so
 *  Hub-controlled `reasons`/messages can never leak them into evidence/reports. */
export function redactText(s: string): string {
  return String(s)
    .replace(/\/(?:Volumes|Users|home|private|etc|opt|var|tmp|root|mnt|srv)\/\S*/gi, "[redacted-path]")
    .replace(/[A-Za-z]:[\\/]\S*/g, "[redacted-path]")
    .replace(/dist\/packages\/\S*/gi, "[redacted-path]")
    .replace(/\b(?:sb_secret_[A-Za-z0-9]+|sk-[A-Za-z0-9-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,})\b/g, "[redacted-secret]");
}
export const redactReasons = (r: unknown): string[] => (Array.isArray(r) ? r.map((x) => redactText(String(x))) : []);

export const PublishedAssetEvidence = z.object({
  status: z.enum(["published", "blocked", "error"]),
  asset_id: z.string().regex(ASSET_ID_RE),
  gate: z.enum(["team", "client", "commercial"]),
  // Identity fields are shape-bound (mapper + schema share the SAME validators),
  // so an absolute/dist path can never be persisted as a release id/namespace/
  // locator and rendered verbatim.
  release_id: z.string().regex(RELEASE_ID_RE).optional(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  namespace: z.string().regex(NAMESPACE_STR_RE).optional(),
  storage_key: z.string().refine(isSafeLocator, "unsafe storage_key").optional(),
  reasons: z.array(z.string()).default([]),
}).superRefine((e, ctx) => {
  // Release identity is legal ONLY on a published result — a blocked/error
  // record can never carry release_id/digest/namespace/storage_key, even in
  // recovered state.
  if (e.status !== "published") {
    for (const k of ["release_id", "digest", "namespace", "storage_key"] as const) {
      if (e[k] !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: `${k} is not allowed on a non-published result` });
    }
  }
});
export type PublishedAssetEvidence = z.infer<typeof PublishedAssetEvidence>;

export const CompletedTask = z.object({
  candidate_evidence: CandidateEvidence.optional(),
  task_id: z.string(),
  capability: z.string().optional(),
  outcome: z.enum(["success", "failed", "escalated"]),
  iterations: z.number(),
  agent_id: z.string(),
  duration_ms: z.number(),
  run_id: z.string().optional(),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  execution_summary: z.string().optional(),
  /** Executor-owned stop latch; agent summary text cannot set it. */
  implementation_unconfirmed: z.boolean().optional(),
  execution_commands: z.array(CommandAudit).optional(),
  verifier_agent_id: z.string().optional(),
  verify_summary: z.string().optional(),
  verify_issue_count: z.number().optional(),
  verify_issues: z.array(IssueAudit).optional(),
  verify_commands: z.array(CommandAudit).optional(),
  evaluations: z.array(EvaluationResult).optional(),
  review_artifacts: z.array(ReviewArtifact).max(100).optional(),
  /** Feedback derived after each failed attempt, in attempt order. */
  iteration_feedback: z.array(IterationFeedback).optional(),
  changed_files: z.array(z.string()).optional(),
  diff_summary: z.string().optional(),
  commit_hash: z.string().optional(),
  error_summary: z.string().optional(),
  /** Adapter-reported usage summed across this task's iterations. */
  tokens_in: z.number().optional(),
  tokens_out: z.number().optional(),
  cost_usd: z.number().optional(),
  worktree_path: z.string().optional(),
  worktree_branch: z.string().optional(),
  worktree_commit: z.string().optional(),
  worktree_branch_preserved: z.boolean().optional(),
  /** Lesson draft written after a success that recovered from failed attempts. */
  lesson_draft_path: z.string().optional(),
  // ── Self-improvement (opt-in; populated only when the loop is run with a
  // selfImprovement assetizer). All optional so existing state stays valid.
  trace_id: z.string().optional(),
  feedback_asset_ids: z.array(z.string()).optional(),
  proposal_ids: z.array(z.string()).optional(),
  assetization_summary: z.string().optional(),
  self_improvement_level: z.number().int().min(0).max(6).optional(),
  /** Immutable Hub release evidence, attached only after a publish attempt. */
  published_asset: PublishedAssetEvidence.optional(),
});
export type CompletedTask = z.infer<typeof CompletedTask>;

export const LoopMetrics = z.object({
  total_cycles: z.number(),
  avg_duration_ms: z.number(),
  success_rate: z.number(),
  tokens_consumed: z.number(),
  /** Cumulative adapter/provider-reported spend. Default keeps old files valid. */
  cost_consumed: z.number().default(0),
});

export const KnowledgePackSummary = z.object({
  id: z.string(),
  version: z.string(),
  license: z.string(),
  source_kind: z.enum(["osstack_native", "processed_mit", "curated_external", "internal"]),
  quality_score: z.number(),
});
export type KnowledgePackSummary = z.infer<typeof KnowledgePackSummary>;

export const KnowledgeSearchResult = z.object({
  pack_id: z.string(),
  pack_version: z.string(),
  chunk_id: z.string(),
  title: z.string(),
  score: z.number(),
  snippet: z.string(),
  matched_terms: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  source_refs: z.array(z.string()).default([]),
});
export type KnowledgeSearchResult = z.infer<typeof KnowledgeSearchResult>;

export const LoopKnowledgeTrace = z.object({
  mode: z.enum(["off", "local", "cloud"]),
  status: z.enum(["not_used", "recorded", "error"]),
  query: z.string().optional(),
  packs: z.array(KnowledgePackSummary).default([]),
  results: z.array(KnowledgeSearchResult).default([]),
  reason: z.string().optional(),
  fallback_mode: z.enum(["off", "local"]).optional(),
});
export type LoopKnowledgeTrace = z.infer<typeof LoopKnowledgeTrace>;

/** A discovered task the policy declined to execute this cycle. */
export const DeferredTask = z.object({
  task: Task,
  authorization: TaskAuthorization,
  reason: z.string(),
});
export type DeferredTask = z.infer<typeof DeferredTask>;

/** Current discovery found work, but policy authorized none of it to execute. */
export const LoopWaitReason = z.object({
  code: z.literal("discovery_deferred"),
  needs_approval: z.number().int().nonnegative(),
  suggest_only: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
}).strict().refine(
  (reason) => reason.needs_approval + reason.suggest_only + reason.blocked > 0,
  { message: "a discovery wait requires at least one deferred task" },
);
export type LoopWaitReason = z.infer<typeof LoopWaitReason>;

/** The durable state of one loop session. Written to STATE.md + LOOP-STATE.json. */
export const LoopState = z.object({
  loop_id: z.string(),
  started_at: z.string(),
  updated_at: z.string(),
  completed_tasks: z.array(CompletedTask).default([]),
  in_progress: z.array(Task).optional(),
  pending: z.array(Task).optional(),
  /** Discovered but not executed this cycle: needs_approval / suggest_only / blocked. */
  deferred_tasks: z.array(DeferredTask).optional(),
  /** Present only when this cycle had deferred work and no executable tasks. */
  wait_reason: LoopWaitReason.optional(),
  /** Last budget check when a LoopBudget is configured. */
  budget_status: LoopBudgetStatus.optional(),
  key_metrics: LoopMetrics.optional(),
  decisions: z.array(z.string()).optional(),
  knowledge: LoopKnowledgeTrace.optional(),
});
export type LoopState = z.infer<typeof LoopState>;

// ── Scheduler ──────────────────────────────────────────────────────────

export const SchedulerMode = z.enum(["cron", "goal", "manual", "interval"]);
export type SchedulerMode = z.infer<typeof SchedulerMode>;

export const SchedulerConfig = z.object({
  mode: SchedulerMode,
  /** cron expression (mode=cron) */
  cron_expr: z.string().optional(),
  /** Interval in ms (mode=interval) */
  interval_ms: z.number().min(1_000).optional(),
  /** Stop condition (mode=goal) */
  goal_condition: StopCondition.optional(),
  /** Safety: minimum time between loop iterations (default 60s) */
  min_interval_ms: z.number().min(1_000).default(60_000),
  /** Safety: maximum total runtime before forced stop (default 72h) */
  max_runtime_ms: z.number().optional().default(259_200_000),
});
export type SchedulerConfig = z.infer<typeof SchedulerConfig>;

// ── Discover scanner interface ─────────────────────────────────────────

export interface DiscoverScanner {
  readonly source: DiscoverSource;
  /** Scan for new work. Returns discovered tasks, may be empty. */
  scan(): Promise<Task[]>;
}

// ── Loop engine ─────────────────────────────────────────────────────────

export const LoopEngineConfig = z.object({
  /** Unique loop identifier */
  loop_id: z.string(),
  /** How the loop is triggered */
  scheduler: SchedulerConfig,
  /** Which scanners to use */
  scanners: z.array(z.string()).default(["git_diff"]),
  /** Path to the workspace root */
  workspace_path: z.string().default(process.cwd()),
  /** Path for STATE.md + LOOP-STATE.json */
  state_file_path: z.string().default("LOOP-STATE.json"),
  /** Safety: max total iterations across all tasks */
  max_global_iterations: z.number().min(1).max(1000).default(100),
});
export type LoopEngineConfig = z.infer<typeof LoopEngineConfig>;

// ── Loop events (Hermes-compatible) ────────────────────────────────────

export const LoopProfileRoutingEvidence = z.object({
  profile_name: z.string().min(1),
  reason: z.string().min(1),
  builder_agent_id: z.string().min(1),
  evaluator_agent_id: z.string().min(1),
  designer_agent_id: z.string().min(1).optional(),
  builder_identity: z.record(z.unknown()),
  evaluator_identity: z.record(z.unknown()),
  designer_identity: z.record(z.unknown()).optional(),
  independent: z.boolean(),
  independence_reason: z.string().min(1),
}).passthrough();
export interface LoopProfileRoutingEvidence {
  profile_name: string;
  reason: string;
  builder_agent_id: string;
  evaluator_agent_id: string;
  designer_agent_id?: string;
  builder_identity: object;
  evaluator_identity: object;
  designer_identity?: object;
  independent: boolean;
  independence_reason: string;
}

export const LoopEventType = z.enum([
  "loop.started",
  "loop.cycle.started",
  "loop.discover.done",
  "loop.task.deferred",
  "loop.plan.done",
  "loop.execute.done",
  "loop.verify.done",
  "loop.implementation.deviation",
  "loop.iterate.done",
  "loop.escalated",
  "loop.worktree.created",
  "loop.worktree.merged",
  "loop.worktree.preserved",
  "loop.worktree.cleaned",
  "loop.worktree.orphans_cleaned",
  "loop.goal.checked",
  "loop.budget.exceeded",
  "loop.knowledge.used",
  "loop.queue.archived",
  "loop.skill.published",
  "loop.skill.publish_blocked",
  "loop.skill.release_recorded",
  "loop.lesson.drafted",
  "loop.self_improvement.done",
  "loop.self_improvement.failed",
  "loop.state.written",
  "loop.cycle.completed",
  "loop.stopped",
  "loop.error",
]);
export type LoopEventType = z.infer<typeof LoopEventType>;

export const LoopEvent = z.object({
  event_id: z.string(),
  loop_id: z.string(),
  type: LoopEventType,
  seq: z.number(),
  created_at: z.number(),
  payload: z.record(z.unknown()).optional(),
});
export type LoopEvent = z.infer<typeof LoopEvent>;
