import { describe, expect, it } from "vitest";
import {
  CoverageDimensionV2,
  KnowledgeHygieneFindingV2,
  KnowledgeHygieneCheckInputV2,
  KnowledgeHygieneReportV2,
  KnowledgeHygieneResolutionEventV2,
  KnowledgeHygieneRuleIdV2,
} from "./types-v2.js";

const sha = "a".repeat(64);

function findingV2() {
  return {
    fingerprint: `khf_${sha}`,
    rule_id: "rulebook.managed_context_block",
    rule_version: "1",
    surface: "instruction",
    severity: "warning",
    confidence: "high",
    location: {
      kind: "repository",
      repo_id: "repo-1",
      path: "AGENTS.md",
      line: 2,
    },
    observed: { marker: "<claude-mem-context>" },
    expected: { absent: true },
    rationale: "Managed session context does not belong in instructions.",
    evidence_refs: [],
    remediation: { mode: "agent_edit" },
    origin: "mechanical",
    dimension: "narrative",
    closure_policy: "mechanical_sufficient",
    citations: [{
      source: { kind: "repository", repo_id: "repo-1", path: "AGENTS.md" },
      blob_sha256: sha,
      start_line: 2,
      end_line: 4,
      text_sha256: sha,
      excerpt: "<claude-mem-context>",
    }],
  } as const;
}

function mechanicalCoverage() {
  return {
    dimension: "mechanical",
    state: "complete",
    source_units_total: 1,
    candidates_generated: 1,
    candidates_assessed: 1,
    candidates_skipped: 0,
    reason_codes: [],
  } as const;
}

function notRequestedCoverage(
  dimension: "narrative" | "contradiction" | "drift" | "memory_overlap" | "cross_repository",
) {
  return {
    dimension,
    state: "not_assessed",
    source_units_total: 0,
    candidates_generated: 0,
    candidates_assessed: 0,
    candidates_skipped: 0,
    reason_codes: ["not_requested"],
  } as const;
}

function fullCoverage() {
  return [
    mechanicalCoverage(),
    notRequestedCoverage("narrative"),
    notRequestedCoverage("contradiction"),
    notRequestedCoverage("drift"),
    notRequestedCoverage("memory_overlap"),
    notRequestedCoverage("cross_repository"),
  ] as const;
}

describe("knowledge hygiene v2 contracts", () => {
  it("keeps V2 rule ids additive over V1", () => {
    expect(KnowledgeHygieneRuleIdV2.options).toContain(
      "instruction.canonical_missing",
    );
    expect(KnowledgeHygieneRuleIdV2.options).toContain(
      "semantic.cross_repository_impact",
    );
  });

  it("accepts V2-only rule selection without weakening input grammar", () => {
    expect(KnowledgeHygieneCheckInputV2.parse({
      schema_version: "2",
      repo_root: "/repo",
      mode: "all",
      checks: ["rulebook.managed_context_block"],
    })).toMatchObject({
      schema_version: "2",
      checks: ["rulebook.managed_context_block"],
    });
    expect(KnowledgeHygieneCheckInputV2.safeParse({
      schema_version: "2",
      repo_root: "/repo",
      mode: "range",
    }).success).toBe(false);
    expect(KnowledgeHygieneCheckInputV2.safeParse({
      schema_version: "2",
      repo_root: "/repo",
      mode: "all",
      checks: ["rulebook.managed_context_block", "rulebook.managed_context_block"],
    }).success).toBe(false);
  });

  it("accepts a strict portable V2 finding", () => {
    expect(KnowledgeHygieneFindingV2.parse(findingV2())).toEqual(findingV2());
    expect(
      KnowledgeHygieneFindingV2.safeParse({ ...findingV2(), extra: true }).success,
    ).toBe(false);
    expect(
      KnowledgeHygieneFindingV2.safeParse({
        ...findingV2(),
        location: {
          kind: "repository",
          repo_id: "repo-1",
          path: "../AGENTS.md",
        },
      }).success,
    ).toBe(false);
  });

  it("enforces coverage state and count invariants", () => {
    expect(CoverageDimensionV2.parse(mechanicalCoverage())).toEqual(
      mechanicalCoverage(),
    );
    expect(CoverageDimensionV2.safeParse({
      ...mechanicalCoverage(),
      candidates_skipped: 1,
    }).success).toBe(false);
    expect(CoverageDimensionV2.safeParse({
      ...mechanicalCoverage(),
      state: "truncated",
      candidates_assessed: 0,
      candidates_skipped: 1,
      reason_codes: ["bounded_candidate_generator"],
    }).success).toBe(false);
    expect(CoverageDimensionV2.safeParse({
      ...mechanicalCoverage(),
      dimension: "narrative",
    }).success).toBe(false);
    expect(CoverageDimensionV2.safeParse({
      ...notRequestedCoverage("narrative"),
      reason_codes: ["not_requested", "judge_unavailable"],
    }).success).toBe(false);
  });

  it("enforces the new-rule dimension and origin registry", () => {
    expect(KnowledgeHygieneFindingV2.safeParse({
      ...findingV2(),
      dimension: "drift",
    }).success).toBe(false);
    expect(KnowledgeHygieneFindingV2.safeParse({
      ...findingV2(),
      origin: "semantic",
    }).success).toBe(false);
  });

  it("enforces health-claim precedence and unique dimensions", () => {
    const report = {
      schema_version: "2",
      generated_at: "2026-07-18T00:00:00.000Z",
      repo: { root: "/repo", repo_id: "repo-1" },
      input: { mode: "all" },
      completeness: { complete: true, skipped_files: 0, reasons: [] },
      summary: { error: 0, warning: 1, info: 0, suppressed: 0 },
      findings: [findingV2()],
      metrics: [],
      coverage: fullCoverage(),
      health_claim: "findings_present",
      rejection_counts: {},
    } as const;
    expect(KnowledgeHygieneReportV2.parse(report)).toEqual(report);
    expect(KnowledgeHygieneReportV2.safeParse({
      ...report,
      health_claim: "assessed_scope_clean",
    }).success).toBe(false);
    expect(KnowledgeHygieneReportV2.safeParse({
      ...report,
      coverage: [...fullCoverage(), mechanicalCoverage()],
    }).success).toBe(false);
    expect(KnowledgeHygieneReportV2.safeParse({
      ...report,
      coverage: [...fullCoverage()].reverse(),
    }).success).toBe(false);
    expect(KnowledgeHygieneReportV2.safeParse({
      ...report,
      coverage: [mechanicalCoverage()],
    }).success).toBe(false);
  });

  it("accepts legal lifecycle events and rejects illegal transitions", () => {
    const event = {
      schema_version: "2",
      event_id: `khev_${sha}`,
      repo_id: "repo-1",
      fingerprint: `khf_${sha}`,
      from_state: "open",
      to_state: "mechanically_applied",
      actor: { kind: "system", id: "system:governance" },
      reason: "Approved plan applied.",
      evidence_refs: [{
        kind: "evidence_pack",
        ref: "pack-1",
        sha256: sha,
        run_id: "run-1",
      }],
      occurred_at: "2026-07-18T00:00:00.000Z",
    } as const;
    expect(KnowledgeHygieneResolutionEventV2.parse(event)).toEqual(event);
    expect(KnowledgeHygieneResolutionEventV2.safeParse({
      ...event,
      to_state: "resolved_legacy",
    }).success).toBe(false);
    expect(KnowledgeHygieneResolutionEventV2.safeParse({
      ...event,
      to_state: "suppressed",
    }).success).toBe(false);
  });
});
