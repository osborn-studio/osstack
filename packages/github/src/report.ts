import type { BranchStewardReport } from "./types.js";

export function renderBranchStewardReport(report: BranchStewardReport): string {
  const lines = [
    `Branch Steward Report: ${report.repo}`,
    `Base: ${report.base}`,
    `Generated: ${report.generatedAt}`,
    "",
  ];

  if (report.candidates.length === 0) {
    lines.push("No eligible branch candidates found.");
    return lines.join("\n");
  }

  for (const candidate of report.candidates) {
    lines.push(`- ${candidate.head}: score=${candidate.score} action=${candidate.action}`);
    lines.push(
      `  ahead=${candidate.aheadBy} behind=${candidate.behindBy} files=${candidate.changedFiles}`,
    );
    for (const reason of candidate.reasons) {
      lines.push(`  - ${reason}`);
    }
  }

  if (report.prIntents.length > 0) {
    lines.push("");
    lines.push("Dry-run PR intents:");
    for (const intent of report.prIntents) {
      lines.push(`- ${intent.head} -> ${intent.base}: ${intent.title}`);
    }
  }

  return lines.join("\n");
}
