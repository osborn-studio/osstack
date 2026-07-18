import { describe, expect, it } from "vitest";
import { buildPortfolioReport } from "./portfolio.js";
import { attachProbeOutcomeMetrics } from "./probe-outcomes.js";

const zeroCounts = {
  sessions_total: 0,
  sessions_replayed: 0,
  sessions_skipped: 0,
  answered_questions: 0,
  effective_questions: 0,
  resolved_items: 0,
  integrated_decisions: 0,
  high_risk_tasks: 0,
  mid_build_deviation_tasks: 0,
  deferred_items: 0,
  stale_deferred_items: 0,
  gate_relevant_items: 0,
  active_waivers: 0,
  started_sessions: 0,
  completed_sessions: 0,
};

function health(repoId: string, role: string) {
  return {
    repo_id: repoId,
    name: repoId,
    path: `/repo/${repoId}`,
    role,
    exists: true,
    has_readme: true,
    has_loop_doc: true,
    has_tests: true,
    has_verify_command: true,
    closed_loop_level: 4,
    findings: [],
  };
}

describe("attachProbeOutcomeMetrics", () => {
  it("aggregates event-derived counts for supervised product repos without inventing targets", () => {
    const report = buildPortfolioReport([
      health("osstack", "core_platform"),
      health("reference", "reference"),
    ]);
    const attached = attachProbeOutcomeMetrics(report, {
      schema_version: "1",
      as_of_ms: 123,
      repos: [
        {
          repo_id: "osstack",
          counts: {
            ...zeroCounts,
            sessions_total: 3,
            sessions_replayed: 2,
            sessions_skipped: 1,
            answered_questions: 2,
            effective_questions: 1,
            resolved_items: 2,
            integrated_decisions: 1,
            high_risk_tasks: 2,
            mid_build_deviation_tasks: 1,
            deferred_items: 1,
            stale_deferred_items: 1,
            gate_relevant_items: 3,
            active_waivers: 1,
            started_sessions: 2,
            completed_sessions: 1,
          },
          rates: {
            effective_question_rate: 0.5,
            decision_integration_rate: 0.5,
            mid_build_architecture_deviation_rate: 0.5,
            stale_deferral_rate: 1,
            waiver_rate: 0.3333,
            completion_rate: 0.5,
          },
        },
        {
          repo_id: "reference",
          counts: {
            ...zeroCounts,
            sessions_total: 100,
            sessions_replayed: 100,
            answered_questions: 100,
            effective_questions: 100,
            started_sessions: 100,
            completed_sessions: 100,
          },
          rates: {
            effective_question_rate: 1,
            decision_integration_rate: null,
            mid_build_architecture_deviation_rate: null,
            stale_deferral_rate: null,
            waiver_rate: null,
            completion_rate: 1,
          },
        },
      ],
    });

    expect(attached.probe_outcomes).toEqual({
      schema_version: "1",
      as_of_ms: 123,
      baseline_status: "collecting",
      counts: {
        ...zeroCounts,
        sessions_total: 3,
        sessions_replayed: 2,
        sessions_skipped: 1,
        answered_questions: 2,
        effective_questions: 1,
        resolved_items: 2,
        integrated_decisions: 1,
        high_risk_tasks: 2,
        mid_build_deviation_tasks: 1,
        deferred_items: 1,
        stale_deferred_items: 1,
        gate_relevant_items: 3,
        active_waivers: 1,
        started_sessions: 2,
        completed_sessions: 1,
      },
      rates: {
        effective_question_rate: 0.5,
        decision_integration_rate: 0.5,
        mid_build_architecture_deviation_rate: 0.5,
        stale_deferral_rate: 1,
        waiver_rate: 0.3333,
        completion_rate: 0.5,
      },
    });
  });

  it("preserves the prior portfolio shape when no replayable probe sessions exist", () => {
    const report = buildPortfolioReport([health("osstack", "core_platform")]);
    expect(attachProbeOutcomeMetrics(report, {
      schema_version: "1",
      as_of_ms: 123,
      repos: [],
    })).toEqual(report);
  });
});
