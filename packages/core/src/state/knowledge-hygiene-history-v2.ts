import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  KnowledgeHygieneRecurrencePolicyV1,
  type KnowledgeHygieneRecurrencePolicyInputV1,
} from "./knowledge-hygiene-recurrence.js";
import type { FindingLifecycleStateV2Core } from "./knowledge-hygiene-store-v2.js";

const severity = z.enum(["error", "warning", "info"]);
const fingerprint = z.string().regex(/^khf_[a-f0-9]{64}$/);
const runId = z.string().regex(/^khr2?_[a-f0-9]{64}$/);

export const KnowledgeHygieneTrendReportV2Core = z
  .object({
    schema_version: z.literal("2"),
    repo_id: z.string().min(1),
    as_of: z.number().finite(),
    report_count: z.number().int().nonnegative(),
    sources: z
      .object({
        v1_reports: z.number().int().nonnegative(),
        v2_reports: z.number().int().nonnegative(),
      })
      .strict(),
    open: z
      .object({
        total: z.number().int().nonnegative(),
        error: z.number().int().nonnegative(),
        warning: z.number().int().nonnegative(),
        info: z.number().int().nonnegative(),
        oldest_age_days: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    recurrence: z
      .object({
        total: z.number().int().nonnegative(),
        warning: z.number().int().nonnegative(),
      })
      .strict(),
    closure: z
      .object({
        tracked: z.number().int().nonnegative(),
        closed: z.number().int().nonnegative(),
        rate: z.number().min(0).max(1),
      })
      .strict(),
    delta: z
      .object({
        new: z.number().int().nonnegative(),
        resolved: z.number().int().nonnegative(),
      })
      .strict(),
    suppressed: z.object({ latest: z.number().int().nonnegative() }).strict(),
    latest_assessment: z
      .object({
        schema_version: z.enum(["1", "2"]),
        health_claim: z.enum([
          "findings_present",
          "assessed_scope_clean",
          "assessment_incomplete",
        ]),
        coverage: z.array(z.record(z.unknown())),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type KnowledgeHygieneTrendReportV2Core = z.infer<
  typeof KnowledgeHygieneTrendReportV2Core
>;

export const KnowledgeHygieneRecurrenceCandidateV2 = z
  .object({
    schema_version: z.literal("2"),
    candidate_key: z.string().regex(/^khc_[a-f0-9]{64}$/),
    repo_id: z.string().min(1),
    rule_id: z.string().min(1),
    surface: z.string().min(1),
    severity,
    fingerprints: z.array(fingerprint).min(1),
    occurrence_count: z.number().int().min(2),
    repository_count: z.number().int().positive(),
    evidence_run_ids: z.array(runId).min(1),
    rationale: z.string().min(1),
    thresholds: z
      .object({
        min_occurrences: z.number().int().min(2),
        min_repositories: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
export type KnowledgeHygieneRecurrenceCandidateV2 = z.infer<
  typeof KnowledgeHygieneRecurrenceCandidateV2
>;

interface RunRow {
  schema_version: "1" | "2";
  run_id: string;
  generated_at: number;
  recorded_at: number;
  suppressed_count: number;
  resolved_count: number;
  complete?: number;
  coverage_json?: string;
  health_claim?: "findings_present" | "assessed_scope_clean" | "assessment_incomplete";
}

interface UnifiedFinding {
  repoId: string;
  fingerprint: string;
  ruleId: string;
  surface: string;
  severity: "error" | "warning" | "info";
  confidence: "high" | "medium" | "low" | "unknown";
  rationale: string;
  state: FindingLifecycleStateV2Core;
  firstSeenAt: number;
  lastSeenAt: number;
  occurrenceCount: number;
  highConfidenceOccurrences: number;
  evidenceRunIds: string[];
  v2: boolean;
}

function parseObject(value: string, label: string): Record<string, unknown> {
  try {
    return z.record(z.unknown()).parse(JSON.parse(value));
  } catch (error) {
    throw new Error(
      `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function v1State(
  state: "active" | "resolved" | "closed_absent",
  outcome: string | null,
): FindingLifecycleStateV2Core {
  if (state === "active") return "open";
  if (state === "closed_absent") return "closed_absent";
  if (
    outcome === "reviewed_no_change"
    || outcome === "accepted_risk"
    || outcome === "suppressed"
    || outcome === "obsolete"
  ) {
    return outcome;
  }
  return "resolved_legacy";
}

function listRuns(db: Database.Database, repoId: string): RunRow[] {
  const v1 = db.prepare(`
    SELECT '1' AS schema_version, run_id, generated_at, recorded_at,
           suppressed_count, resolved_count, complete
    FROM knowledge_hygiene_runs WHERE repo_id = ?
  `).all(repoId) as RunRow[];
  const v2 = db.prepare(`
    SELECT '2' AS schema_version, run_id, generated_at, recorded_at,
           suppressed_count, resolved_count, coverage_json, health_claim
    FROM knowledge_hygiene_runs_v2 WHERE repo_id = ?
  `).all(repoId) as RunRow[];
  return [...v1, ...v2].sort((left, right) =>
    left.generated_at - right.generated_at
    || left.recorded_at - right.recorded_at
    || left.run_id.localeCompare(right.run_id)
  );
}

function listUnifiedFindings(
  db: Database.Database,
  repoId?: string,
): UnifiedFinding[] {
  const filter = repoId === undefined ? "" : "WHERE f.repo_id = ?";
  const parameters = repoId === undefined ? [] : [repoId];
  const v1Rows = db.prepare(`
    SELECT f.repo_id, f.fingerprint, f.rule_id, f.surface, f.severity,
           f.confidence, f.rationale, f.current_state, f.first_seen_at,
           f.last_seen_at, f.occurrence_count,
           (SELECT r.outcome FROM knowledge_hygiene_resolutions r
            WHERE r.repo_id = f.repo_id AND r.fingerprint = f.fingerprint
            ORDER BY r.resolved_at DESC, r.resolution_id DESC LIMIT 1) AS outcome
    FROM knowledge_hygiene_findings f ${filter}
  `).all(...parameters) as Array<{
    repo_id: string;
    fingerprint: string;
    rule_id: string;
    surface: string;
    severity: "error" | "warning" | "info";
    confidence: "high" | "medium" | "low" | "unknown";
    rationale: string;
    current_state: "active" | "resolved" | "closed_absent";
    first_seen_at: number;
    last_seen_at: number;
    occurrence_count: number;
    outcome: string | null;
  }>;
  const unified = new Map<string, UnifiedFinding>();
  for (const row of v1Rows) {
    const evidence = db.prepare(`
      SELECT run_id FROM knowledge_hygiene_occurrences
      WHERE repo_id = ? AND fingerprint = ? AND state = 'active' AND confidence = 'high'
      ORDER BY observed_at, run_id
    `).all(row.repo_id, row.fingerprint) as Array<{ run_id: string }>;
    unified.set(`${row.repo_id}\0${row.fingerprint}`, {
      repoId: row.repo_id,
      fingerprint: row.fingerprint,
      ruleId: row.rule_id,
      surface: row.surface,
      severity: row.severity,
      confidence: row.confidence,
      rationale: row.rationale,
      state: v1State(row.current_state, row.outcome),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      occurrenceCount: row.occurrence_count,
      highConfidenceOccurrences: evidence.length,
      evidenceRunIds: evidence.map((item) => item.run_id),
      v2: false,
    });
  }

  const v2Rows = db.prepare(`
    SELECT f.repo_id, f.fingerprint, f.finding_json, f.first_seen_at,
           f.last_seen_at, f.occurrence_count, s.current_state
    FROM knowledge_hygiene_findings_v2 f
    JOIN knowledge_hygiene_finding_state_v2 s
      ON s.repo_id = f.repo_id AND s.fingerprint = f.fingerprint
    ${repoId === undefined ? "" : "WHERE f.repo_id = ?"}
  `).all(...parameters) as Array<{
    repo_id: string;
    fingerprint: string;
    finding_json: string;
    first_seen_at: number;
    last_seen_at: number;
    occurrence_count: number;
    current_state: FindingLifecycleStateV2Core;
  }>;
  for (const row of v2Rows) {
    const finding = parseObject(row.finding_json, "V2 finding_json");
    const parsed = z.object({
      rule_id: z.string().min(1),
      surface: z.string().min(1),
      severity,
      confidence: z.enum(["high", "medium", "low", "unknown"]),
      rationale: z.string().min(1),
    }).passthrough().parse(finding);
    const evidence = db.prepare(`
      SELECT run_id FROM knowledge_hygiene_occurrences_v2
      WHERE repo_id = ? AND fingerprint = ? ORDER BY observed_at, run_id
    `).all(row.repo_id, row.fingerprint) as Array<{ run_id: string }>;
    const key = `${row.repo_id}\0${row.fingerprint}`;
    const previous = unified.get(key);
    unified.set(key, {
      repoId: row.repo_id,
      fingerprint: row.fingerprint,
      ruleId: parsed.rule_id,
      surface: parsed.surface,
      severity: parsed.severity,
      confidence: parsed.confidence,
      rationale: parsed.rationale,
      state: row.current_state,
      firstSeenAt: Math.min(previous?.firstSeenAt ?? row.first_seen_at, row.first_seen_at),
      lastSeenAt: Math.max(previous?.lastSeenAt ?? row.last_seen_at, row.last_seen_at),
      occurrenceCount: (previous?.occurrenceCount ?? 0) + row.occurrence_count,
      highConfidenceOccurrences:
        (previous?.highConfidenceOccurrences ?? 0)
        + (parsed.confidence === "high" ? evidence.length : 0),
      evidenceRunIds: [
        ...(previous?.evidenceRunIds ?? []),
        ...(parsed.confidence === "high" ? evidence.map((item) => item.run_id) : []),
      ],
      v2: true,
    });
  }
  return [...unified.values()];
}

const openStates: ReadonlySet<FindingLifecycleStateV2Core> = new Set([
  "open",
  "mechanically_applied",
]);
const DAY_MS = 86_400_000;

export function queryKnowledgeHygieneTrendV2(
  db: Database.Database,
  repoId: string,
  options: { as_of?: number } = {},
): KnowledgeHygieneTrendReportV2Core {
  const parsedRepoId = z.string().min(1).parse(repoId);
  const asOf = z.number().finite().parse(options.as_of ?? Date.now());
  const runs = listRuns(db, parsedRepoId);
  const findings = listUnifiedFindings(db, parsedRepoId);
  const open = findings.filter((finding) => openStates.has(finding.state));
  const recurring = open.filter((finding) => finding.occurrenceCount > 1);
  const oldest = open.reduce<number | null>((value, finding) =>
    value === null ? finding.firstSeenAt : Math.min(value, finding.firstSeenAt), null);
  const latest = runs.at(-1);
  const latestAssessment = latest === undefined
    ? null
    : latest.schema_version === "2"
      ? {
          schema_version: "2" as const,
          health_claim: latest.health_claim ?? "assessment_incomplete",
          coverage: z.array(z.record(z.unknown())).parse(
            JSON.parse(latest.coverage_json ?? "[]"),
          ),
        }
      : {
          schema_version: "1" as const,
          health_claim: "assessment_incomplete" as const,
          coverage: [{
            dimension: "semantic",
            state: "not_assessed",
            reason_codes: ["legacy_v1_report"],
          }],
        };
  const tracked = findings.length;
  const closed = tracked - open.length;
  return KnowledgeHygieneTrendReportV2Core.parse({
    schema_version: "2",
    repo_id: parsedRepoId,
    as_of: asOf,
    report_count: runs.length,
    sources: {
      v1_reports: runs.filter((run) => run.schema_version === "1").length,
      v2_reports: runs.filter((run) => run.schema_version === "2").length,
    },
    open: {
      total: open.length,
      error: open.filter((finding) => finding.severity === "error").length,
      warning: open.filter((finding) => finding.severity === "warning").length,
      info: open.filter((finding) => finding.severity === "info").length,
      oldest_age_days: oldest === null
        ? null
        : Math.max(0, Math.floor((asOf - oldest) / DAY_MS)),
    },
    recurrence: {
      total: recurring.length,
      warning: recurring.filter((finding) => finding.severity === "warning").length,
    },
    closure: {
      tracked,
      closed,
      rate: tracked === 0 ? 0 : closed / tracked,
    },
    delta: {
      new: latest === undefined
        ? 0
        : findings.filter((finding) => finding.firstSeenAt === latest.generated_at).length,
      resolved: latest?.resolved_count ?? 0,
    },
    suppressed: { latest: latest?.suppressed_count ?? 0 },
    latest_assessment: latestAssessment,
  });
}

function candidateKey(repoId: string, ruleId: string): string {
  return `khc_${createHash("sha256")
    .update(JSON.stringify(["knowledge_hygiene_recurrence", "2", repoId, ruleId]))
    .digest("hex")}`;
}

export function queryKnowledgeHygieneRecurrenceCandidatesV2(
  db: Database.Database,
  rawPolicy: KnowledgeHygieneRecurrencePolicyInputV1 = {},
): KnowledgeHygieneRecurrenceCandidateV2[] {
  const policy = KnowledgeHygieneRecurrencePolicyV1.parse(rawPolicy);
  const findings = listUnifiedFindings(db).filter((finding) =>
    openStates.has(finding.state)
    && finding.confidence === "high"
    && finding.highConfidenceOccurrences >= policy.min_occurrences
  );
  const grouped = new Map<string, UnifiedFinding[]>();
  for (const finding of findings) {
    const key = `${finding.repoId}\0${finding.ruleId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), finding]);
  }
  const repositoriesByRule = new Map<string, Set<string>>();
  for (const group of grouped.values()) {
    const first = group[0];
    if (first === undefined) continue;
    const repositories = repositoriesByRule.get(first.ruleId) ?? new Set<string>();
    repositories.add(first.repoId);
    repositoriesByRule.set(first.ruleId, repositories);
  }
  const severityRank = { error: 3, warning: 2, info: 1 } as const;
  return [...grouped.values()].flatMap((group) => {
    const first = group[0];
    if (first === undefined) return [];
    const repositoryCount = repositoriesByRule.get(first.ruleId)?.size ?? 0;
    if (repositoryCount < policy.min_repositories) return [];
    const strongest = [...group].sort((left, right) =>
      severityRank[right.severity] - severityRank[left.severity]
    )[0] ?? first;
    return [KnowledgeHygieneRecurrenceCandidateV2.parse({
      schema_version: "2",
      candidate_key: candidateKey(first.repoId, first.ruleId),
      repo_id: first.repoId,
      rule_id: first.ruleId,
      surface: first.surface,
      severity: strongest.severity,
      fingerprints: group.map((finding) => finding.fingerprint).sort(),
      occurrence_count: group.reduce(
        (total, finding) => total + finding.highConfidenceOccurrences,
        0,
      ),
      repository_count: repositoryCount,
      evidence_run_ids: [...new Set(group.flatMap((finding) => finding.evidenceRunIds))]
        .slice(-policy.max_evidence_runs),
      rationale: first.rationale,
      thresholds: {
        min_occurrences: policy.min_occurrences,
        min_repositories: policy.min_repositories,
      },
    })];
  }).sort((left, right) =>
    left.repo_id.localeCompare(right.repo_id)
    || left.rule_id.localeCompare(right.rule_id)
  );
}
