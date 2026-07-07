// Failure taxonomy — classify why a run failed, deterministically. No LLM.
// Classification reads the trace's issue messages, command strings, and
// command summaries; the first matching family wins (ordered to avoid
// overlap false-positives).

import type { FailureFamily, RunTrace } from "./types.js";

interface Rule {
  family: FailureFamily;
  pattern: RegExp;
}

// Order matters: earlier rules take precedence.
const RULES: Rule[] = [
  { family: "bad_tool", pattern: /enoent|command not found|not found on path|missing binary|no such file or directory|exit code 127/ },
  { family: "bad_retrieval", pattern: /no chunks|returned no chunks|no context|empty knowledge|retrieval .*(no|empty)/ },
  { family: "bad_agent_flow", pattern: /role[_ ]separation|cannot be its own|same agent .*(verif|evaluat)|builder .*evaluator/ },
  { family: "bad_policy", pattern: /policy denied|denied by policy|invalid policy|policy .*(denied|violation)/ },
  { family: "bad_handoff", pattern: /malformed handoff|missing output artifact|missing artifact|empty diff|handoff/ },
  { family: "bad_input", pattern: /missing required field|prompt missing|required field .*(missing|absent)|missing input/ },
  { family: "bad_reasoning", pattern: /assertion|assertionerror|expected .* received|expected .* got|expected .* but|mismatch/ },
  { family: "bad_verification", pattern: /no tests? configured|no verify command|verification not configured|nothing to verify/ },
];

export function classifyFailure(trace: RunTrace): FailureFamily {
  if (trace.verification.pass) return "unknown";
  const haystack = buildHaystack(trace);
  for (const rule of RULES) {
    if (rule.pattern.test(haystack)) return rule.family;
  }
  return "unknown";
}

export function explainFailure(trace: RunTrace): string {
  const family = classifyFailure(trace);
  const detail = trace.verification.issues[0]?.message
    ?? trace.commands.find((command) => command.exit_code !== 0)?.summary
    ?? trace.commands.find((command) => command.exit_code !== 0)?.command
    ?? "no failure detail recorded";
  return `${family}: ${singleLine(detail)}`;
}

function buildHaystack(trace: RunTrace): string {
  const parts: string[] = [];
  for (const issue of trace.verification.issues) {
    parts.push(issue.message, issue.rule ?? "");
  }
  for (const command of trace.commands) {
    parts.push(command.command, command.summary ?? "");
  }
  return parts.join(" \n ").toLowerCase();
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}
