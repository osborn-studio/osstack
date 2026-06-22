// Loop layer types — the vocabulary of the osstack Loop Engineering system.
//
// Aligned with the LE five-stage cycle:
//   Discover → Plan → Execute → Verify → Iterate
//
// And the six LE primitives:
//   Automations / Worktrees / Skills / Connectors / Sub-agents / State

import { z } from "zod";

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

export const Verdict = z.object({
  pass: z.boolean(),
  score: z.number().min(0).max(1),
  issues: z.array(Issue).default([]),
  reviewer_agent_id: z.string(),
  summary: z.string(),
});
export type Verdict = z.infer<typeof Verdict>;

// ── Iterate phase ──────────────────────────────────────────────────────

export const IterationAction = z.enum(["continue", "stop", "escalate"]);
export type IterationAction = z.infer<typeof IterationAction>;

export const IterationOutcome = z.discriminatedUnion("action", [
  z.object({ action: z.literal("continue"), reason: z.string() }),
  z.object({ action: z.literal("stop"), reason: z.string() }),
  z.object({ action: z.literal("escalate"), reason: z.string(), escalate_to: z.enum(["human", "hermes"]) }),
]);
export type IterationOutcome = z.infer<typeof IterationOutcome>;

// ── State persistence ──────────────────────────────────────────────────

export const CompletedTask = z.object({
  task_id: z.string(),
  capability: z.string().optional(),
  outcome: z.enum(["success", "failed", "escalated"]),
  iterations: z.number(),
  agent_id: z.string(),
  duration_ms: z.number(),
});
export type CompletedTask = z.infer<typeof CompletedTask>;

export const LoopMetrics = z.object({
  total_cycles: z.number(),
  avg_duration_ms: z.number(),
  success_rate: z.number(),
  tokens_consumed: z.number(),
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

/** The durable state of one loop session. Written to STATE.md + LOOP-STATE.json. */
export const LoopState = z.object({
  loop_id: z.string(),
  started_at: z.string(),
  updated_at: z.string(),
  completed_tasks: z.array(CompletedTask).default([]),
  in_progress: z.array(Task).optional(),
  pending: z.array(Task).optional(),
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

export const LoopEventType = z.enum([
  "loop.started",
  "loop.cycle.started",
  "loop.discover.done",
  "loop.plan.done",
  "loop.execute.done",
  "loop.verify.done",
  "loop.iterate.done",
  "loop.escalated",
  "loop.worktree.created",
  "loop.worktree.merged",
  "loop.worktree.cleaned",
  "loop.worktree.orphans_cleaned",
  "loop.goal.checked",
  "loop.knowledge.used",
  "loop.queue.archived",
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
