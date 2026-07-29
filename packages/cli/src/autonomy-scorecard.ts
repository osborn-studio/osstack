import {
  AutonomyRunProjectionRow as AutonomyRunProjectionRowSchema,
  listAutonomyTransitions,
  listProductionFreezes,
  type AutonomyRunProjectionRow,
} from "@osstack/core";
import type Database from "better-sqlite3";

export interface AutonomyRateMetric {
  numerator: number;
  denominator: number;
  value: number;
}

export interface AutonomyMeanMetric {
  total: number;
  denominator: number;
  value: number;
}

export interface AutonomyScorecardMetrics {
  unattended_completion_rate: AutonomyRateMetric;
  human_intervention_rate: AutonomyRateMetric;
  mean_builder_iterations: AutonomyMeanMetric;
  mean_review_rounds: AutonomyMeanMetric;
  repeated_finding_count: number;
  reviewer_mutation_count: number;
  unauthorized_action_count: number;
  proof_integrity_failure_count: number;
  restart_recovery_rate: AutonomyRateMetric;
  deploy_success_rate: AutonomyRateMetric;
  rollback_success_rate: AutonomyRateMetric;
  active_freeze_count: number;
}

export interface AutonomyScorecard {
  window: "daily" | "weekly";
  from: string;
  through: string;
  run_count: number;
  metrics: AutonomyScorecardMetrics;
}

export interface AutonomyAttentionRun {
  run_id: string;
  repo_id: string;
  state: string;
  updated_at: number;
}

export interface AutonomyReliabilityReport {
  generated_at: string;
  daily: AutonomyScorecard;
  weekly: AutonomyScorecard;
  attention: {
    awaiting_approval: AutonomyAttentionRun[];
    escalated: AutonomyAttentionRun[];
    blocked_delivery: AutonomyAttentionRun[];
    delivery_evidence_failed: AutonomyAttentionRun[];
    production_frozen: Array<{
      repo_id: string;
      source_run_id: string;
      reason: string;
      frozen_at: number;
    }>;
    rollback_failed: AutonomyAttentionRun[];
    adapter_unavailable: AutonomyAttentionRun[];
  };
}

export interface AutonomyReliabilityOptions {
  now?: () => Date;
}

type JsonObject = Record<string, unknown>;

const TERMINAL_STATES = new Set([
  "blocked",
  "delivery_evidence_failed",
  "escalated",
  "cancelled",
  "completed",
]);
const DEPLOY_ATTEMPT_OUTCOMES = new Set([
  "production_healthy",
  "production_rolled_back",
  "rollback_failed",
]);
const ROLLBACK_ATTEMPT_OUTCOMES = new Set([
  "production_rolled_back",
  "rollback_failed",
]);

function parsedObject(value: string | null): JsonObject | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value);
}

function child(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === "number"
      && Number.isFinite(value)
      && value >= 0
    ? value
    : undefined;
}

function integerCount(value: unknown): number {
  const number = finiteNonnegative(value);
  return number !== undefined && Number.isInteger(number) ? number : 0;
}

function engineContext(row: AutonomyRunProjectionRow): JsonObject {
  const attempt = parsedObject(row.attempt_json);
  const context = child(attempt, "engine_context");
  return isObject(context) ? context : {};
}

function riskLevel(row: AutonomyRunProjectionRow): string | undefined {
  const post = parsedObject(row.post_diff_risk_json);
  const preflight = parsedObject(row.preflight_risk_json);
  const value = child(post, "level") ?? child(preflight, "level");
  return typeof value === "string" ? value : undefined;
}

function hasHumanDecision(row: AutonomyRunProjectionRow): boolean {
  const approval = parsedObject(row.approval_json);
  return isObject(child(approval, "decision"));
}

function deployOutcome(row: AutonomyRunProjectionRow): string | undefined {
  const deploy = parsedObject(row.deploy_json);
  const value = child(deploy, "outcome");
  return typeof value === "string" ? value : undefined;
}

function ratio(numerator: number, denominator: number): AutonomyRateMetric {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? 0 : rounded(numerator / denominator),
  };
}

function mean(total: number, denominator: number): AutonomyMeanMetric {
  return {
    total,
    denominator,
    value: denominator === 0 ? 0 : rounded(total / denominator),
  };
}

function rounded(value: number): number {
  return Number(value.toFixed(4));
}

