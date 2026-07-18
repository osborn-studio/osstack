import {
  openDb,
  recordKnowledgeHygieneRun,
  type RecordKnowledgeHygieneRunInputV1,
} from "@osstack/core";
import type { KnowledgeHygieneReportV1 } from "@osstack/governance";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface NeatRecordingResultV1 {
  run_id: string;
  inserted: boolean;
  db_path: string;
}

function epoch(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${label}: ${value}`);
  return parsed;
}

function finding(
  value: KnowledgeHygieneReportV1["findings"][number],
): RecordKnowledgeHygieneRunInputV1["findings"][number] {
  return {
    fingerprint: value.fingerprint,
    rule_id: value.rule_id,
    surface: value.surface,
    severity: value.severity,
    location_path: value.location.path,
    rationale: value.rationale,
  };
}

function recordInput(
  report: KnowledgeHygieneReportV1,
): RecordKnowledgeHygieneRunInputV1 {
  return {
    report_sha256: createHash("sha256")
      .update(JSON.stringify(report))
      .digest("hex"),
    schema_version: report.schema_version,
    repo_id: report.repo.repo_id ?? report.repo.root,
    repo_root: report.repo.root,
    mode: report.input.mode,
    ...(report.input.diff_id === undefined ? {} : { diff_id: report.input.diff_id }),
    ...(report.input.config_sha256 === undefined
      ? {}
      : { config_sha256: report.input.config_sha256 }),
    generated_at: epoch(report.generated_at, "report generated_at"),
    complete: report.completeness.complete,
    skipped_files: report.completeness.skipped_files,
    summary: {
      error: report.summary.error,
      warning: report.summary.warning,
      info: report.summary.info,
      suppressed: report.summary.suppressed,
      resolved: report.summary.resolved ?? report.resolved_findings?.length ?? 0,
    },
    findings: report.findings.map(finding),
    resolved_findings: (report.resolved_findings ?? []).map((item) => ({
      finding: finding(item.finding),
      resolution: {
        diff_id: item.resolution.diff_id,
        fingerprint: item.resolution.fingerprint,
        outcome: item.resolution.outcome,
        actor_kind: item.resolution.actor.kind,
        actor_id: item.resolution.actor.id,
        reason: item.resolution.reason,
        evidence_refs: item.resolution.evidence_refs,
        resolved_at: epoch(item.resolution.resolved_at, "resolution resolved_at"),
      },
    })),
  };
}

export async function recordNeatReport(
  report: KnowledgeHygieneReportV1,
  dbPath: string,
  recordedAt = Date.now(),
): Promise<NeatRecordingResultV1> {
  await mkdir(dirname(dbPath), { recursive: true });
  const db = openDb({ path: dbPath });
  try {
    return {
      ...recordKnowledgeHygieneRun(db, recordInput(report), {
        recorded_at: recordedAt,
      }),
      db_path: dbPath,
    };
  } finally {
    db.close();
  }
}
