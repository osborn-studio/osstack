import {
  openDb,
  recordKnowledgeHygieneRun,
  recordKnowledgeHygieneRunV2,
  type RecordKnowledgeHygieneRunInputV1,
  type RecordKnowledgeHygieneRunInputV2,
} from "@osstack/core";
import type {
  KnowledgeHygieneReportV1,
  KnowledgeHygieneReportV2,
} from "@osstack/governance";
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
    confidence: value.confidence,
    location_path: value.location.path,
    rationale: value.rationale,
  };
}

function recordInputV1(
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

function recordInputV2(
  report: KnowledgeHygieneReportV2,
): RecordKnowledgeHygieneRunInputV2 {
  const findings = new Map<
    string,
    RecordKnowledgeHygieneRunInputV2["findings"][number]
  >();
  for (const findingValue of report.findings) {
    findings.set(findingValue.fingerprint, {
      fingerprint: findingValue.fingerprint,
      finding: { ...findingValue },
    });
  }
  const resolutionEvents: RecordKnowledgeHygieneRunInputV2["resolution_events"] = [];
  for (const item of report.resolved_findings ?? []) {
    findings.set(item.finding.fingerprint, {
      fingerprint: item.finding.fingerprint,
      finding: { ...item.finding },
    });
    resolutionEvents.push(...item.resolution_events.map((event) => ({
      ...event,
      actor: { ...event.actor },
      evidence_refs: event.evidence_refs.map((reference) => ({ ...reference })),
      ...(event.suppression === undefined
        ? {}
        : { suppression: { ...event.suppression } }),
    })));
  }
  return {
    report_sha256: createHash("sha256")
      .update(JSON.stringify(report))
      .digest("hex"),
    schema_version: "2",
    repo_id: report.repo.repo_id ?? report.repo.root,
    repo_root: report.repo.root,
    mode: report.input.mode,
    ...(report.input.diff_id === undefined ? {} : { diff_id: report.input.diff_id }),
    ...(report.input.config_sha256 === undefined
      ? {}
      : { config_sha256: report.input.config_sha256 }),
    generated_at: epoch(report.generated_at, "report generated_at"),
    inventory_complete: report.completeness.complete,
    coverage: report.coverage.map((coverage) => ({ ...coverage })),
    health_claim: report.health_claim,
    summary: {
      error: report.summary.error,
      warning: report.summary.warning,
      info: report.summary.info,
      suppressed: report.summary.suppressed,
      resolved: report.summary.resolved ?? report.resolved_findings?.length ?? 0,
    },
    findings: [...findings.values()],
    resolution_events: resolutionEvents,
  };
}

export async function recordNeatReport(
  report: KnowledgeHygieneReportV1 | KnowledgeHygieneReportV2,
  dbPath: string,
  recordedAt = Date.now(),
): Promise<NeatRecordingResultV1> {
  await mkdir(dirname(dbPath), { recursive: true });
  const db = openDb({ path: dbPath });
  try {
    const recorded = report.schema_version === "1"
      ? recordKnowledgeHygieneRun(db, recordInputV1(report), {
          recorded_at: recordedAt,
        })
      : recordKnowledgeHygieneRunV2(db, recordInputV2(report), {
          recorded_at: recordedAt,
        });
    return {
      ...recorded,
      db_path: dbPath,
    };
  } finally {
    db.close();
  }
}