interface TransitionTelemetry {
  repeatedFindings: number;
  reviewerMutations: number;
  unauthorizedActions: number;
  adapterUnavailable: number;
  recoveryAttempts: number;
  recoverySuccesses: number;
}

function transitionTelemetry(
  db: Database.Database,
  row: AutonomyRunProjectionRow,
): TransitionTelemetry {
  let previousFindings = new Set<string>();
  let repeatedFindings = 0;
  let reviewerMutations = 0;
  let unauthorizedActions = 0;
  let adapterUnavailable = 0;
  let recoveryAttempts = 0;
  let recoverySuccesses = 0;

  const transitions = listAutonomyTransitions(
    db,
    row.autonomy_run_id,
  );
  for (const transition of transitions) {
    const event = parsedObject(transition.event_json) ?? {};
    const contextPatch = child(event, "context_patch");
    const localResult = child(contextPatch, "local_result");
    const progress = child(localResult, "progress");
    const rawFindings = child(progress, "finding_fingerprints");
    if (Array.isArray(rawFindings)) {
      const current = new Set(
        rawFindings.filter(
          (finding): finding is string => typeof finding === "string",
        ),
      );
      repeatedFindings += [...current].filter(
        (finding) => previousFindings.has(finding),
      ).length;
      previousFindings = current;
    }
    const telemetry = child(localResult, "telemetry")
      ?? child(event, "telemetry");
    reviewerMutations += integerCount(
      child(telemetry, "reviewer_mutation_count"),
    );
    unauthorizedActions += integerCount(
      child(telemetry, "unauthorized_action_count"),
    );
    adapterUnavailable += integerCount(
      child(telemetry, "adapter_unavailable_count"),
    );
    const recovery = child(event, "recovery");
    if (child(recovery, "kind") === "restart") recoveryAttempts = 1;
  }
  if (
    recoveryAttempts > 0
    && (
      row.state === "completed"
      || transitions.some((transition) =>
        child(
          parsedObject(transition.event_json)?.["recovery"],
          "succeeded",
        ) === true
      )
    )
  ) {
    recoverySuccesses = 1;
  }

  return {
    repeatedFindings,
    reviewerMutations,
    unauthorizedActions,
    adapterUnavailable,
    recoveryAttempts,
    recoverySuccesses,
  };
}

function createScorecard(
  rows: AutonomyRunProjectionRow[],
  telemetryByRun: ReadonlyMap<string, TransitionTelemetry>,
  window: AutonomyScorecard["window"],
  from: Date,
  through: Date,
  activeFreezeCount: number,
): AutonomyScorecard {
  const eligibleTerminal = rows.filter(
    (row) =>
      TERMINAL_STATES.has(row.state)
      && (riskLevel(row) === "R1" || riskLevel(row) === "R2"),
  );
  const unattendedCompleted = eligibleTerminal.filter(
    (row) => row.state === "completed" && !hasHumanDecision(row),
  ).length;
  const avoidableHumanInterventions = eligibleTerminal.filter(
    hasHumanDecision,
  ).length;

  const builderIterations = rows
    .map((row) => finiteNonnegative(
      child(engineContext(row), "builder_iterations"),
    ))
    .filter((value): value is number => value !== undefined);
  const reviewRounds = rows
    .map((row) => finiteNonnegative(
      child(engineContext(row), "review_rounds"),
    ))
    .filter((value): value is number => value !== undefined);

  let repeatedFindingCount = 0;
  let reviewerMutationCount = 0;
  let unauthorizedActionCount = 0;
  let recoveryAttempts = 0;
  let recoverySuccesses = 0;
  for (const row of rows) {
    const telemetry = telemetryByRun.get(row.autonomy_run_id);
    if (telemetry === undefined) {
      throw new Error(
        `missing scorecard telemetry for ${row.autonomy_run_id}`,
      );
    }
    repeatedFindingCount += telemetry.repeatedFindings;
    reviewerMutationCount += telemetry.reviewerMutations;
    unauthorizedActionCount += telemetry.unauthorizedActions;
    recoveryAttempts += telemetry.recoveryAttempts;
    recoverySuccesses += telemetry.recoverySuccesses;
  }

  const outcomes = rows
    .map(deployOutcome)
    .filter((outcome): outcome is string => outcome !== undefined);
  const deployAttempts = outcomes.filter(
    (outcome) => DEPLOY_ATTEMPT_OUTCOMES.has(outcome),
  );
  const rollbackAttempts = outcomes.filter(
    (outcome) => ROLLBACK_ATTEMPT_OUTCOMES.has(outcome),
  );

  return {
    window,
    from: from.toISOString(),
    through: through.toISOString(),
    run_count: rows.length,
    metrics: {
      unattended_completion_rate: ratio(
        unattendedCompleted,
        eligibleTerminal.length,
      ),
      human_intervention_rate: ratio(
        avoidableHumanInterventions,
        eligibleTerminal.length,
      ),
      mean_builder_iterations: mean(
        builderIterations.reduce((sum, value) => sum + value, 0),
        builderIterations.length,
      ),
      mean_review_rounds: mean(
        reviewRounds.reduce((sum, value) => sum + value, 0),
        reviewRounds.length,
      ),
      repeated_finding_count: repeatedFindingCount,
      reviewer_mutation_count: reviewerMutationCount,
      unauthorized_action_count: unauthorizedActionCount,
      proof_integrity_failure_count: rows.filter(
        (row) => row.state === "delivery_evidence_failed",
      ).length,
      restart_recovery_rate: ratio(recoverySuccesses, recoveryAttempts),
      deploy_success_rate: ratio(
        deployAttempts.filter((outcome) => outcome === "production_healthy")
          .length,
        deployAttempts.length,
      ),
      rollback_success_rate: ratio(
        rollbackAttempts.filter(
          (outcome) => outcome === "production_rolled_back",
        ).length,
        rollbackAttempts.length,
      ),
      active_freeze_count: activeFreezeCount,
    },
  };
}

