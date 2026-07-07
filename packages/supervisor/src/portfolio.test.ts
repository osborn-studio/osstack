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
  });
});
