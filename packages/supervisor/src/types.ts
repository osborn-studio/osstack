// Supervisor domain contracts — the vocabulary of the osstack recursive
// control plane. All schemas are Zod-first and pure (no I/O, no network).
//
// Maturity ladder these contracts serve:
//   L0 deliverable → L1 traceable loop → L2 failure assetization →
//   L3 improvement proposal → L4 gated self-update → L5 meta-evaluation →
//   L6 recursive portfolio optimization.

import { z } from "zod";
import {
  ProbeOutcomeCountsV1,
  ProbeOutcomeRatesV1,
} from "@osstack/core";

// ── Repo registry ───────────────────────────────────────────────────────

export const RepoRole = z.enum([
  "core_platform",
  "business_product",
  "skill",
  "app",
  "cli",
  "reference",
  "archive",
]);
export type RepoRole = z.infer<typeof RepoRole>;

export const RepoRegistryEntry = z.object({
  repo_id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  role: RepoRole,
  owner: z.string().optional(),
  priority: z.number().min(0).max(100).default(50),
  verify_commands: z.array(z.string()).default([]),
  loop_doc_path: z.string().default("docs/LOOP.md"),
  enabled: z.boolean().default(true),
});
export type RepoRegistryEntry = z.infer<typeof RepoRegistryEntry>;

// ── Run trace ─────────────────────────────────────────────────────────────

export const TraceIssue = z.object({
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
  rule: z.string().optional(),
});
export type TraceIssue = z.infer<typeof TraceIssue>;

export const TraceCommand = z.object({
  command: z.string(),
  exit_code: z.number(),
  duration_ms: z.number(),
  summary: z.string().optional(),
});
export type TraceCommand = z.infer<typeof TraceCommand>;

export const RunTrace = z.object({
  trace_id: z.string().min(1),
  repo_id: z.string().min(1),
  run_id: z.string().optional(),
  task_id: z.string().optional(),
  started_at: z.string(),
  completed_at: z.string().optional(),
  actor: z.object({
    agent_id: z.string().optional(),
    model: z.string().optional(),
    adapter: z.string().optional(),
  }).default({}),
  input_summary: z.string(),
  output_summary: z.string().optional(),
  commands: z.array(TraceCommand).default([]),
  verification: z.object({
    pass: z.boolean(),
    score: z.number().min(0).max(1),
    issues: z.array(TraceIssue).default([]),
  }),
  changed_files: z.array(z.string()).default([]),
  cost: z.object({
    tokens_in: z.number().int().nonnegative().default(0),
    tokens_out: z.number().int().nonnegative().default(0),
    usd: z.number().nonnegative().optional(),
  }).default({ tokens_in: 0, tokens_out: 0 }),
});
export type RunTrace = z.infer<typeof RunTrace>;

// ── Failure taxonomy ──────────────────────────────────────────────────────

export const FailureFamily = z.enum([
  "bad_input",
  "bad_context",
  "bad_retrieval",
  "bad_reasoning",
  "bad_tool",
  "bad_eval",
  "bad_prompt",
  "bad_skill",
  "bad_agent_flow",
  "bad_policy",
  "bad_verification",
  "bad_handoff",
  "unknown",
]);
export type FailureFamily = z.infer<typeof FailureFamily>;

// ── Feedback asset ────────────────────────────────────────────────────────

export const FeedbackAssetKind = z.enum([
  "eval_case",
  "pitfall_lesson",
  "knowledge_memory",
  "governance_rule",
  "runbook_note",
  "test_gap",
  "prompt_gap",
  "skill_gap",
]);
export type FeedbackAssetKind = z.infer<typeof FeedbackAssetKind>;

export const FeedbackAsset = z.object({
  asset_id: z.string().min(1),
  repo_id: z.string().min(1),
  source_trace_id: z.string().min(1),
  kind: FeedbackAssetKind,
  failure_family: FailureFamily,
  summary: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  suggested_storage_path: z.string().optional(),
  status: z.enum(["proposed", "accepted", "rejected", "superseded"]).default("proposed"),
  created_at: z.string(),
});
export type FeedbackAsset = z.infer<typeof FeedbackAsset>;

// ── Improvement proposal ──────────────────────────────────────────────────

export const ImprovementTarget = z.enum([
  "eval",
  "test",
  "prompt",
  "skill",
  "tool",
  "agent_flow",
  "policy",
  "docs",
  "routing",
]);
export type ImprovementTarget = z.infer<typeof ImprovementTarget>;

export const ImprovementRisk = z.enum(["low", "medium", "high"]);
export type ImprovementRisk = z.infer<typeof ImprovementRisk>;

export const ImprovementProposal = z.object({
  proposal_id: z.string().min(1),
  repo_id: z.string().min(1),
  source_asset_ids: z.array(z.string()).min(1),
  target: ImprovementTarget,
  risk: ImprovementRisk,
  title: z.string().min(1),
  rationale: z.string().min(1),
  proposed_changes: z.array(z.object({
    path: z.string(),
    action: z.enum(["create", "modify", "delete"]),
    summary: z.string(),
  })).default([]),
  required_gates: z.array(z.string()).default([]),
  status: z.enum(["draft", "needs_human", "approved", "applied", "rejected", "blocked"]).default("draft"),
  created_at: z.string(),
});
export type ImprovementProposal = z.infer<typeof ImprovementProposal>;

// ── Repo health + portfolio ───────────────────────────────────────────────

