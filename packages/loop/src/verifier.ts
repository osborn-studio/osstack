import type { AgentAdapter, AgentTask } from "@osstack/agents";
import type { HermesEvent } from "@osstack/hermes-adapter";
import type { AgentRun, CommandResult } from "./executor.js";
import { runShellCommand } from "./executor.js";
import type { Issue, Task, Verdict } from "./types.js";

export interface LocalVerifierOptions {
  workspacePath: string;
  commands?: string[];
  verifierAgentIds?: string[];
  adapters?: readonly AgentAdapter[];
  task?: Task;
  sessionId?: string;
  timeoutMs?: number;
  outputLimit?: number;
}

export async function verifyRun(run: AgentRun, options: LocalVerifierOptions): Promise<Verdict> {
  const commandResults: CommandResult[] = [];
  for (const command of options.commands ?? []) {
    if (command.trim() === "") continue;
    commandResults.push(await runShellCommand(command, {
      cwd: options.workspacePath,
      timeoutMs: options.timeoutMs ?? 120_000,
      outputLimit: options.outputLimit ?? 16_000,
    }));
  }
  const adapterResults = await runVerifierAdapters(run, options);

  const executionIssues = run.command_results
    .filter((result) => result.exitCode !== 0)
    .map((result) => commandIssue("execute.command_failed", result));
  const verificationIssues = commandResults
    .filter((result) => result.exitCode !== 0)
    .map((result) => commandIssue("verify.command_failed", result));
  const adapterIssues = adapterResults.flatMap((result) => result.issues);
  const issues = [...executionIssues, ...verificationIssues, ...adapterIssues];
  const pass = issues.length === 0;
  const reviewerIds = adapterResults.length > 0
    ? adapterResults.map((result) => result.agentId).join(",")
    : "local-verifier";

  return {
    pass,
    score: pass ? 1 : 0,
    issues,
    reviewer_agent_id: reviewerIds,
    summary: summarize(commandResults, adapterResults, issues),
  };
}

interface VerifierAdapterResult {
  agentId: string;
  eventCount: number;
  issues: Issue[];
  summary?: string;
}

async function runVerifierAdapters(
  run: AgentRun,
  options: LocalVerifierOptions,
): Promise<VerifierAdapterResult[]> {
  const ids = options.verifierAgentIds ?? [];
  const results: VerifierAdapterResult[] = [];
  for (const agentId of ids) {
    if (agentId.trim() === "") continue;
    const adapter = options.adapters?.find((candidate) => candidate.id === agentId);
    if (adapter === undefined) {
      results.push({
        agentId,
        eventCount: 0,
        issues: [adapterIssue(agentId, "verify.adapter_missing", `verifier adapter not registered: ${agentId}`)],
      });
      continue;
    }
    results.push(await invokeVerifierAdapter(run, options, adapter));
  }
  return results;
}

async function invokeVerifierAdapter(
  run: AgentRun,
  options: LocalVerifierOptions,
  adapter: AgentAdapter,
): Promise<VerifierAdapterResult> {
  const availability = await adapter.isAvailable();
  if (!availability.available) {
    return {
      agentId: adapter.id,
      eventCount: 0,
      issues: [adapterIssue(adapter.id, "verify.adapter_unavailable", availability.reason ?? "verifier unavailable")],
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
  let eventCount = 0;
  let summary: string | undefined;
  let status: "completed" | "failed" | "cancelled" | "expired" | undefined;
  let terminalError: string | undefined;

  try {
    const agentTask = verifierAgentTask(run, options, adapter);
    for await (const event of adapter.invoke(agentTask, controller.signal)) {
      eventCount += 1;
      if (event.type === "error" && event.terminal) {
        terminalError = errorPayload(event.payload).message;
      }
      if (event.type === "done") {
        const payload = donePayload(event.payload);
        status = payload.status;
        summary = payload.result_summary;
      }
    }
  } catch (error) {
    terminalError = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeout);
  }

  if (status === "completed" && terminalError === undefined) {
    return {
      agentId: adapter.id,
      eventCount,
      issues: [],
      ...(summary !== undefined ? { summary } : {}),
    };
  }

  const message = terminalError
    ?? summary
    ?? (controller.signal.aborted ? `verifier timed out after ${options.timeoutMs ?? 120_000}ms` : "verifier did not complete");
  return {
    agentId: adapter.id,
    eventCount,
    issues: [adapterIssue(adapter.id, "verify.adapter_failed", message)],
    ...(summary !== undefined ? { summary } : {}),
  };
}

function verifierAgentTask(run: AgentRun, options: LocalVerifierOptions, adapter: AgentAdapter): AgentTask {
  const task = options.task;
  return {
    run_id: `${run.run_id}_verify_${sanitizeId(adapter.id)}`,
    task_id: task?.task_id ?? run.task_id,
    session_id: options.sessionId ?? run.plan_id,
    capability_id: selectVerifierCapabilityId(adapter),
    prompt: [
      "Review or verify the completed loop task.",
      `Task: ${task?.prompt ?? run.task_id}`,
      `Executor: ${run.agent_id}`,
      `Execution outcome: ${run.outcome}`,
      ...(run.summary !== undefined ? [`Execution summary: ${run.summary}`] : []),
    ].join("\n"),
    context: {
      ...(task?.context ?? {}),
      repo_path: options.workspacePath,
      subject_run_id: run.run_id,
      subject_agent_id: run.agent_id,
      subject_outcome: run.outcome,
    },
  };
}

function selectVerifierCapabilityId(adapter: AgentAdapter): string {
  const capabilities = adapter.capabilities();
  const preferred = capabilities.find((capability) =>
    capability.kind === "review.code"
    || capability.kind === "verify.alignment"
    || capability.kind === "verify.acceptance"
    || capability.kind === "release.verify"
    || capability.kind === "code.review"
  );
  return preferred?.id ?? capabilities[0]?.id ?? `verify.${adapter.id}`;
}

function commandIssue(rule: string, result: CommandResult): Issue {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  return {
    severity: "error",
    message: `${result.command} failed (${result.exitCode}): ${singleLine(detail)}`,
    rule,
  };
}

function adapterIssue(agentId: string, rule: string, message: string): Issue {
  return {
    severity: "error",
    message: `${agentId} verifier failed: ${singleLine(message)}`,
    rule,
  };
}

function summarize(results: CommandResult[], adapters: VerifierAdapterResult[], issues: Issue[]): string {
  if (results.length === 0 && adapters.length === 0 && issues.length === 0) {
    return "No verifier commands or adapters configured; execution succeeded.";
  }
  if (issues.length === 0) {
    const parts = [
      `${results.length} verifier command${results.length === 1 ? "" : "s"}`,
      `${adapters.length} verifier adapter${adapters.length === 1 ? "" : "s"}`,
    ];
    return `${parts.join(" and ")} passed.`;
  }
  return `${issues.length} issue${issues.length === 1 ? "" : "s"} found by local verifier.`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 240);
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

function errorPayload(payload: HermesEvent["payload"]): { message: string } {
  return payload as { message: string };
}

function donePayload(payload: HermesEvent["payload"]): {
  status: "completed" | "failed" | "cancelled" | "expired";
  result_summary?: string;
} {
  return payload as {
    status: "completed" | "failed" | "cancelled" | "expired";
    result_summary?: string;
  };
}
