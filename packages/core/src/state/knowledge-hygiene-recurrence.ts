import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";

export const KnowledgeHygieneRecurrencePolicyV1 = z.object({
  min_occurrences: z.number().int().min(2).max(100).default(3),
  min_repositories: z.number().int().min(1).max(100).default(2),
  max_evidence_runs: z.number().int().min(1).max(100).default(20),
}).strict();
export type KnowledgeHygieneRecurrencePolicyV1 = z.infer<
  typeof KnowledgeHygieneRecurrencePolicyV1
>;
export type KnowledgeHygieneRecurrencePolicyInputV1 = z.input<
  typeof KnowledgeHygieneRecurrencePolicyV1
>;

export const KnowledgeHygieneRecurrenceCandidateV1 = z.object({
  schema_version: z.literal("1"),
  candidate_key: z.string().regex(/^khc_[a-f0-9]{64}$/),
  repo_id: z.string().min(1),
  rule_id: z.string().min(1),
  surface: z.string().min(1),
  severity: z.enum(["error", "warning", "info"]),
  fingerprints: z.array(z.string().regex(/^khf_[a-f0-9]{64}$/)).min(1),
  occurrence_count: z.number().int().min(2),
  repository_count: z.number().int().positive(),
  evidence_run_ids: z.array(z.string().regex(/^khr_[a-f0-9]{64}$/)).min(1),
  rationale: z.string().min(1),
  thresholds: z.object({
    min_occurrences: z.number().int().min(2),
    min_repositories: z.number().int().positive(),
  }).strict(),
}).strict();
export type KnowledgeHygieneRecurrenceCandidateV1 = z.infer<
  typeof KnowledgeHygieneRecurrenceCandidateV1
>;

interface OccurrenceWithFinding {
  run_id: string;
  repo_id: string;
  fingerprint: string;
  state: "active" | "resolved" | "closed_absent";
  severity: "error" | "warning" | "info";
  confidence: "high" | "medium" | "low" | "unknown";
  observed_at: number;
  rule_id: string;
  surface: string;
  rationale: string;
}

interface ReplayedFinding {
  event: OccurrenceWithFinding;
  highConfidenceOccurrences: number;
  evidenceRunIds: string[];
}

interface RepositoryCandidate {
  repoId: string;
  ruleId: string;
  surface: string;
  severity: OccurrenceWithFinding["severity"];
  fingerprints: string[];
  occurrenceCount: number;
  evidenceRunIds: string[];
  rationale: string;
}

const severityRank: Record<OccurrenceWithFinding["severity"], number> = {
  error: 3,
  warning: 2,
  info: 1,
};

function candidateKey(repoId: string, ruleId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(["knowledge_hygiene_recurrence", "1", repoId, ruleId]))
    .digest("hex");
  return `khc_${digest}`;
}

/**
 * Replays append-only occurrences and returns conservative automation inputs.
 * Historical rows with unknown confidence, one-offs, and closed findings are
 * intentionally ineligible.
 */
export function queryKnowledgeHygieneRecurrenceCandidates(
  db: Database.Database,
  rawPolicy: KnowledgeHygieneRecurrencePolicyInputV1 = {},
): KnowledgeHygieneRecurrenceCandidateV1[] {
  const policy = KnowledgeHygieneRecurrencePolicyV1.parse(rawPolicy);
  const occurrenceColumns = db.prepare(
    "PRAGMA table_info(knowledge_hygiene_occurrences)",
  ).all() as Array<{ name: string }>;
  const findingColumns = db.prepare(
    "PRAGMA table_info(knowledge_hygiene_findings)",
  ).all() as Array<{ name: string }>;
  if (
    !occurrenceColumns.some((column) => column.name === "confidence")
    || !findingColumns.some((column) => column.name === "confidence")
  ) return [];
  const events = db.prepare(`
    SELECT o.run_id, o.repo_id, o.fingerprint, o.state, o.severity,
           o.confidence, o.observed_at, f.rule_id, f.surface, f.rationale
    FROM knowledge_hygiene_occurrences o
    JOIN knowledge_hygiene_findings f
      ON f.repo_id = o.repo_id AND f.fingerprint = o.fingerprint
    ORDER BY o.observed_at, o.run_id, o.repo_id, o.fingerprint, o.state
  `).all() as OccurrenceWithFinding[];

  const replayed = new Map<string, ReplayedFinding>();
  for (const event of events) {
    const key = `${event.repo_id}\u0000${event.fingerprint}`;
    const previous = replayed.get(key);
    replayed.set(key, {
      event,
      highConfidenceOccurrences: (previous?.highConfidenceOccurrences ?? 0)
        + (event.state === "active" && event.confidence === "high" ? 1 : 0),
      evidenceRunIds: event.state === "active" && event.confidence === "high"
        ? [...(previous?.evidenceRunIds ?? []), event.run_id]
        : previous?.evidenceRunIds ?? [],
    });
  }

  const perRepository = new Map<string, RepositoryCandidate>();
  for (const state of replayed.values()) {
    if (
      state.event.state !== "active"
      || state.event.confidence !== "high"
      || state.highConfidenceOccurrences < policy.min_occurrences
    ) continue;
    const key = `${state.event.repo_id}\u0000${state.event.rule_id}`;
    const previous = perRepository.get(key);
    perRepository.set(key, {
      repoId: state.event.repo_id,
      ruleId: state.event.rule_id,
      surface: previous?.surface ?? state.event.surface,
      severity: previous !== undefined
        && severityRank[previous.severity] > severityRank[state.event.severity]
        ? previous.severity
        : state.event.severity,
      fingerprints: [...(previous?.fingerprints ?? []), state.event.fingerprint],
      occurrenceCount: (previous?.occurrenceCount ?? 0) + state.highConfidenceOccurrences,
      evidenceRunIds: [...(previous?.evidenceRunIds ?? []), ...state.evidenceRunIds],
      rationale: previous?.rationale ?? state.event.rationale,
    });
  }

  const repositoriesByRule = new Map<string, Set<string>>();
  for (const candidate of perRepository.values()) {
    const repositories = repositoriesByRule.get(candidate.ruleId) ?? new Set<string>();
    repositories.add(candidate.repoId);
    repositoriesByRule.set(candidate.ruleId, repositories);
  }

  return [...perRepository.values()]
    .filter((candidate) =>
      (repositoriesByRule.get(candidate.ruleId)?.size ?? 0) >= policy.min_repositories)
    .sort((a, b) => a.repoId.localeCompare(b.repoId) || a.ruleId.localeCompare(b.ruleId))
    .map((candidate) => KnowledgeHygieneRecurrenceCandidateV1.parse({
      schema_version: "1",
      candidate_key: candidateKey(candidate.repoId, candidate.ruleId),
      repo_id: candidate.repoId,
      rule_id: candidate.ruleId,
      surface: candidate.surface,
      severity: candidate.severity,
      fingerprints: [...new Set(candidate.fingerprints)].sort(),
      occurrence_count: candidate.occurrenceCount,
      repository_count: repositoriesByRule.get(candidate.ruleId)?.size ?? 0,
      evidence_run_ids: [...new Set(candidate.evidenceRunIds)]
        .slice(-policy.max_evidence_runs),
      rationale: candidate.rationale,
      thresholds: {
        min_occurrences: policy.min_occurrences,
        min_repositories: policy.min_repositories,
      },
    }));
}