export const RepoKnowledgeHygieneSummaryV1 = z.object({
  complete: z.boolean(),
  health_claim: z.enum([
    "findings_present",
    "assessed_scope_clean",
    "assessment_incomplete",
  ]),
  coverage: z.array(z.record(z.unknown())),
  error_count: z.number().int().nonnegative(),
  warning_count: z.number().int().nonnegative(),
  recurring_count: z.number().int().nonnegative(),
  oldest_open_days: z.number().nonnegative().optional(),
  checked_at: z.string().datetime(),
});
export type RepoKnowledgeHygieneSummaryV1 = z.infer<
  typeof RepoKnowledgeHygieneSummaryV1
>;

export const RepoHealth = z.object({
  repo_id: z.string(),
  name: z.string(),
  path: z.string(),
  role: z.string(),
  exists: z.boolean(),
  git_clean: z.boolean().optional(),
  has_readme: z.boolean(),
  has_loop_doc: z.boolean(),
  has_tests: z.boolean(),
  has_verify_command: z.boolean(),
  latest_loop_success_rate: z.number().min(0).max(1).optional(),
  closed_loop_level: z.number().int().min(0).max(6),
  evaluator_epoch_id: z.string().optional(),
  evaluator_anchor_accuracy: z.number().min(0).max(1).optional(),
  adversarial_case_count: z.number().int().nonnegative().optional(),
  hygiene: RepoKnowledgeHygieneSummaryV1.optional(),
  findings: z.array(z.string()).default([]),
});
export type RepoHealth = z.infer<typeof RepoHealth>;

/**
 * Machine-actionable recommendation kinds. Each free-text entry in a portfolio
 * report's `recommendations` has a parallel `structured_recommendations` entry
 * carrying one of these `kind`s (plus a `repo_id` when the recommendation is
 * attributable to a single repo). Consumers (e.g. `osstack daily`) dispatch on
 * `kind` + `repo_id` instead of parsing the free text — brittle string matching
 * and `<name>: ` prefix parsing are gone.
 */
export const RecommendationKind = z.enum([
  "missing_path",
  "add_loop_doc",
  "add_verify_command",
  "enable_failure_assetization",
  "create_evaluator_anchor_set",
  "freeze_evaluator",
  "consolidation",
]);
export type RecommendationKind = z.infer<typeof RecommendationKind>;

export const StructuredRecommendation = z.object({
  kind: RecommendationKind,
  /** The single repo this is about (registry-unique id, NOT display name).
   *  Absent for portfolio-level kinds (e.g. `consolidation` spans repos). */
  repo_id: z.string().optional(),
  /** The exact free-text line — byte-identical to the matching
   *  `recommendations[i]` entry, so renderers stay unchanged. */
  text: z.string(),
});
export type StructuredRecommendation = z.infer<typeof StructuredRecommendation>;

export const PortfolioProbeOutcomesV1 = z
  .object({
    schema_version: z.literal("1"),
    as_of_ms: z.number().int().nonnegative(),
    baseline_status: z.literal("collecting"),
    counts: ProbeOutcomeCountsV1,
    rates: ProbeOutcomeRatesV1,
  })
  .strict();
export type PortfolioProbeOutcomesV1 = z.infer<
  typeof PortfolioProbeOutcomesV1
>;

export const PortfolioReport = z.object({
  generated_at: z.string(),
  repo_count: z.number().int().nonnegative(),
  enabled_repo_count: z.number().int().nonnegative(),
  average_closed_loop_level: z.number().min(0).max(6),
  repos: z.array(RepoHealth),
  recommendations: z.array(z.string()).default([]),
  /** Machine-actionable mirror of `recommendations` (same order, same text).
   *  Optional-with-default so pre-existing persisted reports lacking the field
   *  still parse (the schema is not `.strict()`; default fills in []). */
  structured_recommendations: z.array(StructuredRecommendation).default([]),
  probe_outcomes: PortfolioProbeOutcomesV1.optional(),
});
export type PortfolioReport = z.infer<typeof PortfolioReport>;

// ── Evaluator epochs (Red Queen control) ──────────────────────────────────

export const EvaluatorKind = z.enum([
  "deterministic_gate",
  "llm_judge",
  "human_rubric",
  "hybrid_panel",
  "domain_metric",
]);
export type EvaluatorKind = z.infer<typeof EvaluatorKind>;

export const EvaluatorVersion = z.object({
  evaluator_id: z.string().min(1),
  repo_id: z.string().min(1),
  kind: EvaluatorKind,
  version: z.string().min(1),
  title: z.string().min(1),
  rubric: z.string().min(1),
  implementation_ref: z.string().optional(),
  status: z.enum(["candidate", "frozen", "retired", "rejected"]).default("candidate"),
  created_at: z.string(),
});
export type EvaluatorVersion = z.infer<typeof EvaluatorVersion>;

export const AnchorCase = z.object({
  case_id: z.string().min(1),
  repo_id: z.string().min(1),
  source_trace_id: z.string().optional(),
  input_summary: z.string().min(1),
  expected_verdict: z.enum(["accept", "reject", "needs_human"]),
  expected_failure_family: FailureFamily.optional(),
  evidence_refs: z.array(z.string()).default([]),
  adversarial: z.boolean().default(false),
});
export type AnchorCase = z.infer<typeof AnchorCase>;

export const EvaluatorEpoch = z.object({
  epoch_id: z.string().min(1),
  repo_id: z.string().min(1),
  frozen_evaluator_id: z.string().min(1),
  started_at: z.string(),
  ended_at: z.string().optional(),
  anchor_case_ids: z.array(z.string()).default([]),
  challenger_evaluator_ids: z.array(z.string()).default([]),
  promotion_decision: z.object({
    promoted_evaluator_id: z.string().optional(),
    reason: z.string(),
    anchor_accuracy_delta: z.number(),
    promoted: z.boolean(),
  }).optional(),
});
export type EvaluatorEpoch = z.infer<typeof EvaluatorEpoch>;
