import { describe, expect, it } from "vitest";
import {
  applyKnowledgeHygieneReviewArtifact,
  assertKnowledgeHygieneReviewArtifactMatchesReport,
  type KnowledgeHygieneReviewError,
} from "./resolution.js";
import {
  KnowledgeHygieneFindingV1,
  KnowledgeHygieneReportV1,
  KnowledgeHygieneResolutionV1,
  KnowledgeHygieneReviewArtifactV1,
} from "./types.js";

const diffId = `diff_${"a".repeat(64)}`;
const fingerprint = `khf_${"b".repeat(64)}`;

function resolution(outcome: string = "fixed") {
  return {
    schema_version: "1",
    diff_id: diffId,
    fingerprint,
    outcome,
    actor: { kind: "human", id: "osborn" },
    reason: "Reviewed against current repository evidence.",
    evidence_refs: [],
    resolved_at: "2026-07-17T00:00:00.000Z",
  };
}

function report(overrides: Record<string, unknown> = {}) {
  const finding = KnowledgeHygieneFindingV1.parse({
    fingerprint,
    rule_id: "contract.review_required",
    rule_version: "1",
    surface: "documentation",
    severity: "warning",
    confidence: "medium",
    location: { path: "src/app.ts", anchor: "contract:docs" },
    observed: {},
    expected: {},
    rationale: "Review evidence is required.",
    evidence_refs: [],
    remediation: { mode: "human_decision" },
  });
  return KnowledgeHygieneReportV1.parse({
    schema_version: "1",
    generated_at: "2026-07-17T00:00:00.000Z",
    repo: { root: "/repo", repo_id: "repo" },
    input: { mode: "worktree", base_ref: "HEAD", diff_id: diffId },
    completeness: { complete: true, skipped_files: 0, reasons: [] },
    summary: { error: 0, warning: 1, info: 0, suppressed: 0 },
    findings: [finding],
    metrics: [],
    ...overrides,
  });
}

describe("knowledge hygiene review artifacts", () => {
  it("accepts all five resolution outcomes", () => {
    for (const outcome of [
      "fixed",
      "reviewed_no_change",
      "accepted_risk",
      "suppressed",
      "obsolete",
    ]) {
      expect(KnowledgeHygieneResolutionV1.safeParse(resolution(outcome)).success)
        .toBe(true);
    }
  });

  it("rejects empty reasons, duplicate fingerprints, and mixed diff ids", () => {
    expect(KnowledgeHygieneResolutionV1.safeParse({
      ...resolution(),
      reason: " ",
    }).success).toBe(false);
    expect(KnowledgeHygieneReviewArtifactV1.safeParse({
      schema_version: "1",
      diff_id: diffId,
      resolutions: [resolution(), resolution()],
    }).success).toBe(false);
    expect(KnowledgeHygieneReviewArtifactV1.safeParse({
      schema_version: "1",
      diff_id: diffId,
      resolutions: [{
        ...resolution(),
        diff_id: `diff_${"c".repeat(64)}`,
      }],
    }).success).toBe(false);
  });

  it("rejects stale diff ids and unknown fingerprints against a report", () => {
    const stale = KnowledgeHygieneReviewArtifactV1.parse({
      schema_version: "1",
      diff_id: `diff_${"c".repeat(64)}`,
      resolutions: [{
        ...resolution(),
        diff_id: `diff_${"c".repeat(64)}`,
      }],
    });
    expect(() => assertKnowledgeHygieneReviewArtifactMatchesReport(
      report(),
      stale,
    )).toThrowError(expect.objectContaining({
      code: "diff_mismatch",
    }) as KnowledgeHygieneReviewError);

    const unknown = KnowledgeHygieneReviewArtifactV1.parse({
      schema_version: "1",
      diff_id: diffId,
      resolutions: [{
        ...resolution(),
        fingerprint: `khf_${"d".repeat(64)}`,
      }],
    });
    expect(() => assertKnowledgeHygieneReviewArtifactMatchesReport(
      report(),
      unknown,
    )).toThrowError(expect.objectContaining({
      code: "unknown_fingerprint",
    }) as KnowledgeHygieneReviewError);
  });

  it("rejects reports without a diff id and accepts an exact match", () => {
    const artifact = KnowledgeHygieneReviewArtifactV1.parse({
      schema_version: "1",
      diff_id: diffId,
      resolutions: [resolution()],
    });
    const allReport = report({ input: { mode: "all" } });
    expect(() => assertKnowledgeHygieneReviewArtifactMatchesReport(
      allReport,
      artifact,
    )).toThrowError(expect.objectContaining({
      code: "report_missing_diff",
    }) as KnowledgeHygieneReviewError);
    expect(() => assertKnowledgeHygieneReviewArtifactMatchesReport(
      report(),
      artifact,
    )).not.toThrow();
  });

  it("moves resolved findings into an evidence-preserving resolved view", () => {
    const source = report();
    const artifact = KnowledgeHygieneReviewArtifactV1.parse({
      schema_version: "1",
      diff_id: diffId,
      resolutions: [resolution("reviewed_no_change")],
    });

    const applied = applyKnowledgeHygieneReviewArtifact(source, artifact);

    expect(applied).toMatchObject({
      summary: { error: 0, warning: 0, info: 0, suppressed: 0, resolved: 1 },
      findings: [],
      resolved_findings: [{
        finding: source.findings[0],
        resolution: artifact.resolutions[0],
      }],
    });
    expect(source.findings).toHaveLength(1);
    expect(source).not.toHaveProperty("resolved_findings");
  });

  it("recounts only unresolved severities and preserves prior suppression", () => {
    const first = report().findings[0];
    const unresolved = KnowledgeHygieneFindingV1.parse({
      ...first,
      fingerprint: `khf_${"e".repeat(64)}`,
      severity: "error",
      location: { path: "AGENTS.md" },
    });
    const source = report({
      summary: { error: 1, warning: 1, info: 0, suppressed: 2 },
      findings: [first, unresolved],
    });
    const artifact = KnowledgeHygieneReviewArtifactV1.parse({
      schema_version: "1",
      diff_id: diffId,
      resolutions: [resolution("accepted_risk")],
    });

    const applied = applyKnowledgeHygieneReviewArtifact(source, artifact);

    expect(applied.summary).toEqual({
      error: 1,
      warning: 0,
      info: 0,
      suppressed: 2,
      resolved: 1,
    });
    expect(applied.findings).toEqual([unresolved]);
  });
});
