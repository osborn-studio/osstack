import { describe, expect, it } from "vitest";
import { renderBranchStewardReport } from "./report.js";
import type { BranchStewardReport } from "./types.js";

describe("renderBranchStewardReport", () => {
  it("renders the no-candidate state", () => {
    const report: BranchStewardReport = {
      repo: "gilosbornhello/osstack",
      base: "main",
      generatedAt: "2026-06-20T00:00:00.000Z",
      candidates: [],
      prIntents: [],
    };

    expect(renderBranchStewardReport(report)).toContain("No eligible branch candidates found.");
  });
});
