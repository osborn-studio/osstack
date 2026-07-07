import { describe, expect, it } from "vitest";
import { buildAdversarialCases } from "./adversarial-pool.js";
import type { RunTrace } from "./types.js";

function trace(traceId: string, message: string): RunTrace {
  return {
    trace_id: traceId,
    repo_id: "stock-monitor",
    started_at: "2026-07-07T00:00:00.000Z",
    actor: {},
    input_summary: `brief for ${traceId}`,
    commands: [],
    verification: {
      pass: false,
      score: 0.2,
      issues: [{ severity: "error", message }],
    },
    changed_files: [],
    cost: { tokens_in: 0, tokens_out: 0 },
  };
}

describe("buildAdversarialCases", () => {
  it("creates an anchor case where evaluator and human disagree", () => {
    const cases = buildAdversarialCases({
      repo_id: "stock-monitor",
      traces: [trace("trace_1", "expected lower confidence received high")],
      human_verdicts: [{ trace_id: "trace_1", verdict: "reject", reason: "overconfident before drawdown" }],
      evaluator_verdicts: [{ trace_id: "trace_1", evaluator_id: "eval_v1", verdict: "accept" }],
    });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      repo_id: "stock-monitor",
      source_trace_id: "trace_1",
      expected_verdict: "reject",
      adversarial: true,
    });
    expect(cases[0]?.input_summary).toBe("brief for trace_1");
    expect(cases[0]?.evidence_refs.join(" ")).toMatch(/eval_v1/);
  });

  it("ignores agreements and traces with no human verdict", () => {
    const cases = buildAdversarialCases({
      repo_id: "stock-monitor",
      traces: [trace("t_agree", "x"), trace("t_nohuman", "y")],
      human_verdicts: [{ trace_id: "t_agree", verdict: "accept", reason: "fine" }],
      evaluator_verdicts: [
        { trace_id: "t_agree", evaluator_id: "eval_v1", verdict: "accept" },
        { trace_id: "t_nohuman", evaluator_id: "eval_v1", verdict: "reject" },
      ],
    });
    expect(cases).toEqual([]);
  });

  it("dedupes multiple disagreeing evaluators on the same trace", () => {
    const cases = buildAdversarialCases({
      repo_id: "stock-monitor",
      traces: [trace("trace_1", "z")],
      human_verdicts: [{ trace_id: "trace_1", verdict: "reject", reason: "bad" }],
      evaluator_verdicts: [
        { trace_id: "trace_1", evaluator_id: "eval_v1", verdict: "accept" },
        { trace_id: "trace_1", evaluator_id: "eval_v2", verdict: "needs_human" },
      ],
    });
    expect(cases).toHaveLength(1);
  });
});
