import type {
  KnowledgeHygieneReportV1,
  KnowledgeHygieneReviewArtifactV1,
} from "./types.js";

export type KnowledgeHygieneReviewErrorCodeV1 =
  | "report_missing_diff"
  | "diff_mismatch"
  | "unknown_fingerprint";

export class KnowledgeHygieneReviewError extends Error {
  readonly code: KnowledgeHygieneReviewErrorCodeV1;

  constructor(code: KnowledgeHygieneReviewErrorCodeV1, message: string) {
    super(message);
    this.name = "KnowledgeHygieneReviewError";
    this.code = code;
  }
}

export function assertKnowledgeHygieneReviewArtifactMatchesReport(
  report: KnowledgeHygieneReportV1,
  artifact: KnowledgeHygieneReviewArtifactV1,
): void {
  const reportDiffId = report.input.diff_id;
  if (reportDiffId === undefined) {
    throw new KnowledgeHygieneReviewError(
      "report_missing_diff",
      "knowledge hygiene report has no diff_id",
    );
  }
  if (artifact.diff_id !== reportDiffId) {
    throw new KnowledgeHygieneReviewError(
      "diff_mismatch",
      `review artifact diff_id ${artifact.diff_id} does not match report ${reportDiffId}`,
    );
  }
  const findings = new Set(report.findings.map((finding) => finding.fingerprint));
  const unknown = artifact.resolutions.find(
    (resolution) => !findings.has(resolution.fingerprint),
  );
  if (unknown) {
    throw new KnowledgeHygieneReviewError(
      "unknown_fingerprint",
      `review artifact references unknown finding ${unknown.fingerprint}`,
    );
  }
}

export function applyKnowledgeHygieneReviewArtifact(
  report: KnowledgeHygieneReportV1,
  artifact: KnowledgeHygieneReviewArtifactV1,
): KnowledgeHygieneReportV1 {
  assertKnowledgeHygieneReviewArtifactMatchesReport(report, artifact);
  const resolutions = new Map(
    artifact.resolutions.map((resolution) => [resolution.fingerprint, resolution]),
  );
  const findings = report.findings.filter(
    (finding) => !resolutions.has(finding.fingerprint),
  );
  const newlyResolved = report.findings.flatMap((finding) => {
    const resolution = resolutions.get(finding.fingerprint);
    return resolution === undefined ? [] : [{ finding, resolution }];
  });
  const resolvedFindings = [
    ...(report.resolved_findings ?? []),
    ...newlyResolved,
  ];

  return {
    ...report,
    summary: {
      error: findings.filter((finding) => finding.severity === "error").length,
      warning: findings.filter((finding) => finding.severity === "warning").length,
      info: findings.filter((finding) => finding.severity === "info").length,
      suppressed: report.summary.suppressed,
      resolved: resolvedFindings.length,
    },
    findings,
    resolved_findings: resolvedFindings,
  };
}
