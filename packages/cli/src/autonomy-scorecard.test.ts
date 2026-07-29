import {
  createAutonomyRun,
  freezeProduction,
  getAutonomyRun,
  openDb,
  transitionAutonomyRun,
  type TransitionAutonomyRunInput,
} from "@osstack/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutonomyReliabilityReport } from "./autonomy-scorecard.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-autonomy-scorecard-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const sha = "a".repeat(64);
const budget = {
  max_builder_iterations: 3,
  max_review_rounds: 3,
  max_wall_time_ms: 5_400_000,
  max_no_progress_rounds: 2,
};

describe("guarded autonomy reliability scorecard", () => {
  it("uses exact risk, completion, deploy, rollback, and recovery denominators", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path, minFreeBytes: 0 });
    try {
      seedRun(db, path, "a", "completed", {
        risk: "R1",
        builder_iterations: 2,
        review_rounds: 2,
        deploy_outcome: "production_healthy",
        localRounds: [
          telemetryRound(["repeat"], {
            reviewer_mutation_count: 1,
          }),
          telemetryRound(["new", "repeat"], {
            unauthorized_action_count: 1,
          }),
        ],
      });
      seedRun(db, path, "b", "escalated", {
        risk: "R2",
        builder_iterations: 3,
        review_rounds: 2,
        approval: true,
        localRounds: [
          telemetryRound([], { adapter_unavailable_count: 1 }),
        ],
      });
      seedRun(db, path, "c", "completed", {
        risk: "R3",
        builder_iterations: 1,
        review_rounds: 1,
        approval: true,
      });
      seedRun(db, path, "d", "completed", {
        risk: "R2",
        builder_iterations: 2,
        review_rounds: 1,
        deploy_outcome: "production_rolled_back",
        recovery: "succeeded",
      });
      seedRun(db, path, "e", "deploy_frozen", {
        risk: "R2",
        builder_iterations: 1,
        review_rounds: 1,
        deploy_outcome: "rollback_failed",
      });
      seedRun(db, path, "f", "blocked_delivery", { risk: "R2" });
      seedRun(db, path, "g", "delivery_evidence_failed", {
        risk: "R2",
        builder_iterations: 1,
        review_rounds: 1,
      });
      seedRun(db, path, "h", "awaiting_approval", {
        risk: "R3",
      });
      freezeProduction(db, path, {
        repo_id: "repo-e",
        reason: "rollback failed",
        source_run_id: "run-e",
        frozen_at: 1_999,
      });

      const report = createAutonomyReliabilityReport(db, {
        now: () => new Date(2_000_000),
      });
      const metrics = report.weekly.metrics;

      expect(metrics.unattended_completion_rate).toEqual({
        numerator: 2,
        denominator: 4,
        value: 0.5,
      });
      expect(metrics.human_intervention_rate).toEqual({
        numerator: 1,
        denominator: 4,
        value: 0.25,
      });
      expect(metrics.mean_builder_iterations).toEqual({
        total: 10,
        denominator: 6,
        value: 1.6667,
      });
      expect(metrics.mean_review_rounds).toEqual({
        total: 8,
        denominator: 6,
        value: 1.3333,
      });
      expect(metrics.repeated_finding_count).toBe(1);
      expect(metrics.reviewer_mutation_count).toBe(1);
      expect(metrics.unauthorized_action_count).toBe(1);
      expect(metrics.proof_integrity_failure_count).toBe(1);
      expect(metrics.restart_recovery_rate).toEqual({
        numerator: 1,
        denominator: 1,
        value: 1,
      });
      expect(metrics.deploy_success_rate).toEqual({
        numerator: 1,
        denominator: 3,
        value: 0.3333,
      });
      expect(metrics.rollback_success_rate).toEqual({
        numerator: 1,
        denominator: 2,
        value: 0.5,
      });
      expect(metrics.active_freeze_count).toBe(1);

      expect(report.attention.awaiting_approval.map((item) => item.run_id))
        .toEqual(["run-h"]);
      expect(report.attention.escalated.map((item) => item.run_id))
        .toEqual(["run-b"]);
      expect(report.attention.blocked_delivery.map((item) => item.run_id))
        .toEqual(["run-f"]);
      expect(
        report.attention.delivery_evidence_failed.map((item) => item.run_id),
      ).toEqual(["run-g"]);
      expect(report.attention.production_frozen).toEqual([
        expect.objectContaining({ repo_id: "repo-e", source_run_id: "run-e" }),
      ]);
      expect(report.attention.rollback_failed.map((item) => item.run_id))
        .toEqual(["run-e"]);
      expect(report.attention.adapter_unavailable.map((item) => item.run_id))
        .toEqual(["run-b"]);
    } finally {
      db.close();
    }
  });

  it("returns zero-valued metrics with explicit zero denominators", () => {
    const path = join(tmp, "empty.db");
    const db = openDb({ path, minFreeBytes: 0 });
    try {
      const report = createAutonomyReliabilityReport(db, {
        now: () => new Date(2_000_000),
      });
      expect(report.daily.metrics.unattended_completion_rate).toEqual({
        numerator: 0,
        denominator: 0,
        value: 0,
      });
      expect(report.weekly.metrics.mean_builder_iterations).toEqual({
        total: 0,
        denominator: 0,
        value: 0,
      });
      expect(Object.values(report.attention).every(
        (items) => items.length === 0,
      )).toBe(true);
    } finally {
      db.close();
    }
  });
});

