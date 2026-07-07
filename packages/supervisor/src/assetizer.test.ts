import { describe, expect, it } from "vitest";
import { assetizeFailure } from "./assetizer.js";
import type { RunTrace } from "./types.js";

const baseTrace: RunTrace = {
  trace_id: "trace_1",
  repo_id: "group-finance-agent",
  started_at: "2026-07-07T00:00:00.000Z",
  actor: {},
  input_summary: "CFO analysis",
  commands: [],
  verification: {
    pass: false,
    score: 0.2,
    issues: [{ severity: "error", message: "expected revenue period 2024-01 received 2024-02" }],
  },
  changed_files: [],
  cost: { tokens_in: 0, tokens_out: 0 },
};

describe("assetizer", () => {
  it("creates eval asset for reasoning failures", () => {
    const assets = assetizeFailure(baseTrace);
    expect(assets[0]?.repo_id).toBe("group-finance-agent");
    expect(assets[0]?.source_trace_id).toBe("trace_1");
    expect(assets[0]?.kind).toBe("eval_case");
    expect(assets[0]?.status).toBe("proposed");
  });

  it("preserves evidence and never assetizes a passing trace", () => {
    const assets = assetizeFailure(baseTrace);
    expect(assets[0]?.evidence).toContain("expected revenue period 2024-01 received 2024-02");
    const passing = { ...baseTrace, verification: { ...baseTrace.verification, pass: true } };
    expect(assetizeFailure(passing)).toEqual([]);
  });

  it("maps tool failures to pitfall lessons", () => {
    const toolTrace = {
      ...baseTrace,
      verification: {
        pass: false,
        score: 0,
        issues: [{ severity: "error" as const, message: "spawn pytest ENOENT" }],
      },
    };
    expect(assetizeFailure(toolTrace)[0]?.kind).toBe("pitfall_lesson");
  });
});
