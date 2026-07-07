// Trace normalization — turn a loop CompletedTask into a RunTrace, the
// control plane's canonical record of one important run. Deterministic: the
// same completed task always yields the same trace_id.

import { createHash } from "node:crypto";
import type { CompletedTask } from "@osstack/loop";
import { RunTrace, type TraceCommand, type TraceIssue } from "./types.js";

export function traceFromCompletedTask(input: {
  repo_id: string;
  completedTask: CompletedTask;
  loop_id?: string;
}): RunTrace {
  const task = input.completedTask;
  const pass = task.outcome === "success";

  const commands: TraceCommand[] = [
    ...(task.execution_commands ?? []),
    ...(task.verify_commands ?? []),
  ].map((command) => ({
    command: command.command,
    exit_code: command.exit_code,
    duration_ms: command.duration_ms,
    ...(command.summary !== undefined ? { summary: command.summary } : {}),
  }));

  const issues: TraceIssue[] = (task.verify_issues ?? []).map((issue) => ({
    severity: issue.severity,
    message: issue.message,
    ...(issue.file !== undefined ? { file: issue.file } : {}),
    ...(issue.line !== undefined ? { line: issue.line } : {}),
    ...(issue.rule !== undefined ? { rule: issue.rule } : {}),
  }));

  const startedAt = task.started_at ?? task.completed_at ?? "1970-01-01T00:00:00.000Z";

  return RunTrace.parse({
    trace_id: traceId(input.repo_id, task),
    repo_id: input.repo_id,
    ...(task.run_id !== undefined ? { run_id: task.run_id } : {}),
    task_id: task.task_id,
    started_at: startedAt,
    ...(task.completed_at !== undefined ? { completed_at: task.completed_at } : {}),
    actor: { agent_id: task.agent_id },
    input_summary: task.capability !== undefined ? `${task.capability} (${task.task_id})` : task.task_id,
    ...(task.execution_summary !== undefined ? { output_summary: task.execution_summary } : {}),
    commands,
    verification: {
      pass,
      score: pass ? 1 : 0,
      issues,
    },
    changed_files: task.changed_files ?? [],
    cost: {
      tokens_in: task.tokens_in ?? 0,
      tokens_out: task.tokens_out ?? 0,
      ...(task.cost_usd !== undefined ? { usd: task.cost_usd } : {}),
    },
  });
}

function traceId(repoId: string, task: CompletedTask): string {
  const digest = createHash("sha1")
    .update(JSON.stringify({
      repo_id: repoId,
      task_id: task.task_id,
      run_id: task.run_id ?? null,
      outcome: task.outcome,
      started_at: task.started_at ?? null,
      issues: (task.verify_issues ?? []).map((issue) => `${issue.rule ?? ""}|${issue.message}`),
      changed_files: task.changed_files ?? [],
    }))
    .digest("hex")
    .slice(0, 12);
  return `trace_${repoId}_${task.task_id}_${digest}`;
}