function attentionRun(row: AutonomyRunProjectionRow): AutonomyAttentionRun {
  return {
    run_id: row.autonomy_run_id,
    repo_id: row.repo_id,
    state: row.state,
    updated_at: row.updated_at,
  };
}

export function createAutonomyReliabilityReport(
  db: Database.Database,
  options: AutonomyReliabilityOptions = {},
): AutonomyReliabilityReport {
  const now = options.now?.() ?? new Date();
  const throughSeconds = now.getTime() / 1_000;
  const allRows = (
    db.prepare(
      `SELECT *
       FROM autonomy_run_projection
       ORDER BY updated_at DESC, autonomy_run_id ASC`,
    ).all() as unknown[]
  ).map((row) => AutonomyRunProjectionRowSchema.parse(row));
  const telemetryByRun = new Map(
    allRows.map((row) => [
      row.autonomy_run_id,
      transitionTelemetry(db, row),
    ]),
  );
  const dailyFrom = new Date(now.getTime() - 86_400_000);
  const weeklyFrom = new Date(now.getTime() - 7 * 86_400_000);
  const dailyRows = allRows.filter(
    (row) =>
      row.updated_at >= dailyFrom.getTime() / 1_000
      && row.updated_at <= throughSeconds,
  );
  const weeklyRows = allRows.filter(
    (row) =>
      row.updated_at >= weeklyFrom.getTime() / 1_000
      && row.updated_at <= throughSeconds,
  );
  const freezes = listProductionFreezes(db, { active_only: true });
  const rowsInState = (state: string): AutonomyAttentionRun[] =>
    allRows.filter((row) => row.state === state).map(attentionRun);
  const rollbackFailed = allRows.filter(
    (row) => deployOutcome(row) === "rollback_failed",
  );
  const adapterUnavailable = allRows.filter(
    (row) =>
      row.state !== "completed"
      && (telemetryByRun.get(row.autonomy_run_id)?.adapterUnavailable ?? 0)
        > 0,
  );

  return {
    generated_at: now.toISOString(),
    daily: createScorecard(
      dailyRows,
      telemetryByRun,
      "daily",
      dailyFrom,
      now,
      freezes.length,
    ),
    weekly: createScorecard(
      weeklyRows,
      telemetryByRun,
      "weekly",
      weeklyFrom,
      now,
      freezes.length,
    ),
    attention: {
      awaiting_approval: rowsInState("awaiting_approval"),
      escalated: rowsInState("escalated"),
      blocked_delivery: rowsInState("blocked_delivery"),
      delivery_evidence_failed: rowsInState("delivery_evidence_failed"),
      production_frozen: freezes.map((freeze) => ({
        repo_id: freeze.repo_id,
        source_run_id: freeze.source_run_id,
        reason: freeze.reason,
        frozen_at: freeze.frozen_at,
      })),
      rollback_failed: rollbackFailed.map(attentionRun),
      adapter_unavailable: adapterUnavailable.map(attentionRun),
    },
  };
}
