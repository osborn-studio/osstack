import {
  KnowledgeHygieneRecurrenceCandidateV1,
  KnowledgeHygieneRecurrenceCandidateV2,
} from "@osstack/core";
import { ImprovementProposal, type ImprovementProposal as Proposal } from "./types.js";

type RecurrenceCandidate =
  | KnowledgeHygieneRecurrenceCandidateV1
  | KnowledgeHygieneRecurrenceCandidateV2;
const recurrenceCandidate = KnowledgeHygieneRecurrenceCandidateV1.or(
  KnowledgeHygieneRecurrenceCandidateV2,
);

export interface ProposeKnowledgeHygieneImprovementsInputV1 {
  candidates: readonly RecurrenceCandidate[];
  created_at: string;
}

interface MergedCandidate {
  candidate: RecurrenceCandidate;
  evidenceRunIds: Set<string>;
}

/**
 * Converts already-thresholded recurrence evidence into human-reviewed drafts.
 * This adapter has no write or hook-installation capability.
 */
export function proposeKnowledgeHygieneImprovements(
  input: ProposeKnowledgeHygieneImprovementsInputV1,
): Proposal[] {
  const merged = new Map<string, MergedCandidate>();
  for (const rawCandidate of input.candidates) {
    const candidate = recurrenceCandidate.parse(rawCandidate);
    const proposalId = `prop_neat_${candidate.candidate_key.slice("khc_".length)}`;
    const previous = merged.get(proposalId);
    if (previous === undefined) {
      merged.set(proposalId, {
        candidate,
        evidenceRunIds: new Set(candidate.evidence_run_ids),
      });
      continue;
    }
    for (const runId of candidate.evidence_run_ids) previous.evidenceRunIds.add(runId);
    if (candidate.occurrence_count > previous.candidate.occurrence_count) {
      previous.candidate = candidate;
    }
  }

  return [...merged.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([proposalId, item]) => ImprovementProposal.parse({
      proposal_id: proposalId,
      repo_id: item.candidate.repo_id,
      source_asset_ids: [...item.evidenceRunIds].sort(),
      target: "policy",
      risk: "high",
      title: `Review deterministic gate for ${item.candidate.rule_id}`,
      rationale: [
        `${item.candidate.occurrence_count} high-confidence occurrences of`,
        `${item.candidate.rule_id} remain active in ${item.candidate.repo_id};`,
        `${item.candidate.repository_count} repositories meet the recurrence policy`,
        `(thresholds: ${item.candidate.thresholds.min_occurrences} occurrences,`,
        `${item.candidate.thresholds.min_repositories} repositories).`,
        item.candidate.rationale,
      ].join(" "),
      // No hook or policy path is chosen automatically. A human must decide
      // whether a deterministic gate is appropriate and author the change.
      proposed_changes: [],
      required_gates: ["osstack neat check --all --fail-on error"],
      status: "draft",
      created_at: input.created_at,
    }));
}
