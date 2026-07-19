import { describe, expect, it } from "vitest";
import {
  applyKnowledgeHygieneReviewArtifactV2,
  knowledgeHygieneReportSha256V2,
  KnowledgeHygieneReviewArtifactV2,
} from "./resolution-v2.js";
import { KnowledgeHygieneReportV2 } from "./types-v2.js";

const fingerprint = `khf_${"a".repeat(64)}`;

function report() {
  return KnowledgeHygieneReportV2.parse({
    schema_version: "2",
    generated_at: "2026-07-18T00:00:00.000Z",
    repo: { root: "/repo", repo_id: "repo-1" },
    input: { mode: "all" },
    completeness: { complete: true, skipped_files: 0, reasons: [] },
    summary: { error: 0, warning: 1, info: 0, suppressed: 0 },
    findings: [{
      fingerprint,
      rule_id: "rulebook.managed_context_block",
      rule_version: "1",
      surface: "instruction",
      severity: "warning",
      confidence: "high",
      location: { kind: "repository", repo_id: "repo-1", path: "AGENTS.md" },
      observed: { marker: true },
      expected: { marker: false },
      rationale: "Managed context is transient.",
      evidence_refs: [],
      remediation: { mode: "agent_edit" },
      origin: "mechanical",
      dimension: "narrative",
      closure_policy: "mechanical_sufficient",
      citations: [],
    }],
    metrics: [],
    coverage: [
      {
        dimension: "mechanical",
        state: "complete",
        source_units_total: 1,
        candidates_generated: 1,
        candidates_assessed: 1,
        candidates_skipped: 0,
        reason_codes: [],
      },
      {
        dimension: "narrative",
        state: "partial",
        source_units_total: 1,
        candidates_generated: 1,
        candidates_assessed: 1,
        candidates_skipped: 0,
        reason_codes: ["bounded_candidate_generator"],
      },
      ...["contradiction", "drift", "memory_overlap", "cross_repository"].map(
        (dimension) => ({
          dimension,
          state: "not_assessed" as const,
          source_units_total: 0,
          candidates_generated: 0,
          candidates_assessed: 0,
          candidates_skipped: 0,
          reason_codes: ["not_requested" as const],
        }),
      ),
    ],
    health_claim: "findings_present",
    rejection_counts: {},
  });
}

function artifact(toState: "mechanically_applied" | "accepted_risk") {
  const source = report();
  return KnowledgeHygieneReviewArtifactV2.parse({
    schema_version: "2",
    report_sha256: knowledgeHygieneReportSha256V2(source),
    repo_id: "repo-1",
    resolution_events: [{
      schema_version: "2",
      event_id: `khev_${(toState === "accepted_risk" ? "b" : "c").repeat(64)}`,
      repo_id: "repo-1",
      fingerprint,
      from_state: "open",
      to_state: toState,
      actor: { kind: "human", id: "owner" },
      reason: "Reviewed against the cited report.",
      evidence_refs: [{
        kind: "report",
        ref: "inline-report",
        sha256: knowledgeHygieneReportSha256V2(source),
      }],
      occurred_at: "2026-07-18T00:01:00.000Z",
    }],
  });
}

describe("V2 review artifacts", () => {
  it("moves terminal review outcomes into append-only resolved findings", () => {
    const applied = applyKnowledgeHygieneReviewArtifactV2(
      report(),
      artifact("accepted_risk"),
    );
    expect(applied.findings).toEqual([]);
    expect(applied.resolved_findings?.[0]).toMatchObject({
      finding: { fingerprint },
      resolution_events: [{ from_state: "open", to_state: "accepted_risk" }],
    });
    expect(applied.summary.resolved).toBe(1);
    expect(applied.health_claim).toBe("assessed_scope_clean");
  });

  it("keeps non-terminal mechanically_applied findings open", () => {
    const applied = applyKnowledgeHygieneReviewArtifactV2(
      report(),
      artifact("mechanically_applied"),
    );
    expect(applied.findings).toHaveLength(1);
    expect(applied.resolved_findings?.[0]?.resolution_events).toHaveLength(1);
  });

  it("rejects artifacts bound to another report", () => {
    expect(() => applyKnowledgeHygieneReviewArtifactV2(report(), {
      ...artifact("accepted_risk"),
      report_sha256: "d".repeat(64),
    })).toThrow("report hash");
  });
});
