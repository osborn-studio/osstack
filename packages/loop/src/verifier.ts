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
  artifactVerification?: ArtifactVerificationOptions;
  sessionId?: string;
  timeoutMs?: number;
  outputLimit?: number;
}

export interface ArtifactVerificationOptions {
  requireGitDiff?: boolean;
  targetPaths?: string[];
  forbiddenPaths?: string[];
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
  const artifactIssues = await verifyArtifacts(options);

  const executionIssues = run.command_results
    .filter((result) => result.exitCode !== 0)
    .map((result) => commandIssue("execute.command_failed", result));
  const verificationIssues = commandResults
    .filter((result) => result.exitCode !== 0)
    .map((result) => commandIssue("verify.command_failed", result));
  const adapterIssues = adapterResults.flatMap((result) => result.issues);
  const issues = [...executionIssues, ...verificationIssues, ...adapterIssues, ...artifactIssues];
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
    ...(commandResults.length > 0 ? { verify_commands: commandResults.map(commandAudit) } : {}),
  };
}

function commandAudit(result: CommandResult): NonNullable<Verdict["verify_commands"]>[number] {
  const summary = singleLine(result.stderr.trim() || result.stdout.trim());
  return {
    command: result.command,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    ...(summary !== "" ? { summary } : {}),
  };
}

async function verifyArtifacts(options: LocalVerifierOptions): Promise<Issue[]> {
  const artifactOptions = normalizeArtifactOptions(options);
  if (artifactOptions === undefined) return [];

  const diffResult = await runShellCommand("git diff --name-only -- . && git ls-files --others --exclude-standard", {
    cwd: options.workspacePath,
    timeoutMs: options.timeoutMs ?? 120_000,
    outputLimit: options.outputLimit ?? 16_000,
  });
  if (diffResult.exitCode !== 0) {
    return [commandIssue("verify.artifact_git_diff_failed", diffResult)];
  }

  const changedFiles = [...new Set(diffResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0))];
  const issues: Issue[] = [];
  if (artifactOptions.requireGitDiff === true && changedFiles.length === 0) {
    issues.push({
      severity: "error",
      message: "artifact verification failed: git diff is empty",
      rule: "verify.artifact_empty_diff",
    });
  }

  if (artifactOptions.targetPaths.length > 0) {
    const hitTarget = changedFiles.some((file) =>
      artifactOptions.targetPaths.some((target) => pathMatches(file, target))
    );
    if (!hitTarget) {
      issues.push({
        severity: "error",
        message: `artifact verification failed: changed files did not hit target paths (${artifactOptions.targetPaths.join(", ")})`,
        rule: "verify.artifact_target_miss",
      });
    }
  }

  const forbiddenHit = changedFiles.find((file) =>
    artifactOptions.forbiddenPaths.some((target) => pathMatches(file, target))
  );
  if (forbiddenHit !== undefined) {
    issues.push({
      severity: "error",
      file: forbiddenHit,
      message: `artifact verification failed: changed forbidden path ${forbiddenHit}`,
      rule: "verify.artifact_forbidden_path",
    });
  }

  return issues;
}

function normalizeArtifactOptions(options: LocalVerifierOptions): Required<ArtifactVerificationOptions> | undefined {
  const explicit = options.artifactVerification;
  const context = options.task?.context ?? {};
  const requireGitDiff = explicit?.requireGitDiff ?? Boolean(context["require_git_diff"]);
  const targetPaths = [
    ...(requireGitDiff ? stringArray(context["target_paths"]) : []),
    ...(requireGitDiff ? stringArray(context["targetPaths"]) : []),
    ...(requireGitDiff ? stringArray(context["files"]) : []),
    ...(requireGitDiff ? stringArray(context["file"]) : []),
    ...(explicit?.targetPaths ?? []),
  ];
  const forbiddenPaths = [
    "node_modules",
    ".pnpm-store",
    "dist",
    "build",
    ".turbo",
    ".cache",
    "coverage",
    ...(explicit?.forbiddenPaths ?? []),
  ];
  if (!requireGitDiff && targetPaths.length === 0 && explicit === undefined) return undefined;
  return {
    requireGitDiff,
    targetPaths: [...new Set(targetPaths.map(normalizePathPattern).filter((path) => path.length > 0))],
    forbiddenPaths: [...new Set(forbiddenPaths.map(normalizePathPattern).filter((path) => path.length > 0))],
  };
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function normalizePathPattern(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function pathMatches(file: string, pattern: string): boolean {
  const normalizedFile = normalizePathPattern(file);
  const normalizedPattern = normalizePathPattern(pattern);
  return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`);
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
