import { describe, expect, it } from "vitest";
import { scoreBranchCandidate } from "./branch-scorer.js";
import type { BranchCandidate, BranchStewardConfig } from "./types.js";

const config: BranchStewardConfig = {
  repo: "gilosbornhello/osstack",
  base: "main",
  remote: "origin",
  branchPrefixAllowlist: ["feat/", "feature/", "codex/"],
  sensitivePathGlobs: [".github/workflows/", "package.json", "pnpm-lock.yaml"],
  maxChangedFiles: 80,
  maxBehindBy: 25,
  prThreshold: 80,
  autoMergeThreshold: 90,
};

function candidate(overrides: Partial<BranchCandidate> = {}): BranchCandidate {
  return {
    repo: "gilosbornhello/osstack",
    base: "main",
    head: "feat/good-branch",
    remote: "origin",
    aheadBy: 4,
    behindBy: 0,
    changedFiles: 6,
    additions: 120,
    deletions: 20,
    hasOpenPr: false,
    checksState: "success",
    sensitivePaths: [],
    reasons: [],
    score: 0,
    action: "report",
    ...overrides,
  };
}

describe("scoreBranchCandidate", () => {
  it("marks a clean feature branch as auto-merge eligible", () => {
    const result = scoreBranchCandidate(candidate(), config);
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.action).toBe("enable_auto_merge");
    expect(result.reasons).toContain("branch prefix is allowlisted");
  });

  it("keeps failing checks in report mode", () => {
    const result = scoreBranchCandidate(candidate({ checksState: "failure" }), config);
    expect(result.action).toBe("report");
    expect(result.reasons).toContain("checks are failing");
  });

  it("escalates sensitive path changes", () => {
    const result = scoreBranchCandidate(candidate({ sensitivePaths: ["package.json"] }), config);
    expect(result.action).toBe("escalate");
    expect(result.reasons).toContain("sensitive paths changed");
  });

  it("keeps non-allowlisted branches in report mode", () => {
    const result = scoreBranchCandidate(candidate({ head: "release/v1" }), config);
    expect(result.action).toBe("report");
    expect(result.score).toBeLessThan(80);
  });

  it("does not auto-merge below the PR threshold when thresholds are inverted", () => {
    const invertedThresholdConfig = {
      ...config,
      prThreshold: 95,
      autoMergeThreshold: 80,
    };
    const result = scoreBranchCandidate(
      candidate({ changedFiles: config.maxChangedFiles + 1 }),
      invertedThresholdConfig,
    );

    expect(result.score).toBe(80);
    expect(result.action).toBe("report");
  });

  it("clamps scores at 100", () => {
    const result = scoreBranchCandidate(candidate(), config);
    expect(result.score).toBe(100);
  });

  it("clamps scores at 0", () => {
    const result = scoreBranchCandidate(
      candidate({
        head: "release/v1",
        aheadBy: 0,
        behindBy: config.maxBehindBy + 1,
        changedFiles: config.maxChangedFiles + 1,
        checksState: "failure",
        hasOpenPr: true,
        isDraft: true,
      }),
      config,
    );

    expect(result.score).toBe(0);
  });
});
