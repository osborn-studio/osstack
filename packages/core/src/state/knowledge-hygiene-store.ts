import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const fingerprint = z.string().regex(/^khf_[a-f0-9]{64}$/);
const diffId = z.string().regex(/^diff_[a-f0-9]{64}$/);
const severity = z.enum(["error", "warning", "info"]);

const storedFinding = z.object({
  fingerprint,
  rule_id: z.string().min(1),
  surface: z.string().min(1),
  severity,
  location_path: z.string().min(1),
  rationale: z.string().min(1),
}).strict();

const storedResolution = z.object({
  diff_id: diffId,
  fingerprint,
  outcome: z.enum([
    "fixed",
    "reviewed_no_change",
    "accepted_risk",
    "suppressed",
    "obsolete",
  ]),
  actor_kind: z.enum(["human", "agent"]),
  actor_id: z.string().min(1),
  reason: z.string().min(1),
  evidence_refs: z.array(z.record(z.unknown())),
  resolved_at: z.number().finite(),
}).strict();

export const RecordKnowledgeHygieneRunInputV1 = z.object({
  report_sha256: sha256,
  schema_version: z.literal("1"),
  repo_id: z.string().min(1),
  repo_root: z.string().min(1),
  mode: z.enum(["all", "worktree", "range", "base_to_worktree"]),
  diff_id: diffId.optional(),
  config_sha256: sha256.optional(),
  generated_at: z.number().finite(),
  complete: z.boolean(),
  skipped_files: z.number().int().nonnegative(),
  summary: z.object({
    error: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
    suppressed: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
  }).strict(),
  findings: z.array(storedFinding),
  resolved_findings: z.array(z.object({
    finding: storedFinding,
    resolution: storedResolution,
  }).strict()),
}).strict();
export type RecordKnowledgeHygieneRunInputV1 = z.infer<
  typeof RecordKnowledgeHygieneRunInputV1
>;

export interface RecordKnowledgeHygieneRunOptionsV1 {
  recorded_at?: number;
}

export interface RecordKnowledgeHygieneRunResultV1 {
  run_id: string;
  inserted: boolean;
}

export interface KnowledgeHygieneRunRowV1 {
  run_id: string;
  report_sha256: string;
  schema_version: string;
  repo_id: string;
  repo_root: string;
  mode: RecordKnowledgeHygieneRunInputV1["mode"];
  diff_id: string | null;
  config_sha256: string | null;
  generated_at: number;
  recorded_at: number;
  complete: boolean;
  skipped_files: number;
  error_count: number;
  warning_count: number;
  info_count: number;
  suppressed_count: number;
  resolved_count: number;
}

export interface KnowledgeHygieneFindingRowV1 {
  repo_id: string;
  fingerprint: string;
  rule_id: string;
  surface: string;
  severity: "error" | "warning" | "info";
  location_path: string;
  rationale: string;
  first_seen_at: number;
  last_seen_at: number;
  occurrence_count: number;
  current_state: "active" | "resolved" | "closed_absent";
  closed_at: number | null;
  last_run_id: string;
}

export interface KnowledgeHygieneOccurrenceRowV1 {
  run_id: string;
  repo_id: string;
  fingerprint: string;
  state: "active" | "resolved" | "closed_absent";
  severity: "error" | "warning" | "info";
  observed_at: number;
  resolution_outcome: string | null;
}

