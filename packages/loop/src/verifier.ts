import { execFileSync } from "node:child_process";
import type { AgentAdapter, AgentTask } from "@osstack/agents";
import {
  StructuredReviewSchema,
  type HermesEvent,
} from "@osstack/hermes-adapter";
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
import {
  collectReviewBoundary,
  type CollectedReviewBoundary,
  type ReviewBoundaryPolicy,
  type ReviewCandidateInput,
} from "./review-boundary.js";
import {
  REVIEWER_GIT_ARGS,
  reviewerGitEnvironment,
  reviewerWorkspaceMutated,
  snapshotReviewerWorkspace,
} from "./reviewer-isolation.js";
import {
  ImplementationDeviation,
  ReviewArtifact,
  type ImplementationDeviation as ImplementationDeviationValue,
  type Issue,
  type ReviewArtifact as ReviewArtifactValue,
  type Task,
  type Verdict,
} from "./types.js";
import { truncateUnicodeSafe } from "./unicode.js";

export interface LocalVerifierOptions {
  workspacePath: string;
  commands?: string[];
  verifierAgentIds?: string[];
  adapters?: readonly AgentAdapter[];
  task?: Task;
  artifactVerification?: ArtifactVerificationOptions;
  /** Trusted LoopEngine capture before execution; compare committed candidate plus dirty/untracked files. */
  artifactBaseCommit?: string;
  sessionId?: string;
  timeoutMs?: number;
  outputLimit?: number;
  /** Explicit per-run overrides; never mutate the host process environment. */
  commandEnv?: NodeJS.ProcessEnv;
  /** False replaces the ambient environment; default preserves existing callers. */
  inheritCommandEnv?: boolean;
  reviewBoundary?: Partial<ReviewBoundaryPolicy>;
  /** Captured patch and complete paths to review, still subject to the boundary policy. */
  reviewCandidate?: ReviewCandidateInput;
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
  if (options.artifactBaseCommit !== undefined) {
    const base = options.artifactBaseCommit;
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base)) throw Error("INVALID_ARTIFACT_BASE_COMMIT");
    const git = (args: string[]) => execFileSync("git", [...REVIEWER_GIT_ARGS, ...args], { env: reviewerGitEnvironment(options.workspacePath), cwd: options.workspacePath, encoding: "utf8", timeout: options.timeoutMs ?? 120_000, maxBuffer: 1_048_576 });
    git(["merge-base", "--is-ancestor", base, "HEAD"]);
    // Final structured review sees the complete committed candidate, not an empty clean-tree diff.
    const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]);
    const changed = git(["diff", "--no-ext-diff", "--no-textconv", base, "--no-renames", "--name-only", "-z", "--", "."]) + untracked;
    if (Buffer.byteLength(changed) > 1_048_576) throw Error("CANDIDATE_ARTIFACT_RANGE_TOO_LARGE");
    if (untracked.length > 0) throw Error("CANDIDATE_REVIEW_UNTRACKED");
    options = { ...options, reviewCandidate: { changed_paths: changed.split("\0").filter(Boolean), diff: git(["diff", "--no-ext-diff", "--no-textconv", base, "--no-renames", "--", "."]) } };
  }
  const explicitSpecs = options.task?.evaluation ?? [];

  // Legacy --verify commands become implicit command evaluation specs.
  const implicitCommandSpecs = (options.commands ?? [])
    .filter((command) => command.trim() !== "")
    .map(implicitCommandSpec);
  const explicitCommandSpecs = explicitSpecs.filter(isCommandEvaluationSpec);
  const commandRuns: CommandSpecRun[] = [];
  for (const { spec, implicit } of [...implicitCommandSpecs.map(spec => ({ spec, implicit: true })), ...explicitCommandSpecs.map(spec => ({ spec, implicit: false }))]) {
    const result = await runSpecCommand(spec, options);
    commandRuns.push({ spec, implicit, result });
    if (result.termination?.stop_confirmed !== true) return unconfirmedVerifierStop("Verification command stop is unconfirmed; no further checks may run");
  }

  const artifactOptions = normalizeArtifactOptions(options);
  const explicitArtifactSpecs = explicitSpecs.filter(
    (spec) => spec.mode === "artifact" && !isCommandEvaluationSpec(spec),
  );
  const artifact = await verifyArtifacts(options, artifactOptions, explicitArtifactSpecs);
  if (artifact.issues.some(issue => issue.rule === "verify.adapter_stop_unconfirmed")) return unconfirmedVerifierStop("Artifact command stop is unconfirmed; no further checks may run");
  const adapterSpecs = explicitSpecs.filter(isAdapterEvaluationSpec);
  const adapterResults = await runVerifierAdapters(
    run,
    options,
    adapterSpecs,
    commandRuns.map(({ result }) => result),
  );

  const executionIssues = run.command_results
    .filter((result) => result.exitCode !== 0)
    .map((result) => commandIssue("execute.command_failed", result));
  const executionOutcomeIssues: Issue[] = run.outcome === "completed"
    ? []
    : [{
        severity: "error",
        message: `Builder execution ended ${run.outcome}${
          run.summary === undefined ? "" : `: ${singleLine(run.summary)}`
        }`,
        rule: "execute.outcome_not_completed",
      }];
  const verificationIssues = commandRuns
    .filter(({ implicit, result }) => implicit && result.exitCode !== 0)
    .map(({ result }) => commandIssue("verify.command_failed", result));
  const explicitCommandIssues = commandRuns
    .filter(({ implicit, result }) => !implicit && result.exitCode !== 0)
    .map(({ spec, result }) => evaluationIssue(spec, singleLine(
      result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`,
    )));
  const adapterIssues = adapterResults.flatMap((result) => result.issues);
  const adapterConfigured = (options.verifierAgentIds ?? []).some((id) => id.trim() !== "");
  const unverifiedAdapterSpecIssues = adapterConfigured
    ? []
    : adapterSpecs.map((spec) => evaluationIssue(spec, "no verifier adapter configured for this evaluation"));
  const judgmentsBySpec = collectJudgmentsBySpec(adapterResults);
  const reconciliationIssues = reconcileAdapterJudgments(
    adapterResults,
    adapterSpecs,
  );
  const adapterHasIssues = adapterIssues.some((issue) => issue.severity === "error")
    || reconciliationIssues.some((issue) => issue.severity === "error");
  const judgedFailureIssues = adapterSpecs.flatMap((spec) => {
    const judgments = judgmentsBySpec.get(spec.id) ?? [];
    const failing = judgments.find((judgment) => !judgment.pass);
    if (failing === undefined) return [];
    return [evaluationIssue(spec, singleLine(failing.summary ?? "verifier adapter judged this evaluation as failed"))];
  });
  // Fail-closed on unknown judgment ids: an adapter judgment whose id matches no
  // requested spec must never be silently dropped. Both passing and failing
  // orphan judgments are errors: a mismatched id cannot satisfy this contract.
  const issues = [
    ...executionOutcomeIssues,
    ...executionIssues,
    ...verificationIssues,
    ...explicitCommandIssues,
    ...adapterIssues,
    ...judgedFailureIssues,
    ...reconciliationIssues,
    ...unverifiedAdapterSpecIssues,
    ...artifact.issues,
  ];

  const evaluations: EvaluationResult[] = [
    ...commandRuns.map(({ spec, implicit, result }) => commandEvaluationResult(spec, implicit, result)),
    ...adapterSpecs.map((spec) => adapterEvaluationResult(
      spec,
      adapterConfigured,
      adapterHasIssues,
      adapterResults,
      judgmentsBySpec.get(spec.id) ?? [],
    )),
    ...artifact.evaluations,
  ];

  const pass = !issues.some((issue) => issue.severity === "error");
  const reviewerIds = adapterResults.length > 0
    ? adapterResults.map((result) => result.agentId).join(",")
    : "local-verifier";
  const commandResults = commandRuns.map(({ result }) => result);
  const implementationDeviations = deduplicateImplementationDeviations(
    adapterResults.flatMap((result) => result.implementationDeviations ?? []),
  );
  const reviewArtifacts = adapterResults.flatMap(
    (result) => result.reviewArtifact === undefined ? [] : [result.reviewArtifact],
  );

  return {
    pass,
    score: evaluations.length > 0 ? evaluationScore(evaluations, pass) : pass ? 1 : 0,
    issues,
    reviewer_agent_id: reviewerIds,
    summary: summarize(commandResults, adapterResults, issues, evaluations),
    ...(commandResults.length > 0 ? { verify_commands: commandResults.map(commandAudit) } : {}),
    ...(evaluations.length > 0 ? { evaluations } : {}),
    ...(implementationDeviations.length > 0
      ? { implementation_deviations: implementationDeviations }
      : {}),
    ...(reviewArtifacts.length > 0 ? { review_artifacts: reviewArtifacts } : {}),
  };
}

function unconfirmedVerifierStop(message: string): Verdict {
  message += ". A preflight refusal is possible; this is not evidence that a process remains alive. Reconcile before retry.";
  return { pass: false, score: 0, reviewer_agent_id: "local-verifier", summary: message,
    issues: [{ severity: "error", rule: "verify.adapter_stop_unconfirmed", message }] };
}

function deduplicateImplementationDeviations(
  deviations: readonly ImplementationDeviationValue[],
): ImplementationDeviationValue[] {
  const seen = new Set<string>();
  return deviations.filter((deviation) => {
    if (seen.has(deviation.deviation_id)) return false;
    seen.add(deviation.deviation_id);
    return true;
  });
}

async function runSpecCommand(spec: EvaluationSpec, options: LocalVerifierOptions): Promise<CommandResult> {
  return await runShellCommand(spec.command ?? "", {
    cwd: options.workspacePath,
    timeoutMs: options.timeoutMs ?? 120_000,
    outputLimit: options.outputLimit ?? 16_000,
    ...(options.commandEnv !== undefined ? { env: options.commandEnv } : {}),
    ...(options.inheritCommandEnv === undefined ? {} : { inheritEnv: options.inheritCommandEnv }),
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
  judgments: readonly AdapterEvaluationJudgment[],
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

  // Per-spec judgments from the adapter beat the adapter-level pass/fail — but
  // only when the adapter actually completed. If it failed/timed out/was
  // unavailable (adapterHasIssues), its judgments are untrustworthy: honor a
  // reported fail, but never let a stale "pass" judgment mark the spec passing
  // while the run is blocked (which would yield pass=false with score=1.0).
  if (judgments.length > 0) {
    const failing = judgments.find((judgment) => !judgment.pass);
    if (failing !== undefined || !adapterHasIssues) {
      const summary = failing !== undefined
        ? failing.summary ?? "verifier adapter judged this evaluation as failed"
        : judgments.find((judgment) => judgment.summary !== undefined)?.summary ?? "judged pass by verifier adapter";
      return {
        spec_id: spec.id,
        mode: spec.mode,
        description: spec.description,
        required: spec.required,
        weight: spec.weight,
        pass: failing === undefined,
        summary: singleLine(summary),
        implicit: false,
      };
    }
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

function collectJudgmentsBySpec(
  adapterResults: readonly VerifierAdapterResult[],
): Map<string, AdapterEvaluationJudgment[]> {
  const bySpec = new Map<string, AdapterEvaluationJudgment[]>();
  for (const result of adapterResults) {
    for (const judgment of result.judgments ?? []) {
      const existing = bySpec.get(judgment.id);
      if (existing === undefined) bySpec.set(judgment.id, [judgment]);
      else existing.push(judgment);
    }
  }
  return bySpec;
}

function reconcileAdapterJudgments(
  adapterResults: readonly VerifierAdapterResult[],
  requestedSpecs: readonly EvaluationSpec[],
): Issue[] {
  const issues: Issue[] = [];
  const requestedIds = new Set(requestedSpecs.map((spec) => spec.id));
  const counts = new Map<string, number>();
  for (const result of adapterResults) {
    for (const judgment of result.judgments ?? []) {
      counts.set(judgment.id, (counts.get(judgment.id) ?? 0) + 1);
    }
  }

  for (const spec of requestedSpecs) {
    if ((counts.get(spec.id) ?? 0) > 0) continue;
    issues.push(evaluationIssue(
      spec,
      "verifier adapter returned no structured judgment for this evaluation id",
    ));
  }
  for (const [id, count] of counts) {
    if (count > 1) {
      issues.push({
        severity: "error",
        message: `verifier adapters returned duplicate judgments for evaluation id "${id}"`,
        rule: "verify.duplicate_evaluation_id",
      });
    }
    if (!requestedIds.has(id)) {
      issues.push({
        severity: "error",
        message: `verifier adapter returned judgment for unknown evaluation id "${id}"`,
        rule: "verify.unknown_evaluation_id",
      });
    }
  }
  return issues;
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
    exit_confirmed: result.termination?.scope === "posix_process_group" && result.termination.stop_confirmed === true && result.termination.trigger === "exit" && result.failure_code === undefined && result.cancellation === undefined,
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

  const base = options.artifactBaseCommit;
  if (base !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base)) throw Error("INVALID_ARTIFACT_BASE_COMMIT");
  let diffResult: CommandResult;
  const git = (args: string[]) => execFileSync("git", [...REVIEWER_GIT_ARGS, ...args], { env: reviewerGitEnvironment(options.workspacePath), cwd: options.workspacePath, encoding: "utf8", timeout: options.timeoutMs ?? 120_000, maxBuffer: 1_048_576 });
  try {
    if (base !== undefined) git(["merge-base", "--is-ancestor", base, "HEAD"]);
    // Machine-readable paths must never pass through the executor's tail-truncated log buffer.
    const stdout = git(["diff", "--no-ext-diff", "--no-textconv", ...(base === undefined ? [] : [base]), "--no-renames", "--name-only", "-z", "--", "."])
      + git(["ls-files", "--others", "--exclude-standard", "-z"]);
    if (Buffer.byteLength(stdout) > 1_048_576) throw Error("CANDIDATE_ARTIFACT_RANGE_TOO_LARGE");
    diffResult = { command: "git complete artifact paths", exitCode: 0, stdout, stderr: "", durationMs: 0 };
  } catch (error) {
    const failure = error as { status?: number | null; signal?: string | null };
    if (typeof failure.status !== "number" || failure.signal) {
      return { issues: unconfirmedVerifierStop("Artifact path observation did not complete; candidate reconciliation required").issues, evaluations: [] };
    }
    diffResult = { command: "git complete artifact paths", exitCode: failure.status === 0 ? 1 : failure.status, stdout: "", stderr: error instanceof Error ? error.message : String(error), durationMs: 0 };
  }
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
    .split("\0")
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

/** Per-spec judgment reported by a verifier adapter (e.g. via OSSTACK_EVALUATIONS stdout). */
interface AdapterEvaluationJudgment {
  id: string;
  pass: boolean;
  summary?: string;
}

interface VerifierAdapterResult {
  agentId: string;
  eventCount: number;
  issues: Issue[];
  summary?: string;
  judgments?: AdapterEvaluationJudgment[];
  implementationDeviations?: ImplementationDeviationValue[];
  reviewArtifact?: ReviewArtifactValue;
}

async function runVerifierAdapters(
  run: AgentRun,
  options: LocalVerifierOptions,
  adapterSpecs: readonly EvaluationSpec[],
  verificationResults: readonly CommandResult[],
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
    const result = await invokeVerifierAdapter(
      run,
      options,
      adapter,
      adapterSpecs,
      verificationResults,
    );
    results.push(result);
    if (result.issues.some(issue => ["verify.adapter_stop_unconfirmed", "verify.reviewer_mutation", "verify.reviewer_integrity_unconfirmed"].includes(issue.rule ?? ""))) break;
  }
  return results;
}

/** Bounds read-only preparation; outstanding filesystem reads confer no approval. */
async function verifierReadDeadline<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    void pending.catch(() => undefined);
    throw Error("verifier snapshot timed out");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve,reject) => {
      timer = setTimeout(() => reject(Error("verifier snapshot timed out")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function invokeVerifierAdapter(
  run: AgentRun,
  options: LocalVerifierOptions,
  adapter: AgentAdapter,
  adapterSpecs: readonly EvaluationSpec[],
  verificationResults: readonly CommandResult[],
): Promise<VerifierAdapterResult> {
  const requestedTimeout = options.timeoutMs ?? (adapter.id === "kimi-code" ? 600_000 : 120_000);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 && requestedTimeout <= 2 ** 31 - 1
    ? requestedTimeout : (adapter.id === "kimi-code" ? 600_000 : 120_000);
  const deadline = performance.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - performance.now());
  let beforeSnapshot: Awaited<ReturnType<typeof snapshotReviewerWorkspace>> | undefined;
  // Availability probes are adapter code and share the read-only boundary.
  try {
    beforeSnapshot = await verifierReadDeadline(snapshotReviewerWorkspace(options.workspacePath), remaining());
  } catch (error) {
    return {
      agentId: adapter.id,
      eventCount: 0,
      issues: [adapterIssue(
        adapter.id,
        "verify.reviewer_snapshot_failed",
        error instanceof Error ? error.message : String(error),
      )],
    };
  }

  const preparationIntegrity = async (): Promise<Issue[]> => {
    try {
      const after = await verifierReadDeadline(snapshotReviewerWorkspace(options.workspacePath), remaining());
      return reviewerWorkspaceMutated(beforeSnapshot!, after)
        ? [adapterIssue(adapter.id, "verify.reviewer_mutation", "Verifier availability probe changed candidate state")] : [];
    } catch (error) {
      return [adapterIssue(adapter.id, "verify.reviewer_integrity_unconfirmed", "Availability probe integrity could not be verified"),
        adapterIssue(adapter.id, "verify.reviewer_snapshot_failed", error instanceof Error ? error.message : String(error))];
    }
  };
  let availability: Awaited<ReturnType<AgentAdapter["isAvailable"]>>;
  let availabilityTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    availability = await Promise.race([
      Promise.resolve().then(() => adapter.isAvailable()),
      new Promise<never>((_resolve, reject) => {
        availabilityTimer = setTimeout(() => reject(Error("verifier availability timed out")), remaining());
      }),
    ]);
    if (!availability || typeof availability.available !== "boolean") throw Error("invalid verifier availability");
  } catch (error) {
    return { agentId: adapter.id, eventCount: 0, issues: [
      adapterIssue(adapter.id, "verify.adapter_failed", error instanceof Error ? error.message : String(error)),
      adapterIssue(adapter.id, "verify.adapter_stop_unconfirmed", "Availability probe failed without physical stop evidence"),
      ...await preparationIntegrity(),
    ] };
  } finally { clearTimeout(availabilityTimer); }
  const preparationIssues = await preparationIntegrity();
  if (preparationIssues.length > 0) return { agentId: adapter.id, eventCount: 0, issues: preparationIssues };
  if (!availability.available) {
    return { agentId: adapter.id, eventCount: 0,
      issues: [adapterIssue(adapter.id, "verify.adapter_unavailable", availability.reason ?? "verifier unavailable")] };
  }

  const structuredReview = adapter.id === "kimi-code";
  let boundary: CollectedReviewBoundary | undefined;
  if (structuredReview) {
    try {
      boundary = await verifierReadDeadline(collectReviewBoundary(
        options.workspacePath,
        options.reviewBoundary ?? {},
        options.reviewCandidate,
      ), remaining());
    } catch (error) {
      return {
        agentId: adapter.id,
        eventCount: 0,
        issues: [adapterIssue(
          adapter.id,
          "verify.review_boundary_failed",
          error instanceof Error ? error.message : String(error),
        )],
      };
    }
    if (!boundary.boundary.pass || boundary.sanitized_diff === undefined) {
      return {
        agentId: adapter.id,
        eventCount: 0,
        issues: boundary.boundary.findings.map((finding) => ({
          severity: "error",
          ...(finding.path !== undefined ? { file: finding.path } : {}),
          message: `${adapter.id} review boundary failed: ${finding.message}`,
          rule: finding.rule_id,
        })),
      };
    }
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, remaining());
  let eventCount = 0;
  let summary: string | undefined;
  let status: "completed" | "failed" | "cancelled" | "expired" | undefined;
  let terminalError: string | undefined;
  let judgments: AdapterEvaluationJudgment[] | undefined;
  let implementationDeviations: ImplementationDeviationValue[] | undefined;
  let reviewArtifact: ReviewArtifactValue | undefined;
  let reviewArtifactError: string | undefined;
  let snapshotError: string | undefined;
  let workspaceMutated = false;
  let iterator: AsyncIterator<HermesEvent> | undefined;
  let invocationAttempted = false;
  let iteratorFinished = false;
  const nextOrAbort = async () => {
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(Error(`verifier timed out after ${timeoutMs}ms; stop_confirmed=unknown`));
      controller.signal.addEventListener("abort", abort, {once:true});
      if (controller.signal.aborted) abort();
    });
    try { return await Promise.race([iterator!.next(), cancelled]); }
    finally { controller.signal.removeEventListener("abort", abort); }
  };

  try {
    const agentTask = verifierAgentTask(
      run,
      options,
      adapter,
      adapterSpecs,
      boundary,
      verificationResults,
    );
    if (remaining() <= 0) throw Error("verifier deadline exhausted before invocation");
    invocationAttempted = true;
    iterator = adapter.invoke(agentTask, controller.signal)[Symbol.asyncIterator]();
    while (true) {
      const next = await nextOrAbort();
      if (next.done) { iteratorFinished = true; break; }
      const event = next.value;
      eventCount += 1;
      if (event.type === "error" && event.terminal) {
        terminalError = errorPayload(event.payload).message;
      }
      if (event.type === "done") {
        const payload = donePayload(event.payload);
        status = payload.status;
        summary = payload.result_summary;
        if (structuredReview) {
          const parsedReview = StructuredReviewSchema.safeParse(payload.review);
          if (parsedReview.success) {
            const parsedArtifact = ReviewArtifact.safeParse({
              ...parsedReview.data,
              reviewer_agent_id: adapter.id,
            });
            if (parsedArtifact.success) {
              reviewArtifact = parsedArtifact.data;
              judgments = parsedArtifact.data.judgments;
            } else {
              reviewArtifactError = parsedArtifact.error.message;
            }
          } else {
            reviewArtifactError = parsedReview.error.message;
          }
        } else {
          judgments = parseEvaluationJudgments(payload.evaluation_judgments);
        }
        implementationDeviations = parseImplementationDeviations(
          payload.implementation_deviations,
        );
      }
    }
  } catch (error) {
    terminalError = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeout);
    if (!iteratorFinished && iterator) {
      controller.abort();
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => iterator?.return?.()),
          new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 100); }),
        ]);
      } catch { /* Cleanup cannot turn an unconfirmed stop into a pass. */ }
      finally { clearTimeout(cleanupTimer); }
    }
    if (beforeSnapshot !== undefined) {
      try {
        const afterSnapshot = await verifierReadDeadline(snapshotReviewerWorkspace(options.workspacePath), remaining());
        workspaceMutated = reviewerWorkspaceMutated(
          beforeSnapshot,
          afterSnapshot,
        );
      } catch (error) {
        snapshotError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  const issues: Issue[] = [];
  if (invocationAttempted && !iteratorFinished) {
    issues.push(adapterIssue(adapter.id,"verify.adapter_stop_unconfirmed","Verifier stream ended abnormally without physical stop evidence; reconciliation required"));
  }
  if (snapshotError !== undefined) {
    issues.push(adapterIssue(adapter.id, "verify.reviewer_integrity_unconfirmed", "Post-invocation workspace integrity could not be verified; do not retry this candidate"));
    issues.push(adapterIssue(
      adapter.id,
      "verify.reviewer_snapshot_failed",
      snapshotError,
    ));
  }
  if (workspaceMutated) {
    issues.push(adapterIssue(
      adapter.id,
      "verify.reviewer_mutation",
      "reviewer changed the builder workspace or Git metadata",
    ));
  }
  if (structuredReview) {
    if (reviewArtifact === undefined) {
      issues.push(adapterIssue(
        adapter.id,
        "verify.review_artifact_invalid",
        reviewArtifactError ?? "structured review payload is missing",
      ));
    } else if (reviewArtifact.verdict !== "approved") {
      issues.push(adapterIssue(
        adapter.id,
        "verify.review_not_approved",
        `structured reviewer verdict is ${reviewArtifact.verdict}`,
      ));
    }
  }
  if (terminalError !== undefined) {
    issues.push(adapterIssue(
      adapter.id,
      "verify.adapter_failed",
      terminalError,
    ));
  } else if (timedOut) {
    issues.push(adapterIssue(
      adapter.id,
      "verify.adapter_failed",
      `verifier timed out after ${timeoutMs}ms`,
    ));
  } else if (
    status !== "completed"
    && !(structuredReview && reviewArtifact?.verdict !== "approved")
  ) {
    const message = summary
      ?? (controller.signal.aborted
        ? `verifier timed out after ${timeoutMs}ms`
        : "verifier did not complete");
    issues.push(adapterIssue(adapter.id, "verify.adapter_failed", message));
  }

  if (!issues.some((issue) => issue.severity === "error")) {
    return {
      agentId: adapter.id,
      eventCount,
      issues,
      ...(summary !== undefined ? { summary } : {}),
      ...(judgments !== undefined && judgments.length > 0 ? { judgments } : {}),
      ...(implementationDeviations !== undefined && implementationDeviations.length > 0
        ? { implementationDeviations }
        : {}),
      ...(reviewArtifact !== undefined ? { reviewArtifact } : {}),
    };
  }

  return {
    agentId: adapter.id,
    eventCount,
    issues,
    ...(summary !== undefined ? { summary } : {}),
    ...(judgments !== undefined && judgments.length > 0 ? { judgments } : {}),
    ...(implementationDeviations !== undefined && implementationDeviations.length > 0
      ? { implementationDeviations }
      : {}),
    ...(reviewArtifact !== undefined ? { reviewArtifact } : {}),
  };
}

function parseImplementationDeviations(
  raw: unknown,
): ImplementationDeviationValue[] | undefined {
  if (!Array.isArray(raw) || raw.length > 100) return undefined;
  const parsed = raw.flatMap((entry) => {
    const result = ImplementationDeviation.safeParse(entry);
    return result.success ? [result.data] : [];
  });
  return parsed.length > 0 ? parsed : undefined;
}

function parseEvaluationJudgments(raw: unknown): AdapterEvaluationJudgment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const judgments = raw.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate["id"] !== "string" || typeof candidate["pass"] !== "boolean") return [];
    return [{
      id: candidate["id"],
      pass: candidate["pass"],
      ...(typeof candidate["summary"] === "string" ? { summary: candidate["summary"] } : {}),
    }];
  });
  return judgments.length > 0 ? judgments : undefined;
}

function verifierAgentTask(
  run: AgentRun,
  options: LocalVerifierOptions,
  adapter: AgentAdapter,
  adapterSpecs: readonly EvaluationSpec[],
  boundary: CollectedReviewBoundary | undefined,
  verificationResults: readonly CommandResult[],
): AgentTask {
  const task = options.task;
  const acceptanceLines = adapterSpecs.flatMap((spec) => [
    `Evaluation ${spec.id} (${spec.mode}): ${spec.description}`,
    ...(spec.acceptance !== undefined ? [`  Acceptance: ${spec.acceptance}`] : []),
  ]);
  const deterministicResults = [
    ...run.command_results,
    ...verificationResults,
  ].map((result) => ({
    command: result.command,
    exit_code: result.exitCode,
    summary: singleLine(
      result.stderr.trim()
      || result.stdout.trim()
      || `exit code ${result.exitCode}`,
    ),
  }));
  const kimiReviewInput = boundary?.sanitized_diff === undefined
    ? undefined
    : {
        schema_version: 1 as const,
        task: task?.prompt ?? run.task_id,
        evaluation_criteria: adapterSpecs.map((spec) => ({
          id: spec.id,
          requirement: spec.acceptance ?? spec.description,
        })),
        changed_paths: boundary.boundary.changed_paths,
        diff: boundary.sanitized_diff,
        deterministic_results: deterministicResults,
        evidence_refs: [],
      };
  const context = { ...(task?.context ?? {}) };
  // Repository task data cannot grant a reviewer write access to external paths.
  delete context["review_output_path"];
  delete context["verify_output_path"];
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
      ...context,
      repo_path: options.workspacePath,
      subject_run_id: run.run_id,
      subject_agent_id: run.agent_id,
      subject_outcome: run.outcome,
      ...(adapterSpecs.length > 0 ? { evaluation_specs: adapterSpecs } : {}),
      ...(kimiReviewInput !== undefined
        ? { kimi_review_input: kimiReviewInput }
        : {}),
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
    const adapterNotes = adapters.flatMap(adapter => adapter.summary ? [adapter.summary] : []);
    return `${parts.join(" and ")} passed.${evaluationNote}${adapterNotes.length ? ` ${adapterNotes.join("; ")}` : ""}`;
  }
  const evaluationNote = failedEvaluations.length > 0
    ? ` Failed evaluations: ${failedEvaluations.map((evaluation) => evaluation.spec_id).join(", ")}.`
    : "";
  return `${issues.length} issue${issues.length === 1 ? "" : "s"} found by local verifier.${evaluationNote}`;
}

function singleLine(value: string): string {
  return truncateUnicodeSafe(value.replace(/\s+/g, " "), 240);
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
  evaluation_judgments?: unknown;
  implementation_deviations?: unknown;
  review?: unknown;
} {
  return payload as {
    status: "completed" | "failed" | "cancelled" | "expired";
    result_summary?: string;
    evaluation_judgments?: unknown;
    implementation_deviations?: unknown;
    review?: unknown;
  };
}
