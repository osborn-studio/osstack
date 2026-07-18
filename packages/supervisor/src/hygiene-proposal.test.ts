import type { KnowledgeHygieneRecurrenceCandidateV1 } from "@osstack/core";
import { describe, expect, it } from "vitest";
import { decideProposalGate } from "./gate.js";
import { proposeKnowledgeHygieneImprovements } from "./hygiene-proposal.js";

function candidate(
  occurrenceCount = 3,
  evidenceRunIds = [`khr_${"a".repeat(64)}`],
): KnowledgeHygieneRecurrenceCandidateV1 {
  return {
    schema_version: "1",
    candidate_key: `khc_${"b".repeat(64)}`,
    repo_id: "osstack",
    rule_id: "contract.review_required",
    surface: "documentation",
    severity: "warning",
    fingerprints: [`khf_${"c".repeat(64)}`],
    occurrence_count: occurrenceCount,
    repository_count: 2,
    evidence_run_ids: evidenceRunIds,
    rationale: "Review evidence is required.",
    thresholds: { min_occurrences: 3, min_repositories: 2 },
  };
}

describe("knowledge hygiene improvement proposal adapter", () => {
  it("creates an evidence-backed draft that cannot auto-apply", async () => {
    const [proposal] = proposeKnowledgeHygieneImprovements({
      candidates: [candidate()],
      created_at: "2026-07-17T23:00:00.000Z",
    });

    expect(proposal).toMatchObject({
      repo_id: "osstack",
      source_asset_ids: [`khr_${"a".repeat(64)}`],
      target: "policy",
      risk: "high",
      status: "draft",
      proposed_changes: [],
      required_gates: ["osstack neat check --all --fail-on error"],
    });
    await expect(decideProposalGate(proposal!, {
      runGate: async () => ({ pass: true, summary: "green" }),
    })).resolves.toMatchObject({ action: "needs_human" });
  });

  it("uses a stable proposal id as recurrence evidence grows", () => {
    const first = proposeKnowledgeHygieneImprovements({
      candidates: [candidate()],
      created_at: "2026-07-17T23:00:00.000Z",
    });
    const later = proposeKnowledgeHygieneImprovements({
      candidates: [candidate(5, [
        `khr_${"a".repeat(64)}`,
        `khr_${"d".repeat(64)}`,
      ])],
      created_at: "2026-07-18T23:00:00.000Z",
    });

    expect(later[0]?.proposal_id).toBe(first[0]?.proposal_id);
    expect(later[0]?.rationale).toContain("5 high-confidence occurrences");
  });

  it("deduplicates duplicate candidates and merges their evidence", () => {
    const proposals = proposeKnowledgeHygieneImprovements({
      candidates: [
        candidate(),
        candidate(4, [`khr_${"d".repeat(64)}`]),
      ],
      created_at: "2026-07-17T23:00:00.000Z",
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.source_asset_ids).toEqual([
      `khr_${"a".repeat(64)}`,
      `khr_${"d".repeat(64)}`,
    ]);
  });
});
