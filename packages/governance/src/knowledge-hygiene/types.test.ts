import { describe, expect, it } from "vitest";
import {
  KnowledgeHygieneCheckInputV1,
  KnowledgeHygieneFindingV1,
  KnowledgeHygieneReportV1,
  KnowledgeHygieneRuleIdV1,
} from "./types.js";

const finding = {
  fingerprint: `khf_${"a".repeat(64)}`,
  rule_id: "instruction.mirror_drift",
  rule_version: "1",
  surface: "instruction",
  severity: "error",
  confidence: "high",
  location: { path: "CLAUDE.md", line: 2, anchor: "mirror:CLAUDE.md" },
  observed: { mode: "independent_file" },
  expected: { mode: "import_or_symlink" },
  rationale: "The declared mirror does not resolve to the canonical file.",
  evidence_refs: [{ kind: "proof", ref: "CLAUDE.md" }],
  remediation: { mode: "human_decision" },
} as const;

describe("knowledge hygiene domain contracts", () => {
  it("accepts a strict version 1 finding", () => {
    expect(KnowledgeHygieneFindingV1.parse(finding)).toEqual(finding);
  });

  it("rejects unknown rule ids and unknown fields", () => {
    expect(() => KnowledgeHygieneRuleIdV1.parse("documentation.prose_style"))
      .toThrow();
    expect(() => KnowledgeHygieneFindingV1.parse({ ...finding, extra: true }))
      .toThrow();
  });

  it("accepts a strict report with surface metrics", () => {
    const report = {
      schema_version: "1",
      generated_at: "2026-07-17T23:00:00.000Z",
      repo: { root: "/repo", repo_id: "example" },
      input: {
        mode: "range",
        base_ref: "main",
        base_sha: "b".repeat(40),
        head_ref: "HEAD",
        head_sha: "c".repeat(40),
        diff_id: `diff_${"d".repeat(64)}`,
        config_path: ".osstack/neat.yaml",
        config_sha256: "e".repeat(64),
      },
      completeness: { complete: true, skipped_files: 0, reasons: [] },
      summary: { error: 1, warning: 0, info: 0, suppressed: 0 },
      findings: [finding],
      metrics: [{
        surface: "instruction",
        path: "AGENTS.md",
        kind: "file",
        exists: true,
        bytes: 120,
        lines: 8,
        sha256: "f".repeat(64),
      }],
    } as const;

    expect(KnowledgeHygieneReportV1.parse(report)).toEqual(report);
  });

  it("enforces mode-specific refs and mutually exclusive rule filters", () => {
    expect(() => KnowledgeHygieneCheckInputV1.parse({
      repo_root: "/repo",
      mode: "range",
      base_ref: "main",
    })).toThrow();

    expect(() => KnowledgeHygieneCheckInputV1.parse({
      repo_root: "/repo",
      mode: "all",
      checks: ["instruction.canonical_missing"],
      skip_checks: ["instruction.mirror_drift"],
    })).toThrow();

    expect(KnowledgeHygieneCheckInputV1.parse({
      repo_root: "/repo",
      mode: "base_to_worktree",
      base_ref: "main",
      checks: ["instruction.canonical_missing"],
    })).toEqual({
      repo_root: "/repo",
      mode: "base_to_worktree",
      base_ref: "main",
      checks: ["instruction.canonical_missing"],
    });
  });
});