export const KnowledgeHygieneTrendReportV1 = z.object({
  schema_version: z.literal("1"),
  repo_id: z.string().min(1),
  as_of: z.number().finite(),
  report_count: z.number().int().nonnegative(),
  open: z.object({
    total: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
    oldest_age_days: z.number().int().nonnegative().nullable(),
  }).strict(),
  recurrence: z.object({
    total: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
  }).strict(),
  closure: z.object({
    tracked: z.number().int().nonnegative(),
    closed: z.number().int().nonnegative(),
    rate: z.number().min(0).max(1),
  }).strict(),
  delta: z.object({
    new: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
  }).strict(),
  suppressed: z.object({
    latest: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export type KnowledgeHygieneTrendReportV1 = z.infer<
  typeof KnowledgeHygieneTrendReportV1
>;

export interface QueryKnowledgeHygieneTrendOptionsV1 {
  as_of?: number;
}

interface RawRunRow extends Omit<KnowledgeHygieneRunRowV1, "complete"> {
  complete: number;
}

function runId(reportSha256: string): string {
  return `khr_${reportSha256}`;
}

function resolutionId(diff: string, findingFingerprint: string): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([diff, findingFingerprint]))
    .digest("hex");
  return `khrs_${hash}`;
}

const insertRunSql = `
  INSERT INTO knowledge_hygiene_runs (
    run_id, report_sha256, schema_version, repo_id, repo_root, mode,
    diff_id, config_sha256, generated_at, recorded_at, complete, skipped_files,
    error_count, warning_count, info_count, suppressed_count, resolved_count
  ) VALUES (
    @run_id, @report_sha256, @schema_version, @repo_id, @repo_root, @mode,
    @diff_id, @config_sha256, @generated_at, @recorded_at, @complete, @skipped_files,
    @error_count, @warning_count, @info_count, @suppressed_count, @resolved_count
  )
`;

const upsertFindingSql = `
  INSERT INTO knowledge_hygiene_findings (
    repo_id, fingerprint, rule_id, surface, severity, location_path, rationale,
    first_seen_at, last_seen_at, occurrence_count, current_state, closed_at, last_run_id
  ) VALUES (
    @repo_id, @fingerprint, @rule_id, @surface, @severity, @location_path, @rationale,
    @first_seen_at, @last_seen_at, 1, @current_state, @closed_at, @last_run_id
  )
  ON CONFLICT(repo_id, fingerprint) DO UPDATE SET
    rule_id = excluded.rule_id,
    surface = excluded.surface,
    severity = excluded.severity,
    location_path = excluded.location_path,
    rationale = excluded.rationale,
    first_seen_at = MIN(knowledge_hygiene_findings.first_seen_at, excluded.first_seen_at),
    last_seen_at = MAX(knowledge_hygiene_findings.last_seen_at, excluded.last_seen_at),
    occurrence_count = knowledge_hygiene_findings.occurrence_count + 1,
    current_state = excluded.current_state,
    closed_at = excluded.closed_at,
    last_run_id = excluded.last_run_id
`;

const insertOccurrenceSql = `
  INSERT OR IGNORE INTO knowledge_hygiene_occurrences (
    run_id, repo_id, fingerprint, state, severity, observed_at, resolution_outcome
  ) VALUES (
    @run_id, @repo_id, @fingerprint, @state, @severity, @observed_at, @resolution_outcome
  )
`;

export function recordKnowledgeHygieneRun(
  db: Database.Database,
  rawInput: RecordKnowledgeHygieneRunInputV1,
  options: RecordKnowledgeHygieneRunOptionsV1 = {},
): RecordKnowledgeHygieneRunResultV1 {
  const input = RecordKnowledgeHygieneRunInputV1.parse(rawInput);
  const id = runId(input.report_sha256);
  const transaction = db.transaction(() => {
    const existing = db.prepare(
      "SELECT run_id FROM knowledge_hygiene_runs WHERE report_sha256 = ?",
    ).get(input.report_sha256) as { run_id: string } | undefined;
    if (existing) return { run_id: existing.run_id, inserted: false };

    db.prepare(insertRunSql).run({
      run_id: id,
      report_sha256: input.report_sha256,
      schema_version: input.schema_version,
      repo_id: input.repo_id,
      repo_root: input.repo_root,
      mode: input.mode,
      diff_id: input.diff_id ?? null,
      config_sha256: input.config_sha256 ?? null,
      generated_at: input.generated_at,
      recorded_at: options.recorded_at ?? Date.now(),
      complete: input.complete ? 1 : 0,
      skipped_files: input.skipped_files,
      error_count: input.summary.error,
      warning_count: input.summary.warning,
      info_count: input.summary.info,
      suppressed_count: input.summary.suppressed,
      resolved_count: input.summary.resolved,
    });

    const upsertFinding = db.prepare(upsertFindingSql);
    const insertOccurrence = db.prepare(insertOccurrenceSql);
    const currentFingerprints = new Set<string>();
    for (const finding of input.findings) {
      currentFingerprints.add(finding.fingerprint);
      upsertFinding.run({
        ...finding,
        repo_id: input.repo_id,
        first_seen_at: input.generated_at,
        last_seen_at: input.generated_at,
        current_state: "active",
        closed_at: null,
        last_run_id: id,
      });
      insertOccurrence.run({
        run_id: id,
        repo_id: input.repo_id,
        fingerprint: finding.fingerprint,
        state: "active",
        severity: finding.severity,
        observed_at: input.generated_at,
        resolution_outcome: null,
      });
    }

    const insertResolution = db.prepare(`
      INSERT OR IGNORE INTO knowledge_hygiene_resolutions (
        resolution_id, run_id, repo_id, diff_id, fingerprint, outcome,
        actor_kind, actor_id, reason, evidence_refs_json, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of input.resolved_findings) {
      const { finding, resolution } = item;
      currentFingerprints.add(finding.fingerprint);
      upsertFinding.run({
        ...finding,
        repo_id: input.repo_id,
        first_seen_at: input.generated_at,
        last_seen_at: input.generated_at,
        current_state: "resolved",
        closed_at: resolution.resolved_at,
        last_run_id: id,
      });
      insertOccurrence.run({
        run_id: id,
        repo_id: input.repo_id,
        fingerprint: finding.fingerprint,
        state: "resolved",
        severity: finding.severity,
        observed_at: input.generated_at,
        resolution_outcome: resolution.outcome,
      });
      insertResolution.run(
        resolutionId(resolution.diff_id, resolution.fingerprint),
        id,
        input.repo_id,
        resolution.diff_id,
        resolution.fingerprint,
        resolution.outcome,
        resolution.actor_kind,
        resolution.actor_id,
        resolution.reason,
        JSON.stringify(resolution.evidence_refs),
        resolution.resolved_at,
      );
    }

    if (input.complete) {
      const active = db.prepare(`
        SELECT * FROM knowledge_hygiene_findings
        WHERE repo_id = ? AND current_state = 'active'
      `).all(input.repo_id) as KnowledgeHygieneFindingRowV1[];
      const closeFinding = db.prepare(`
        UPDATE knowledge_hygiene_findings
        SET current_state = 'closed_absent', closed_at = ?, last_run_id = ?
        WHERE repo_id = ? AND fingerprint = ? AND current_state = 'active'
      `);
      for (const finding of active) {
        if (currentFingerprints.has(finding.fingerprint)) continue;
        closeFinding.run(input.generated_at, id, input.repo_id, finding.fingerprint);
        insertOccurrence.run({
          run_id: id,
          repo_id: input.repo_id,
          fingerprint: finding.fingerprint,
          state: "closed_absent",
          severity: finding.severity,
          observed_at: input.generated_at,
          resolution_outcome: null,
        });
      }
    }
    return { run_id: id, inserted: true };
  });
  return transaction.immediate();
}

export function getKnowledgeHygieneRunByReportSha(
  db: Database.Database,
  reportSha256: string,
): KnowledgeHygieneRunRowV1 | undefined {
  const row = db.prepare(
    "SELECT * FROM knowledge_hygiene_runs WHERE report_sha256 = ?",
  ).get(reportSha256) as RawRunRow | undefined;
  return row === undefined ? undefined : { ...row, complete: row.complete === 1 };
}

export function getKnowledgeHygieneFinding(
  db: Database.Database,
  repoId: string,
  findingFingerprint: string,
): KnowledgeHygieneFindingRowV1 | undefined {
  return db.prepare(`
    SELECT * FROM knowledge_hygiene_findings
    WHERE repo_id = ? AND fingerprint = ?
  `).get(repoId, findingFingerprint) as KnowledgeHygieneFindingRowV1 | undefined;
}

export function listKnowledgeHygieneOccurrences(
  db: Database.Database,
  repoId: string,
): KnowledgeHygieneOccurrenceRowV1[] {
  return db.prepare(`
    SELECT * FROM knowledge_hygiene_occurrences
    WHERE repo_id = ?
    ORDER BY observed_at, run_id, fingerprint, state
  `).all(repoId) as KnowledgeHygieneOccurrenceRowV1[];
}

interface TrendRunRow {
  run_id: string;
  suppressed_count: number;
}

interface TrendFindingState {
  state: KnowledgeHygieneOccurrenceRowV1["state"];
  severity: KnowledgeHygieneOccurrenceRowV1["severity"];
  active_occurrences: number;
  open_since: number | null;
}

const DAY_MS = 86_400_000;

/**
 * Rebuild the current trend from append-only occurrence events. The aggregate
 * findings table is deliberately not consulted: this keeps historical reports
 * reproducible and makes event replay the testable source of truth.
 */
export function queryKnowledgeHygieneTrend(
  db: Database.Database,
  repoId: string,
  options: QueryKnowledgeHygieneTrendOptionsV1 = {},
): KnowledgeHygieneTrendReportV1 {
  const parsedRepoId = z.string().min(1).parse(repoId);
  const asOf = z.number().finite().parse(options.as_of ?? Date.now());
  const runs = db.prepare(`
    SELECT run_id, suppressed_count
    FROM knowledge_hygiene_runs
    WHERE repo_id = ?
    ORDER BY generated_at, recorded_at, run_id
  `).all(parsedRepoId) as TrendRunRow[];
  const events = listKnowledgeHygieneOccurrences(db, parsedRepoId);
  const eventsByRun = new Map<string, KnowledgeHygieneOccurrenceRowV1[]>();
  for (const event of events) {
    const group = eventsByRun.get(event.run_id) ?? [];
    group.push(event);
    eventsByRun.set(event.run_id, group);
  }

  const states = new Map<string, TrendFindingState>();
  const latestRun = runs.at(-1);
  let newCount = 0;
  let resolvedCount = 0;
  for (const run of runs) {
    for (const event of eventsByRun.get(run.run_id) ?? []) {
      const previous = states.get(event.fingerprint);
      if (run.run_id === latestRun?.run_id) {
        if (event.state === "active" && previous === undefined) newCount += 1;
        if (event.state !== "active") resolvedCount += 1;
      }
      if (event.state === "active") {
        states.set(event.fingerprint, {
          state: event.state,
          severity: event.severity,
          active_occurrences: (previous?.active_occurrences ?? 0) + 1,
          open_since: previous?.state === "active"
            ? previous.open_since
            : event.observed_at,
        });
      } else {
        states.set(event.fingerprint, {
          state: event.state,
          severity: event.severity,
          active_occurrences: previous?.active_occurrences ?? 0,
          open_since: null,
        });
      }
    }
  }

  const active = [...states.values()].filter((state) => state.state === "active");
  const recurring = active.filter((state) => state.active_occurrences > 1);
  const oldestOpen = active.reduce<number | null>((oldest, state) => {
    if (state.open_since === null) return oldest;
    return oldest === null ? state.open_since : Math.min(oldest, state.open_since);
  }, null);
  const closed = [...states.values()].filter((state) => state.state !== "active").length;
  const tracked = states.size;

  return KnowledgeHygieneTrendReportV1.parse({
    schema_version: "1",
    repo_id: parsedRepoId,
    as_of: asOf,
    report_count: runs.length,
    open: {
      total: active.length,
      error: active.filter((state) => state.severity === "error").length,
      warning: active.filter((state) => state.severity === "warning").length,
      info: active.filter((state) => state.severity === "info").length,
      oldest_age_days: oldestOpen === null
        ? null
        : Math.max(0, Math.floor((asOf - oldestOpen) / DAY_MS)),
    },
    recurrence: {
      total: recurring.length,
      warning: recurring.filter((state) => state.severity === "warning").length,
    },
    closure: {
      tracked,
      closed,
      rate: tracked === 0 ? 0 : closed / tracked,
    },
    delta: { new: newCount, resolved: resolvedCount },
    suppressed: { latest: latestRun?.suppressed_count ?? 0 },
  });
}
