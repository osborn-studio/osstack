import { createHash } from "node:crypto";
import { z } from "zod";
import {
  KnowledgeHygieneReportV2,
  KnowledgeHygieneResolutionEventV2,
  type FindingLifecycleStateV2,
  type KnowledgeHygieneFindingV2,
  type KnowledgeHygieneReportV2 as KnowledgeHygieneReport,
  type KnowledgeHygieneResolutionEventV2 as ResolutionEvent,
} from "./types-v2.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const KnowledgeHygieneReviewArtifactV2 = z
  .object({
    schema_version: z.literal("2"),
    report_sha256: sha256,
    repo_id: z.string().min(1),
    resolution_events: z.array(KnowledgeHygieneResolutionEventV2).min(1),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (
      new Set(artifact.resolution_events.map((event) => event.event_id)).size
      !== artifact.resolution_events.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolution_events"],
        message: "resolution event ids must be unique",
      });
    }
    if (artifact.resolution_events.some((event) => event.repo_id !== artifact.repo_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolution_events"],
        message: "resolution event repo_id must match the artifact",
      });
    }
  });
export type KnowledgeHygieneReviewArtifactV2 = z.infer<
  typeof KnowledgeHygieneReviewArtifactV2
>;

export class KnowledgeHygieneReviewV2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeHygieneReviewV2Error";
  }
}

export function knowledgeHygieneReportSha256V2(
  report: KnowledgeHygieneReport,
): string {
  return createHash("sha256")
    .update(JSON.stringify(KnowledgeHygieneReportV2.parse(report)))
    .digest("hex");
}

const terminalStates: ReadonlySet<FindingLifecycleStateV2> = new Set([
  "mechanically_resolved",
  "semantically_resolved",
  "reviewed_no_change",
  "accepted_risk",
  "suppressed",
  "obsolete",
  "closed_absent",
  "resolved_legacy",
]);

function healthClaim(
  findings: readonly KnowledgeHygieneFindingV2[],
  coverage: KnowledgeHygieneReport["coverage"],
): KnowledgeHygieneReport["health_claim"] {
  if (coverage.some((entry) =>
    entry.state === "failed"
    || entry.state === "truncated"
    || (entry.state === "not_assessed"
      && !entry.reason_codes.includes("not_requested"))
  )) {
    return "assessment_incomplete";
  }
  return findings.length === 0 ? "assessed_scope_clean" : "findings_present";
}

export function applyKnowledgeHygieneReviewArtifactV2(
  rawReport: KnowledgeHygieneReport,
  rawArtifact: KnowledgeHygieneReviewArtifactV2,
): KnowledgeHygieneReport {
  const report = KnowledgeHygieneReportV2.parse(rawReport);
  const artifact = KnowledgeHygieneReviewArtifactV2.parse(rawArtifact);
  if (knowledgeHygieneReportSha256V2(report) !== artifact.report_sha256) {
    throw new KnowledgeHygieneReviewV2Error(
      "V2 review artifact report hash does not match the report",
    );
  }
  const repoId = report.repo.repo_id ?? report.repo.root;
  if (repoId !== artifact.repo_id) {
    throw new KnowledgeHygieneReviewV2Error(
      "V2 review artifact repository does not match the report",
    );
  }

  const findings = new Map<string, KnowledgeHygieneFindingV2>();
  for (const finding of report.findings) findings.set(finding.fingerprint, finding);
  for (const item of report.resolved_findings ?? []) {
    findings.set(item.finding.fingerprint, item.finding);
  }
  const eventsByFinding = new Map<string, ResolutionEvent[]>();
  for (const item of report.resolved_findings ?? []) {
    eventsByFinding.set(item.finding.fingerprint, [...item.resolution_events]);
  }
  const stateByFinding = new Map<string, FindingLifecycleStateV2>();
  for (const [fingerprintValue] of findings) {
    const existing = eventsByFinding.get(fingerprintValue) ?? [];
    stateByFinding.set(
      fingerprintValue,
      existing.at(-1)?.to_state ?? "open",
    );
  }
  const seenEvents = new Map(
    [...eventsByFinding.values()].flat().map((event) => [event.event_id, event]),
  );
  for (const event of artifact.resolution_events) {
    if (!findings.has(event.fingerprint)) {
      throw new KnowledgeHygieneReviewV2Error(
        `V2 report has no finding ${event.fingerprint}`,
      );
    }
    const existingEvent = seenEvents.get(event.event_id);
    if (existingEvent !== undefined) {
      if (JSON.stringify(existingEvent) !== JSON.stringify(event)) {
        throw new KnowledgeHygieneReviewV2Error(
          `V2 resolution event id collision: ${event.event_id}`,
        );
      }
      continue;
    }
    const current = stateByFinding.get(event.fingerprint) ?? "open";
    if (event.from_state !== current) {
      throw new KnowledgeHygieneReviewV2Error(
        `stale V2 lifecycle event for ${event.fingerprint}: expected ${current}, received ${event.from_state}`,
      );
    }
    const previous = eventsByFinding.get(event.fingerprint)?.at(-1);
    if (
      previous !== undefined
      && Date.parse(event.occurred_at) < Date.parse(previous.occurred_at)
    ) {
      throw new KnowledgeHygieneReviewV2Error(
        `V2 lifecycle event time precedes current state: ${event.event_id}`,
      );
    }
    eventsByFinding.set(event.fingerprint, [
      ...(eventsByFinding.get(event.fingerprint) ?? []),
      event,
    ]);
    stateByFinding.set(event.fingerprint, event.to_state);
    seenEvents.set(event.event_id, event);
  }

  const active = [...findings.values()].filter((finding) =>
    !terminalStates.has(stateByFinding.get(finding.fingerprint) ?? "open")
  );
  const resolved = [...eventsByFinding.entries()].map(([fingerprintValue, events]) => ({
    finding: findings.get(fingerprintValue) as KnowledgeHygieneFindingV2,
    resolution_events: events,
  })).sort((left, right) =>
    left.finding.fingerprint.localeCompare(right.finding.fingerprint)
  );
  return KnowledgeHygieneReportV2.parse({
    ...report,
    findings: active,
    resolved_findings: resolved,
    summary: {
      error: active.filter((finding) => finding.severity === "error").length,
      warning: active.filter((finding) => finding.severity === "warning").length,
      info: active.filter((finding) => finding.severity === "info").length,
      suppressed: report.summary.suppressed,
      resolved: resolved.filter((item) =>
        terminalStates.has(item.resolution_events.at(-1)?.to_state ?? "open")
      ).length,
    },
    health_claim: healthClaim(active, report.coverage),
  });
}
