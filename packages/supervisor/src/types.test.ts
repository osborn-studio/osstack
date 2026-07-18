import { describe, expect, it } from "vitest";
import {
  AnchorCase,
  EvaluatorEpoch,
  EvaluatorVersion,
  FeedbackAsset,
  ImprovementProposal,
  PortfolioReport,
  RepoHealth,
  RepoRegistryEntry,
  RunTrace,
} from "./types.js";

describe("supervisor domain schemas", () => {
  it("parses repo registry defaults", () => {
    const entry = RepoRegistryEntry.parse({
      repo_id: "osstack",
      name: "osstack",
      path: "/tmp/osstack",
      role: "core_platform",
    });
    expect(entry.priority).toBe(50);
    expect(entry.verify_commands).toEqual([]);
    expect(entry.loop_doc_path).toBe("docs/LOOP.md");
    expect(entry.enabled).toBe(true);
  });

  it("parses a failed run trace with default actor, commands, and cost", () => {
    const trace = RunTrace.parse({
      trace_id: "trace_osstack_1",
      repo_id: "osstack",
      started_at: "2026-07-07T00:00:00.000Z",
      input_summary: "Run loop verification",
      verification: {
        pass: false,
        score: 0.25,
        issues: [{ severity: "error", message: "test failed", rule: "vitest" }],
      },
    });
    expect(trace.actor).toEqual({});
    expect(trace.commands).toEqual([]);
    expect(trace.cost).toEqual({ tokens_in: 0, tokens_out: 0 });
  });

  it("parses feedback asset provenance", () => {
    const asset = FeedbackAsset.parse({
      asset_id: "asset_1",
      repo_id: "stock-monitor",
      source_trace_id: "trace_1",
      kind: "eval_case",
      failure_family: "bad_reasoning",
      summary: "Recommendation confidence was miscalibrated.",
      evidence: ["expected lower confidence after drawdown"],
      created_at: "2026-07-07T00:00:00.000Z",
    });
    expect(asset.status).toBe("proposed");
  });

  it("parses improvement proposal gates", () => {
    const proposal = ImprovementProposal.parse({
      proposal_id: "prop_1",
      repo_id: "group-finance-agent",
      source_asset_ids: ["asset_1"],
      target: "eval",
      risk: "low",
      title: "Add CFO correction eval",
      rationale: "A corrected analysis should become a regression case.",
      proposed_changes: [{ path: "packages/skills/eval_cases.jsonl", action: "modify", summary: "Append case." }],
      required_gates: ["uv run pytest tests/test_finance_metrics.py"],
      created_at: "2026-07-07T00:00:00.000Z",
    });
    expect(proposal.status).toBe("draft");
  });

  it("parses repo health and portfolio report", () => {
    const health = RepoHealth.parse({
      repo_id: "osstack",
      name: "osstack",
      path: "/tmp/osstack",
      role: "core_platform",
      exists: true,
      has_readme: true,
      has_loop_doc: true,
      has_tests: true,
      has_verify_command: true,
      closed_loop_level: 2,
    });
    const report = PortfolioReport.parse({
      generated_at: "2026-07-07T00:00:00.000Z",
      repo_count: 1,
      enabled_repo_count: 1,
      average_closed_loop_level: 2,
      repos: [health],
    });
    expect(report.recommendations).toEqual([]);
    // Additive field: absent in old persisted data ⇒ defaults to [] (not strict).
    expect(report.structured_recommendations).toEqual([]);
    expect(health.hygiene).toBeUndefined();
  });

  it("adds optional hygiene without changing the closed-loop level", () => {
    const health = RepoHealth.parse({
      repo_id: "osstack",
      name: "osstack",
      path: "/tmp/osstack",
      role: "core_platform",
      exists: true,
      has_readme: true,
      has_loop_doc: true,
      has_tests: true,
      has_verify_command: true,
      closed_loop_level: 4,
      hygiene: {
        complete: false,
        error_count: 2,
        warning_count: 3,
        recurring_count: 1,
        oldest_open_days: 7.5,
        checked_at: "2026-07-17T00:00:00.000Z",
      },
    });

    expect(health.closed_loop_level).toBe(4);
    expect(health.hygiene).toMatchObject({
      complete: false,
      recurring_count: 1,
    });
  });

  it("parses evaluator epoch contracts", () => {
    const evaluator = EvaluatorVersion.parse({
      evaluator_id: "eval_stock_v1",
      repo_id: "stock-monitor",
      kind: "llm_judge",
      version: "1",
      title: "Investment memo judge",
      rubric: "Reject overconfident calls without realized support.",
      created_at: "2026-07-07T00:00:00.000Z",
    });
    const anchor = AnchorCase.parse({
      case_id: "anchor_1",
      repo_id: "stock-monitor",
      input_summary: "Overconfident buy recommendation before drawdown.",
      expected_verdict: "reject",
      adversarial: true,
    });
    const epoch = EvaluatorEpoch.parse({
      epoch_id: "epoch_1",
      repo_id: "stock-monitor",
      frozen_evaluator_id: evaluator.evaluator_id,
      started_at: "2026-07-07T00:00:00.000Z",
      anchor_case_ids: [anchor.case_id],
    });
    expect(epoch.challenger_evaluator_ids).toEqual([]);
  });
});
