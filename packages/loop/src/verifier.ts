import type { AgentAdapter, AgentTask } from "@osstack/agents";
import type { HermesEvent } from "@osstack/hermes-adapter";
import {
  evaluationScore,
  implicitArtifactSpec,
  implicitCommandSpec,
  isAdapterEvaluationSpec,
  isCommandEvaluationSpec,
  type EvaluationResult,
  type EvaluationSpec,
} from "./evaluation-spec.js";
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

interface CommandSpecRun {
  spec: EvaluationSpec;
  implicit: boolean;
  result: CommandResult;
}

export async function verifyRun(run: AgentRun, options: LocalVerifierOptions): Promise<Verdict> {
  const explicitSpecs = options.task?.evaluation ?? [];

  // Legacy --verify commands become implicit command evaluation specs.
  const implicitCommandSpecs = (options.commands ?? [])
    .filter((command) => command.trim() !== "")
    .map(implicitCommandSpec);
  const explicitCommandSpecs = explicitSpecs.filter(isCommandEvaluationSpec);
  const commandRuns: CommandSpecRun[] = [];
  for (const spec of implicitCommandSpecs) {
    commandRuns.push({ spec, implicit: true, result: await runSpecCommand(spec, options) });
  }
  for (const spec of explicitCommandSpecs) {
    commandRuns.push({ spec, implicit: false, result: await runSpecCommand(spec, options) });
  }

  const adapterSpecs = explicitSpecs.filter(isAdapterEvaluationSpec);
  const adapterResults = await runVerifierAdapters(run, options, adapterSpecs);

  const artifactOptions = normalizeArtifactOptions(options);
  const explicitArtifactSpecs = explicitSpecs.filter(
    (spec) => spec.mode === "artifact" && !isCommandEvaluationSpec(spec),
  );
  const artifact = await verifyArtifacts(options, artifactOptions, explicitArtifactSpecs);

  const executionIssues = run.command_results
    .filter((result) => result.exitCode !== 0)
    .map((result) => commandIssue("execute.command_failed", result));
  const verificationIssues = commandRuns
    .filter(({ implicit, result }) => implicit && result.exitCode !== 0)
    .map(({ result }) => commandIssue("verify.command_failed", result));
  const explicitCommandIssues = commandRuns
    .filter(({ implicit, result }) => !implicit && result.exitCode !== 0)
    .map(({ spec, result }) => evaluationIssue(spec, singleLine(
      result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`,
    )));
  const adapterIssues = adapterResults.flatMap((result) => result.issues);
  const adapterHasIssues = adapterIssues.length > 0;
  const adapterConfigured = (options.verifierAgentIds ?? []).some((id) => id.trim() !== "");
  const unverifiedAdapterSpecIssues = adapterConfigured
    ? []
    : adapterSpecs.map((spec) => evaluationIssue(spec, "no verifier adapter configured for this evaluation"));

  const issues = [
    ...executionIssues,
    ...verificationIssues,
    ...explicitCommandIssues,
    ...adapterIssues,
    ...unverifiedAdapterSpecIssues,
    ...artifact.issues,
  ];

  const evaluations: EvaluationResult[] = [
    ...commandRuns.map(({ spec, implicit, result }) => commandEvaluationResult(spec, implicit, result)),
    ...adapterSpecs.map((spec) => adapterEvaluationResult(spec, adapterConfigured, adapterHasIssues, adapterResults)),
    ...artifact.evaluations,
  ];

  const pass = !issues.some((issue) => issue.severity === "error");
  const reviewerIds = adapterResults.length > 0
    ? adapterResults.map((result) => result.agentId).join(",")
    : "local-verifier";
  const commandResults = commandRuns.map(({ result }) => result);

  return {
    pass,
    score: evaluations.length > 0 ? evaluationScore(evaluations, pass) : pass ? 1 : 0,
    issues,
    reviewer_agent_id: reviewerIds,
    summary: summarize(commandResults, adapterResults, issues, evaluations),
    ...(commandResults.length > 0 ? { verify_commands: commandResults.map(commandAudit) } : {}),
    ...(evaluations.length > 0 ? { evaluations } : {}),
  };
}

async function runSpecCommand(spec: EvaluationSpec, options: LocalVerifierOptions): Promise<CommandResult> {
  return await runShellCommand(spec.command ?? "", {
    cwd: options.workspacePath,
    timeoutMs: options.timeoutMs ?? 120_000,
    outputLimit: options.outputLimit ?? 16_000,
  });
}

function commandEvaluationResult(spec: EvaluationSpec, implicit: boolean, result: CommandResult): EvaluationResult {
  const pass = result.exitCode === 0;
  const detail = singleLine(result.stderr.trim() || result.stdout.trim());
  return {
    spec_id: spec.id,
    mode: spec.mode,
    description: spec.description,
    required: spec.required,
    weight: spec.weight,
    pass,
    summary: pass
      ? `command passed (${result.durationMs} ms)`
      : `command failed (exit ${result.exitCode})${detail === "" ? "" : `: ${detail}`}`,
    implicit,
  };
}

function adapterEvaluationResult(
  spec: EvaluationSpec,
  adapterConfigured: boolean,
  adapterHasIssues: boolean,
  adapterResults: readonly VerifierAdapterResult[],
): EvaluationResult {
  if (!adapterConfigured) {
    return {
      spec_id: spec.id,
      mode: spec.mode,
      description: spec.description,
      required: spec.required,
      weight: spec.weight,
      pass: false,
      summary: "not evaluated: no verifier adapter configured",
      implicit: false,
    };
  }
  const summary = adapterHasIssues
    ? singleLine(adapterResults.flatMap((result) => result.issues)[0]?.message ?? "verifier adapter reported issues")
    : adapterResults.find((result) => result.summary !== undefined)?.summary
      ?? `verified by ${adapterResults.map((result) => result.agentId).join(",")}`;
  return {
    spec_id: spec.id,
    mode: spec.mode,
    description: spec.description,
    required: spec.required,
    weight: spec.weight,
    pass: !adapterHasIssues,
    summary: singleLine(summary),
    implicit: false,
  };
}

function evaluationIssue(spec: EvaluationSpec, detail: string): Issue {
  return {
    severity: spec.required ? "error" : "warning",
    message: `evaluation ${spec.id} failed: ${detail}`,
    rule: "verify.evaluation_failed",
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

interface ArtifactVerification {
  issues: Issue[];
  evaluations: EvaluationResult[];
}

async function verifyArtifacts(
  options: LocalVerifierOptions,
  artifactOptions: Required<ArtifactVerificationOptions> | undefined,
  explicitSpecs: readonly EvaluationSpec[],
): Promise<ArtifactVerification> {
  if (artifactOptions === undefined && explicitSpecs.length === 0) {
    return { issues: [], evaluations: [] };
  }

  const diffResult = await runShellCommand("git diff --name-only -- . && git ls-files --others --exclude-standard", {
    cwd: options.workspacePath,
    timeoutMs: options.timeoutMs ?? 120_000,
    outputLimit: options.outputLimit ?? 16_000,
  });
  if (diffResult.exitCode !== 0) {
    const issue = commandIssue("verify.artifact_git_diff_failed", diffResult);
    const failAll = (spec: EvaluationSpec, implicit: boolean): EvaluationResult => ({
      spec_id: spec.id,
      mode: spec.mode,
      description: spec.description,
      required: spec.required,
      weight: spec.weight,
      pass: false,
      summary: "artifact verification failed: git diff unavailable",
      implicit,
    });
    return {
      issues: [issue],
      evaluations: [
        ...(artifactOptions !== undefined ? [failAll(implicitArtifactSpecFrom(artifactOptions), true)] : []),
        ...explicitSpecs.map((spec) => failAll(spec, false)),
      ],
    };
  }

  const changedFiles = [...new Set(diffResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0))];

  const issues: Issue[] = [];
  const evaluations: EvaluationResult[] = [];

  if (artifactOptions !== undefined) {
    const implicitIssues = evaluateArtifactPaths(changedFiles, {
      requireGitDiff: artifactOptions.requireGitDiff,
      targetPaths: artifactOptions.targetPaths,
      forbiddenPaths: artifactOptions.forbiddenPaths,
    });
    issues.push(...implicitIssues);
    const spec = implicitArtifactSpecFrom(artifactOptions);
    evaluations.push({
      spec_id: spec.id,
      mode: spec.mode,
      description: spec.description,
      required: spec.required,
      weight: spec.weight,
      pass: implicitIssues.length === 0,
      summary: implicitIssues.length === 0
        ? `artifact gates passed (${changedFiles.length} changed file(s))`
        : singleLine(implicitIssues[0]?.message ?? "artifact verification failed"),
      implicit: true,
    });
  }

  for (const spec of explicitSpecs) {
    const specIssues = evaluateArtifactPaths(changedFiles, {
      requireGitDiff: true,
      targetPaths: spec.target_paths.map(normalizePathPattern).filter((path) => path.length > 0),
      forbiddenPaths: spec.forbidden_paths.map(normalizePathPattern).filter((path) => path.length > 0),
    });
    if (specIssues.length > 0) {
      issues.push(evaluationIssue(spec, singleLine(specIssues[0]?.message ?? "artifact verification failed")));
    }
    evaluations.push({
      spec_id: spec.id,
      mode: spec.mode,
      description: spec.description,
      required: spec.required,
      weight: spec.weight,
      pass: specIssues.length === 0,
      summary: specIssues.length === 0
        ? `artifact gates passed (${changedFiles.length} changed file(s))`
        : singleLine(specIssues[0]?.message ?? "artifact verification failed"),
      implicit: false,
    });
  }

  return { issues, evaluations };
}

function implicitArtifactSpecFrom(artifactOptions: Required<ArtifactVerificationOptions>): EvaluationSpec {
  return implicitArtifactSpec({
    requireGitDiff: artifactOptions.requireGitDiff,
    targetPaths: artifactOptions.targetPaths,
    forbiddenPaths: artifactOptions.forbiddenPaths,
  });
}

function evaluateArtifactPaths(
  changedFiles: readonly string[],
  gates: { requireGitDiff: boolean; targetPaths: readonly string[]; forbiddenPaths: readonly string[] },
): Issue[] {
  const issues: Issue[] = [];
  if (gates.requireGitDiff && changedFiles.length === 0) {
    issues.push({
      severity: "error",
      message: "artifact verification failed: git diff is empty",
      rule: "verify.artifact_empty_diff",
    });
  }

  if (gates.targetPaths.length > 0) {
    const hitTarget = changedFiles.some((file) =>
      gates.targetPaths.some((target) => pathMatches(file, target))
    );
    if (!hitTarget) {
      issues.push({
        severity: "error",
        message: `artifact verification failed: changed files did not hit target paths (${gates.targetPaths.join(", ")})`,
        rule: "verify.artifact_target_miss",
      });
    }
  }

  const forbiddenHit = changedFiles.find((file) =>
    gates.forbiddenPaths.some((target) => pathMatches(file, target))
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
  adapterSpecs: readonly EvaluationSpec[],
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
    results.push(await invokeVerifierAdapter(run, options, adapter, adapterSpecs));
  }
  return results;
}

async function invokeVerifierAdapter(
  run: AgentRun,
  options: LocalVerifierOptions,
  adapter: AgentAdapter,
  adapterSpecs: readonly EvaluationSpec[],
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
    const agentTask = verifierAgentTask(run, options, adapter, adapterSpecs);
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

function verifierAgentTask(
  run: AgentRun,
  options: LocalVerifierOptions,
  adapter: AgentAdapter,
  adapterSpecs: readonly EvaluationSpec[],
): AgentTask {
  const task = options.task;
  const acceptanceLines = adapterSpecs.flatMap((spec) => [
    `Evaluation ${spec.id} (${spec.mode}): ${spec.description}`,
    ...(spec.acceptance !== undefined ? [`  Acceptance: ${spec.acceptance}`] : []),
  ]);
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
      ...(acceptanceLines.length > 0 ? ["", "Evaluation criteria:", ...acceptanceLines] : []),
    ].join("\n"),
    context: {
      ...(task?.context ?? {}),
      repo_path: options.workspacePath,
      subject_run_id: run.run_id,
      subject_agent_id: run.agent_id,
      subject_outcome: run.outcome,
      ...(adapterSpecs.length > 0 ? { evaluation_specs: adapterSpecs } : {}),
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

function summarize(
  results: CommandResult[],
  adapters: VerifierAdapterResult[],
  issues: Issue[],
  evaluations: EvaluationResult[],
): string {
  if (results.length === 0 && adapters.length === 0 && issues.length === 0 && evaluations.length === 0) {
    return "No verifier commands or adapters configured; execution succeeded.";
  }
  const failedEvaluations = evaluations.filter((evaluation) => !evaluation.pass);
  if (issues.length === 0) {
    const parts = [
      `${results.length} verifier command${results.length === 1 ? "" : "s"}`,
      `${adapters.length} verifier adapter${adapters.length === 1 ? "" : "s"}`,
    ];
    const evaluationNote = evaluations.length > 0
      ? ` ${evaluations.length} evaluation${evaluations.length === 1 ? "" : "s"} passed.`
      : "";
    return `${parts.join(" and ")} passed.${evaluationNote}`;
  }
  const evaluationNote = failedEvaluations.length > 0
    ? ` Failed evaluations: ${failedEvaluations.map((evaluation) => evaluation.spec_id).join(", ")}.`
    : "";
  return `${issues.length} issue${issues.length === 1 ? "" : "s"} found by local verifier.${evaluationNote}`;
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
