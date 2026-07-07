import { describe, expect, it } from "vitest";
import { classifyFailure, explainFailure } from "./failure-taxonomy.js";
import type { RunTrace } from "./types.js";

function trace(message: string, command = "pnpm test"): RunTrace {
  return {
    trace_id: "trace_1",
    repo_id: "osstack",
    started_at: "2026-07-07T00:00:00.000Z",
    actor: {},
    input_summary: "test",
    commands: [{ command, exit_code: 1, duration_ms: 10, summary: message }],
    verification: {
      pass: false,
      score: 0,
      issues: [{ severity: "error", message }],
    },
    changed_files: [],
    cost: { tokens_in: 0, tokens_out: 0 },
  };
}

describe("failure taxonomy", () => {
  it("classifies missing tools", () => {
    expect(classifyFailure(trace("spawn pytest ENOENT"))).toBe("bad_tool");
  });
  it("classifies assertion mismatches", () => {
    expect(classifyFailure(trace("AssertionError: expected 1 received 2"))).toBe("bad_reasoning");
  });
  it("classifies missing verification", () => {
    expect(classifyFailure(trace("no tests configured", ""))).toBe("bad_verification");
  });
  it("classifies retrieval failures", () => {
    expect(classifyFailure(trace("retrieval returned no chunks"))).toBe("bad_retrieval");
  });
  it("classifies role-separation as agent-flow", () => {
    expect(classifyFailure(trace("builder codex cannot be its own final evaluator"))).toBe("bad_agent_flow");
  });
  it("falls back to unknown", () => {
    expect(classifyFailure(trace("something unusual happened"))).toBe("unknown");
  });
  it("treats a passing trace as unknown (nothing to classify)", () => {
    const passing = trace("all good");
    passing.verification.pass = true;
    expect(classifyFailure(passing)).toBe("unknown");
  });
  it("explains the failure with family and detail", () => {
    expect(explainFailure(trace("AssertionError: expected 1 received 2")))
      .toContain("bad_reasoning:");
  });
});
