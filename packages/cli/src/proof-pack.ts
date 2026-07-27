import { PIIRedactor } from "@osstack/core";
import type { ReviewArtifact } from "@osstack/loop";

export interface VerifyResultEvidence {
  task_id: string;
  pass: boolean;
  score: number | "unknown";
  reviewer_agent_id: string;
  summary: string;
  event_seq: number;
  review_artifacts?: ReviewArtifact[];
}

export interface VerifyResultsEvidence {
  status: "pass" | "fail" | "unknown";
  results?: VerifyResultEvidence[];
  reason?: string;
}

export interface ProofArtifact {
  path: string;
  content: string;
}

export function createVerifierOutputArtifacts(
  verifyResults: VerifyResultsEvidence,
): ProofArtifact[] {
  if (verifyResults.results === undefined) return [];
  return verifyResults.results.flatMap((result) => {
    if (
      result.review_artifacts !== undefined
      && result.review_artifacts.length > 0
    ) {
      return result.review_artifacts.flatMap((artifact) => {
        const redacted = redactReviewArtifact(artifact);
        const basePath = [
          "reviewer-output/",
          safeFileSegment(result.task_id),
          "-",
          safeFileSegment(redacted.reviewer_agent_id),
        ].join("");
        return [
          {
            path: `${basePath}.md`,
            content: ensureTrailingNewline(redacted.markdown),
          },
          {
            path: `${basePath}.json`,
            content: `${JSON.stringify(redacted, null, 2)}\n`,
          },
        ];
      });
    }

    const agentId = result.reviewer_agent_id === ""
      ? "unknown-verifier"
      : result.reviewer_agent_id;
    const dir = verifierOutputDir(agentId);
    const path = `${dir}/${safeFileSegment(result.task_id)}-${safeFileSegment(agentId)}.txt`;
    const content = [
      `task_id: ${result.task_id}`,
      `reviewer_agent_id: ${agentId}`,
      `pass: ${result.pass ? "true" : "false"}`,
      `score: ${String(result.score)}`,
      `event_seq: ${result.event_seq}`,
      "",
      result.summary,
      "",
    ].join("\n");
    return [{ path, content: redactText(content) }];
  });
}

function redactReviewArtifact(artifact: ReviewArtifact): ReviewArtifact {
  const redacted = new PIIRedactor().redactDeep(artifact);
  if (redacted.stats.timed_out) {
    throw new Error(
      `review proof redaction timed out${redacted.stats.timed_out_on !== undefined
        ? ` on ${redacted.stats.timed_out_on}`
        : ""}`,
    );
  }
  return redacted.value;
}

function redactText(content: string): string {
  const redacted = new PIIRedactor().redact(content);
  if (redacted.stats.timed_out) {
    throw new Error(
      `proof redaction timed out${redacted.stats.timed_out_on !== undefined
        ? ` on ${redacted.stats.timed_out_on}`
        : ""}`,
    );
  }
  return redacted.text;
}

function verifierOutputDir(
  agentId: string,
): "checker-output" | "reviewer-output" {
  const normalized = agentId.toLowerCase();
  return normalized.includes("checker")
    || normalized.includes("verify")
    || normalized.includes("verifier")
    ? "checker-output"
    : "reviewer-output";
}

function safeFileSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