type LocalTelemetry = Record<string, number> & {
  reviewer_mutation_count?: number;
  unauthorized_action_count?: number;
  adapter_unavailable_count?: number;
};

function telemetryRound(
  findingFingerprints: string[],
  telemetry: LocalTelemetry,
) {
  return {
    progress: { finding_fingerprints: findingFingerprints },
    telemetry,
  };
}

interface SeedOptions {
  risk: "R1" | "R2" | "R3";
  builder_iterations?: number;
  review_rounds?: number;
  approval?: boolean;
  deploy_outcome?:
    | "production_healthy"
    | "production_rolled_back"
    | "rollback_failed";
  recovery?: "succeeded" | "failed";
  localRounds?: Array<ReturnType<typeof telemetryRound>>;
}

function seedRun(
  db: ReturnType<typeof openDb>,
  path: string,
  id: string,
  targetState:
    | "completed"
    | "escalated"
    | "deploy_frozen"
    | "blocked_delivery"
    | "delivery_evidence_failed"
    | "awaiting_approval",
  options: SeedOptions,
): void {
  const runId = `run-${id}`;
  createAutonomyRun(db, path, {
    autonomy_run_id: runId,
    transition_id: `${runId}:1`,
    task_id: `task-${id}`,
    repo_id: `repo-${id}`,
    workspace_path: `/tmp/repo-${id}`,
    contract_sha256: sha,
    budget,
    attempt: { engine_context: {} },
    event: { kind: "queued" },
    occurred_at: 1_900,
  });

  for (const [index, local] of (options.localRounds ?? []).entries()) {
    transition(db, path, runId, "verifying", {
      context_patch: {
        local_result: local,
      },
      telemetry: local.telemetry,
    }, 1_910 + index);
  }
  if (options.recovery !== undefined) {
    transition(db, path, runId, "blocked_delivery", {}, 1_920);
    transition(db, path, runId, "pushing", {
      recovery: {
        kind: "restart",
        succeeded: options.recovery === "succeeded",
      },
    }, 1_930);
  }
  transition(
    db,
    path,
    runId,
    targetState,
    {
      context_patch: {
        ...(options.builder_iterations === undefined
          ? {}
          : { builder_iterations: options.builder_iterations }),
        ...(options.review_rounds === undefined
          ? {}
          : { review_rounds: options.review_rounds }),
      },
    },
    1_940,
    {
      post_diff_risk: { level: options.risk },
      attempt: {
        engine_context: {
          ...(options.builder_iterations === undefined
            ? {}
            : { builder_iterations: options.builder_iterations }),
          ...(options.review_rounds === undefined
            ? {}
            : { review_rounds: options.review_rounds }),
        },
      },
      ...(options.approval
        ? { approval: { decision: { payload: { decision: "approve" } } } }
        : {}),
      ...(options.deploy_outcome === undefined
        ? {}
        : {
            deploy: {
              outcome: options.deploy_outcome,
              production: { outcome: options.deploy_outcome },
            },
          }),
      ...(options.deploy_outcome === "production_rolled_back"
        || options.deploy_outcome === "rollback_failed"
        ? {
            rollback: {
              command: { exit_code: options.deploy_outcome === "rollback_failed" ? 1 : 0 },
            },
          }
        : {}),
    },
  );
}

function transition(
  db: ReturnType<typeof openDb>,
  path: string,
  runId: string,
  state:
    | "verifying"
    | "blocked_delivery"
    | "pushing"
    | "completed"
    | "escalated"
    | "deploy_frozen"
    | "delivery_evidence_failed"
    | "awaiting_approval",
  event: TransitionAutonomyRunInput["event"],
  occurredAt: number,
  patch?: TransitionAutonomyRunInput["patch"],
): void {
  const current = getAutonomyRun(db, runId)!;
  transitionAutonomyRun(db, path, {
    autonomy_run_id: runId,
    transition_id: `${runId}:${current.revision + 1}`,
    expected_revision: current.revision,
    to_state: state,
    event,
    occurred_at: occurredAt,
    ...(patch === undefined ? {} : { patch }),
  });
}
