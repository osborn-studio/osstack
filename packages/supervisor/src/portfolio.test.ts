import { describe, expect, it } from "vitest";
import { buildPortfolioReport } from "./portfolio.js";

describe("portfolio report", () => {
  it("averages enabled non-reference repos", () => {
    const report = buildPortfolioReport([
      {
        repo_id: "osstack",
        name: "osstack",
        path: "/repo/osstack",
        role: "core_platform",
        exists: true,
        git_clean: true,
        has_readme: true,
        has_loop_doc: true,
        has_tests: true,
        has_verify_command: true,
        closed_loop_level: 4,
        findings: [],
      },
      {
        repo_id: "stock-monitor",
        name: "stock-monitor",
        path: "/repo/stock-monitor",
        role: "business_product",
        exists: true,
        has_readme: true,
        has_loop_doc: false,
        has_tests: true,
        has_verify_command: false,
        closed_loop_level: 1,
        findings: ["missing loop doc"],
      },
      {
        repo_id: "reference",
        name: "reference",
        path: "/repo/reference",
        role: "reference",
        exists: true,
        has_readme: true,
        has_loop_doc: false,
        has_tests: false,
        has_verify_command: false,
        closed_loop_level: 0,
        findings: [],
      },
    ]);
    expect(report.repo_count).toBe(3);
    expect(report.enabled_repo_count).toBe(2);
    expect(report.average_closed_loop_level).toBe(2.5);
    expect(report.recommendations.join("\n")).toMatch(/stock-monitor/);

    // Structured mirror stays byte-identical and in-sync with the free text.
    expect(report.structured_recommendations.map((r) => r.text)).toEqual(report.recommendations);
    // stock-monitor is < L2 with no loop doc → an add_loop_doc kind carrying its repo_id.
    const loopDoc = report.structured_recommendations.find((r) => r.kind === "add_loop_doc");
    expect(loopDoc).toEqual({
      kind: "add_loop_doc",
      repo_id: "stock-monitor",
      text: "stock-monitor: add docs/LOOP.md to declare closed-loop contract",
    });
  });

  it("emits a kind for every recommendation and carries repo_id for per-repo kinds", () => {
    const report = buildPortfolioReport([
      {
        repo_id: "gone",
        name: "gone",
        path: "/repo/gone",
        role: "app",
        exists: false,
        has_readme: false,
        has_loop_doc: false,
        has_tests: false,
        has_verify_command: false,
        closed_loop_level: 0,
        findings: [],
      },
      {
        repo_id: "weak",
        name: "weak",
        path: "/repo/weak",
        role: "app",
        exists: true,
        has_readme: true,
        has_loop_doc: false,
        has_tests: false,
        has_verify_command: false,
        closed_loop_level: 1,
        latest_loop_success_rate: 0.5,
        evaluator_epoch_id: "epoch_1",
        adversarial_case_count: 0,
        evaluator_anchor_accuracy: 0.5,
        findings: [],
      },
      // Duplicate path + name → a portfolio-level consolidation (no repo_id).
      {
        repo_id: "dup-a",
        name: "dup",
        path: "/repo/dup",
        role: "app",
        exists: true,
        has_readme: true,
        has_loop_doc: true,
        has_tests: true,
        has_verify_command: true,
        closed_loop_level: 3,
        findings: [],
      },
      {
        repo_id: "dup-b",
        name: "dup",
        path: "/repo/dup",
        role: "app",
        exists: true,
        has_readme: true,
        has_loop_doc: true,
        has_tests: true,
        has_verify_command: true,
        closed_loop_level: 3,
        findings: [],
      },
    ]);

    // Every free-text entry has a parallel structured entry (same order + text).
    expect(report.structured_recommendations.map((r) => r.text)).toEqual(report.recommendations);
    // Every structured entry has a kind.
    expect(report.structured_recommendations.every((r) => r.kind !== undefined)).toBe(true);

    const kinds = report.structured_recommendations.map((r) => r.kind);
    expect(kinds).toEqual([
      "missing_path", // gone
      "add_loop_doc", // weak
      "add_verify_command", // weak
      "enable_failure_assetization", // weak
      "create_evaluator_anchor_set", // weak
      "freeze_evaluator", // weak
      "consolidation", // dup path
      "consolidation", // dup name
    ]);

    // Per-repo kinds carry a repo_id; consolidation is portfolio-level (no repo_id).
    for (const rec of report.structured_recommendations) {
      if (rec.kind === "consolidation") expect(rec.repo_id).toBeUndefined();
      else expect(rec.repo_id).toBeDefined();
    }
  });
});
