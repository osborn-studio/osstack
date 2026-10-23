import { assertDeliveryContractAdmission, assertDeliveryContractPaths, freezeDeliveryContract } from "@osstack/core";
import type { FrozenDeliveryContractV2, DeliveryReceiptReferenceV2 } from "@osstack/protocol";
import { createDeliveryVerificationFence, buildDeliveryVerificationReceipt, captureDeliveryCandidate, deliveryGit, persistDeliveryHostRecord, verifyPersistedDeliveryReceipt } from "./delivery-contract-host.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  defaultAdapters,
  type AgentAdapter,
} from "@osstack/agents";
import type { GovernanceFinding } from "@osstack/governance";
import type { GuardedDeliveryPolicy, GuardedDeliveryResult } from "@osstack/autonomy";
import {
  enqueueTask,
  LoopEngine,
  type LoopEvent,
  type LoopState,
} from "@osstack/loop";
import { z } from "zod";
import {
  resolveLoopProfileRouting,
  type LoopProfileRoutingResult,
} from "./loop-profile-routing.js";
import { makePolicyGate } from "./policy-gate.js";

const execFileAsync = promisify(execFile);
const GUARDED_LOCAL_COMMAND_TIMEOUT_MS = 600_000;

export const DeliverAutonomyMode = z.enum([
  "legacy",
  "guarded-local",
  "guarded-git",
  "guarded-deploy",
]);
export type DeliverAutonomyMode = z.infer<typeof DeliverAutonomyMode>;

type DeliverGovernanceProofEvidence =
  | {
    status: "pass" | "fail";
    ok: boolean;
    scanned_files: number;
    findings: GovernanceFinding[];
  }
  | {
    status: "unknown";
    ok: false;
    scanned_files: 0;
    reason: string;
    findings: GovernanceFinding[];
  };

export type DeliverGovernanceMode = "warn" | "strict";
export type DeliverGovernanceScope = "workspace" | "changed" | "baseline";

export interface DeliverGovernanceBaselineSnapshot {
  evidence?: DeliverGovernanceProofEvidence;
  revision?: string;
}

type DeliverGovernanceScanEvidence =
  DeliverGovernanceProofEvidence & {
    error_findings: number;
  };

export type DeliverGovernanceEvidence =
  DeliverGovernanceScanEvidence & {
    mode: DeliverGovernanceMode;
    scope: DeliverGovernanceScope;
    blocking: boolean;
    baseline_evidence?: DeliverGovernanceScanEvidence & {
      mode: "warn";
      scope: "workspace";
      blocking: false;
    };
    changed_evidence?: DeliverGovernanceScanEvidence & {
      scope: "changed";
    };
    baseline_revision?: string;
    baseline_suppressed_findings?: number;
  };

export interface DeliverEvidenceArtifacts {
  report?: string;
  scorecard_markdown?: string;
  scorecard_html?: string;
  proof_dir?: string;
  proof_zip?: string;
  proof_manifest?: string;
}

export interface DeliverCommandDeps {
  enforceObservePolicyGate: (
    workspacePath: string,
  ) => Promise<number | undefined>;
  createShadowCheckpoint: (
    workspacePath: string,
  ) => Promise<unknown>;
  createLoopGovernanceEvidence: (
    mode: DeliverGovernanceMode,
    workspacePath: string,
    scope: DeliverGovernanceScope,
    baselineSnapshot?: DeliverGovernanceBaselineSnapshot,
  ) => Promise<DeliverGovernanceEvidence>;
  captureLoopGovernanceBaseline?: (
    workspacePath: string,
    includeEvidence: boolean,
  ) => Promise<DeliverGovernanceBaselineSnapshot>;
  appendGovernanceVerifyEvent: (
    events: LoopEvent[],
    loopId: string,
    governance: DeliverGovernanceEvidence,
  ) => LoopEvent[];
  observeLoopProbeEvents: (
    workspacePath: string,
    events: readonly unknown[],
  ) => Promise<unknown>;
  writeRequestedLoopArtifacts: (
    state: LoopState,
    workspacePath: string,
    args: string[],
    events: LoopEvent[],
    governance?: DeliverGovernanceEvidence,
  ) => Promise<DeliverEvidenceArtifacts | undefined>;
  learnLessonsFromLoopState: (
    state: LoopState,
  ) => Promise<unknown>;
  adapters?: () => AgentAdapter[];
  deliveryContractPolicy?: (workspacePath: string) => Promise<{ policyDigest: string; verifyCommands: string[]; budgetRef: string; budget: GuardedDeliveryPolicy["budget"] }>;
  createExecutionContext?: (input: { adapters: readonly AgentAdapter[]; workspacePath: string; configPath: string;
    contractDigest?: string; contractBrief?: string }) => Promise<{ adapters: readonly AgentAdapter[]; receiptRefs(): readonly DeliveryReceiptReferenceV2[] }>;
  startGuardedGit?: (input: {
    prompt: string;
    workspacePath: string;
    taskId: string;
    capability: string;
    expectedPaths: string[];
    requestedActions: string[];
    verifyCommands: string[];
    commandTimeoutMs: number;
    deployPolicy?: "project";
    profileRouting: LoopProfileRoutingResult;
    frozenContract?: FrozenDeliveryContractV2;
    executionContextPath?: string;
  }) => Promise<GuardedDeliveryResult>;
  remotePorts?: {
    push: () => Promise<unknown>;
    createPullRequest: () => Promise<unknown>;
    merge: () => Promise<unknown>;
    deploy: () => Promise<unknown>;
  };
}

export async function handleDeliverCommand(
  args: string[],
  deps: DeliverCommandDeps,
): Promise<number> {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`osstack deliver — product entry from one intent to proof

  osstack deliver "Add billing dashboard" [--workspace P] [--execute CMD] [--verify CMD] [--auto-agent] [--worktree] [--checkpoint] [--govern [warn|strict]] [--govern-scope workspace|changed|baseline] [--autonomy legacy|guarded-local|guarded-git|guarded-deploy] [--contract FILE] [--execution-context FILE] [--deploy-policy project] [--profile NAME] [--expected-path P] [--action A] [--command-timeout-ms N] [--json]

Stages:
  intake -> plan -> execute-loop -> verify-review -> proof

guarded-git additionally performs:
  preflight risk -> local verification/review -> post-diff risk -> candidate proof -> commit -> PR/CI/merge -> final proof

guarded-deploy adds after merge:
  project allowlist -> staging verify/health -> production verify/health -> rollback/freeze -> final proof
`);
    return 0;
  }

  let prompt = firstPositionalValue(args, new Set([
    "--workspace",
    "--contract",
    "--execution-context",
    "--state",
    "--execute",
    "--verify",
    "--agent",
    "--capability",
    "--priority",
    "--max-iter",
    "--command-timeout-ms",
    "--worktree-root",
    "--govern",
    "--govern-scope",
    "--autonomy",
    "--deploy-policy",
    "--profile",
    "--role",
    "--reviewer",
    "--checker",
    "--expected-path",
    "--action",
  ]));
  let frozenContract: FrozenDeliveryContractV2 | undefined;
  const contractPath = flagValue(args, "--contract");
  try {
    if (contractPath !== undefined) {
      if ((await stat(contractPath)).size > 128 * 1024) throw new Error("delivery_contract_too_large");
      frozenContract = freezeDeliveryContract(JSON.parse(await readFile(contractPath, "utf8")));
      prompt ??= frozenContract.contract.goal;
    }
  } catch (error) { return deliverBlocked(args, "invalid_delivery_contract", error instanceof Error ? error.message : String(error)); }
  if (prompt === undefined) {
    console.error("osstack: deliver requires a prompt");
    return 1;
  }
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const policyGate = await deps.enforceObservePolicyGate(workspacePath);
  if (policyGate !== undefined) return policyGate;
  const autonomyResult = DeliverAutonomyMode.safeParse(
    flagValue(args, "--autonomy") ?? "legacy",
  );
  if (!autonomyResult.success) {
    console.error(
      "osstack: --autonomy must be legacy, guarded-local, guarded-git, or guarded-deploy",
    );
    return 1;
  }
  const autonomy = autonomyResult.data;
  const guardedLocal = autonomy === "guarded-local";
  const guardedDeploy = autonomy === "guarded-deploy";
  const guardedGit = autonomy === "guarded-git" || guardedDeploy;
  const guarded = guardedLocal || guardedGit;
  if (frozenContract && (!guarded || frozenContract.contract.mode === "scout" || flagValue(args, "--execute") !== undefined))
    return deliverBlocked(args, "delivery_contract_runtime_unsupported", "V2 requires a guarded implement adapter; scout lacks a proven tool-free executor");
  if (frozenContract && guardedLocal && frozenContract.contract.requested_completion !== "local_verified")
    return deliverBlocked(args, "delivery_contract_completion_conflict", "guarded-local only produces a local candidate proof");
  const deployPolicy = flagValue(args, "--deploy-policy");
  if (
    guardedDeploy
    && deployPolicy !== "project"
  ) {
    return deliverBlocked(
      args,
      "deploy_policy_required",
      "guarded-deploy requires --deploy-policy project",
    );
  }
  if (
    deployPolicy !== undefined
    && (deployPolicy !== "project" || !guardedDeploy)
  ) {
    return deliverBlocked(
      args,
      "deploy_policy_invalid",
      "--deploy-policy project is valid only with --autonomy guarded-deploy",
    );
  }
  const stateFilePath = flagValue(args, "--state") ?? "LOOP-STATE.json";
  const executeCommand = flagValue(args, "--execute");
  let agentId = flagValue(args, "--agent");
  let verifierAgentIds = [
    ...flagValues(args, "--reviewer"),
    ...flagValues(args, "--checker"),
  ];
  const capability = flagValue(args, "--capability") ?? "code.write";
  const priority = parsePositiveIntegerFlag(
    flagValue(args, "--priority"),
    "--priority",
  );
  if (priority instanceof Error) {
    console.error(`osstack: ${priority.message}`);
    return 1;
  }
  const maxIterations = parsePositiveIntegerFlag(
    flagValue(args, "--max-iter"),
    "--max-iter",
  );
  if (maxIterations instanceof Error) {
    console.error(`osstack: ${maxIterations.message}`);
    return 1;
  }
  const commandTimeoutMs = parsePositiveIntegerFlag(
    flagValue(args, "--command-timeout-ms"),
    "--command-timeout-ms",
  );
  if (commandTimeoutMs instanceof Error) {
    console.error(`osstack: ${commandTimeoutMs.message}`);
    return 1;
  }
  const effectiveCommandTimeoutMs = commandTimeoutMs
    ?? (guarded ? GUARDED_LOCAL_COMMAND_TIMEOUT_MS : undefined);
  const explicitVerifyCommands = flagValues(args, "--verify");
  const suggestedVerify = await suggestVerifyCommand(
    workspacePath,
    { includeYarn: guarded },
  );
  let verifyCommands = guarded
    && explicitVerifyCommands.length === 0
    && suggestedVerify !== undefined
    ? [suggestedVerify]
    : explicitVerifyCommands;
  let contractPolicy: Awaited<ReturnType<NonNullable<DeliverCommandDeps["deliveryContractPolicy"]>>> | undefined;
  if (frozenContract) {
    if (!deps.deliveryContractPolicy) return deliverBlocked(args, "delivery_contract_policy_unavailable", "host policy binding is required");
    try {
      contractPolicy = await deps.deliveryContractPolicy(realpathSync(workspacePath));
      if (!contractPolicy.budget || [contractPolicy.budget.max_builder_iterations, contractPolicy.budget.max_review_rounds, contractPolicy.budget.max_wall_time_ms, contractPolicy.budget.max_no_progress_rounds].some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error("delivery_contract_budget_invalid");
      if (explicitVerifyCommands.some(command => !contractPolicy!.verifyCommands.includes(command))) throw new Error("delivery_check_not_registered");
      verifyCommands = [...new Set(contractPolicy.verifyCommands)];
      if (contractPolicy.budgetRef !== frozenContract.contract.budget_ref) throw new Error("delivery_contract_budget_ref_mismatch");
      for (const [flag, allowed] of [["--expected-path", frozenContract.contract.allowed_paths], ["--action", frozenContract.contract.requested_actions]] as const) {
        const explicit = flagValues(args, flag);
        if (explicit.length && JSON.stringify([...new Set(explicit)].sort()) !== JSON.stringify([...allowed].sort())) throw new Error(`delivery_contract_cli_conflict:${flag}`);
      }
    } catch (error) { return deliverBlocked(args, "delivery_contract_policy_failed", error instanceof Error ? error.message : String(error)); }
  }
  if (guarded && verifyCommands.length === 0) {
    return deliverBlocked(
      args,
      "verify_profile_missing",
      `${autonomy} requires --verify or a detected project test command`,
    );
  }
  if (guarded && !await isGitWorktree(workspacePath)) {
    return deliverBlocked(
      args,
      "git_worktree_required",
      `${autonomy} requires a Git worktree`,
    );
  }
  const requestedGovernanceMode = parseDeliverGovernanceMode(args);
  if (requestedGovernanceMode instanceof Error) {
    console.error(`osstack: ${requestedGovernanceMode.message}`);
    return 1;
  }
  const governanceMode = guarded
    ? "strict"
    : requestedGovernanceMode;
  const governanceScope = parseDeliverGovernanceScope(
    args,
    governanceMode,
  );
  if (governanceScope instanceof Error) {
    console.error(`osstack: ${governanceScope.message}`);
    return 1;
  }
  if (
    governanceScope !== undefined
    && governanceScope !== "workspace"
    && deps.captureLoopGovernanceBaseline === undefined
  ) {
    console.error(
      "osstack: changed and baseline governance scopes are unavailable",
    );
    return 1;
  }
  const governanceBaseline =
    governanceScope === "baseline" || governanceScope === "changed"
      ? await deps.captureLoopGovernanceBaseline!(
          workspacePath,
          governanceScope === "baseline",
        )
      : undefined;
  const autoAgent = args.includes("--auto-agent");
  const useWorktree = guardedLocal || args.includes("--worktree");
  const checkpoint = args.includes("--checkpoint") && !useWorktree
    ? await deps.createShadowCheckpoint(realpathSync(workspacePath))
    : undefined;
  const adapters = guarded || agentId !== undefined || autoAgent
    ? deps.adapters?.() ?? defaultAdapters()
    : undefined;
  const profileRouting = guarded
    ? await resolveGuardedProfileRouting(
      args,
      agentId,
      verifierAgentIds,
      adapters!,
    )
    : undefined;
  if (profileRouting instanceof Error) {
    return deliverBlocked(
      args,
      "profile_routing_failed",
      profileRouting.message,
    );
  }
  if (profileRouting !== undefined) {
    agentId = profileRouting.agentId;
    verifierAgentIds = profileRouting.verifierAgentIds;
  }
  if (frozenContract) {
    try { assertDeliveryContractAdmission(frozenContract, { canonicalRepo: realpathSync(workspacePath),
      baseHead: (await deliveryGit(workspacePath, ["rev-parse", "HEAD"])).trim(), taskId: frozenContract.contract.task_id,
      goal: prompt, policyDigest: contractPolicy!.policyDigest, reviewPolicyRef: `profile:${profileRouting!.summary.profile_name}`, acceptedCommands: verifyCommands }); }
    catch (error) { return deliverBlocked(args, "delivery_contract_admission_failed", error instanceof Error ? error.message : String(error)); }
  }
  if (guardedGit) {
    if (deps.startGuardedGit === undefined || profileRouting === undefined) {
      return deliverBlocked(
        args,
        "guarded_git_unavailable",
        "guarded-git runtime is not configured",
      );
    }
    const taskId = frozenContract?.contract.task_id ?? `task_${randomUUID().slice(0, 8)}`;
    let guardedResult: GuardedDeliveryResult;
    try {
      guardedResult = await deps.startGuardedGit({
        prompt,
        workspacePath: realpathSync(workspacePath),
        taskId,
        capability,
        expectedPaths: frozenContract?.contract.allowed_paths ?? flagValues(args, "--expected-path"),
        requestedActions: frozenContract?.contract.requested_actions ?? (
          flagValues(args, "--action").length === 0
            ? [
                "build",
                "commit",
                ...(guardedDeploy
                  ? ["deploy:production", "deploy:staging"]
                  : []),
                "merge",
                "push",
                "verify",
              ]
            : flagValues(args, "--action")),
        verifyCommands,
        commandTimeoutMs: effectiveCommandTimeoutMs!,
        ...(guardedDeploy
          ? { deployPolicy: "project" as const }
          : {}),
        profileRouting,
        ...(frozenContract ? { frozenContract } : {}),
        ...(flagValue(args, "--execution-context") ? { executionContextPath: flagValue(args, "--execution-context")! } : {}),
      });
    } catch (error) {
      return deliverBlocked(
        args,
        "guarded_git_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    const summary = {
      autonomy,
      autonomy_run_id: guardedResult.run.autonomy_run_id,
      state: guardedResult.run.state,
      status: guardedResult.status,
      profile: profileRouting.summary,
      ...(guardedResult.approval_request === undefined
        ? {}
        : { approval_request: guardedResult.approval_request }),
      ...(guardedResult.reason === undefined
        ? {}
        : { reason: guardedResult.reason }),
      candidate_proof:
        guardedResult.run.context.candidate_proof ?? null,
      git_delivery:
        guardedResult.run.context.git_delivery ?? null,
      deploy_eligibility:
        guardedResult.run.context.deploy_eligibility ?? null,
      deploy_outcome:
        guardedResult.run.context.deploy_outcome ?? null,
      deploy_staging:
        guardedResult.run.context.deploy_staging ?? null,
      deploy_production:
        guardedResult.run.context.deploy_production ?? null,
      production_freeze:
        guardedResult.run.context.production_freeze ?? null,
      final_proof: guardedResult.run.context.final_proof ?? null,
    };
    if (args.includes("--json")) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`autonomy_run_id=${summary.autonomy_run_id}`);
      console.log(`state=${summary.state}`);
      console.log(`status=${summary.status}`);
    }
    return guardedResult.status === "completed" ? 0 : 2;
  }
  const stages = [
    "intake",
    "plan",
    "execute-loop",
    "verify-review",
    "proof",
  ];
  const task = await enqueueTask({
    workspacePath,
    prompt,
    capability,
    ...(frozenContract ? { taskId: frozenContract.contract.task_id } : {}),
    ...(priority !== undefined ? { priority } : {}),
    context: {
      deliver_pipeline: {
        stages,
        ...(frozenContract ? { delivery_contract: frozenContract } : {}),
        suggested_verify: suggestedVerify,
        verify_commands: verifyCommands,
        ...(effectiveCommandTimeoutMs !== undefined
          ? { command_timeout_ms: effectiveCommandTimeoutMs }
          : {}),
        auto_agent: autoAgent,
        ...(guarded
          ? {
              autonomy_mode: autonomy,
              profile_routing: profileRouting?.summary,
            }
          : {}),
      },
    },
  });
  const worktreeRoot = flagValue(args, "--worktree-root");
  let receiptRef: DeliveryReceiptReferenceV2 | undefined;
  let candidateWorkspace: string | undefined;
  let candidateGovernance: DeliverGovernanceEvidence | undefined;
  const evidenceRoot = join(workspacePath, ".osstack", "delivery-contracts", frozenContract?.digest ?? "legacy");
  const contextPath = flagValue(args, "--execution-context");
  let executionContext: Awaited<ReturnType<NonNullable<DeliverCommandDeps["createExecutionContext"]>>> | undefined;
  if (contextPath) {
    if (!deps.createExecutionContext || !adapters) return deliverBlocked(args, "execution_context_unavailable", "host execution context is not configured");
    executionContext = await deps.createExecutionContext({ adapters, workspacePath: realpathSync(workspacePath), configPath: contextPath,
      ...(frozenContract ? { contractDigest: frozenContract.digest, contractBrief: frozenContract.brief } : {}) });
  }
  const localContract = frozenContract;
  const verificationFence = localContract ? createDeliveryVerificationFence(localContract) : undefined;
  const engine = new LoopEngine({
    workspacePath,
    stateFilePath,
    ...(executeCommand !== undefined ? { executeCommand } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(autoAgent ? { autoAgent } : {}),
    ...(adapters !== undefined ? { adapters: executionContext?.adapters ?? adapters } : {}),
    ...(verifyCommands.length > 0 ? { verifyCommands } : {}),
    ...(guardedLocal
      ? {
          verifierAgentIds,
          enforceRoleSeparation: true,
          ...(profileRouting !== undefined
            ? { profileRouting: profileRouting.summary }
            : {}),
          artifactVerification: { requireGitDiff: true },
        }
      : {}),
    sources: localContract ? [] : ["task_queue"],
    ...(localContract ? { prepareVerification: verificationFence!.prepare, verificationFence: verificationFence!, inputTasks: [{ ...task.task, prompt: executionContext ? prompt : `${prompt}\n\n${localContract.brief}` }],
      guardedLocalCandidate: { mode: "artifact_only" as const, inspect: async (input: { workspacePath: string; run: { run_id: string; agent_id: string };
        verdict: { verify_commands?: import("@osstack/loop").CommandAudit[] | undefined }; reviews: readonly import("@osstack/loop").ReviewArtifact[] }) => {
        const currentPolicy = await deps.deliveryContractPolicy!(realpathSync(workspacePath));
        if (currentPolicy.policyDigest !== localContract.contract.policy_digest || currentPolicy.budgetRef !== localContract.contract.budget_ref)
          throw new Error("delivery_contract_policy_changed");
        await verificationFence!.assertVerified(input.workspacePath);
        candidateGovernance = await deps.createLoopGovernanceEvidence("strict", input.workspacePath, governanceScope ?? "workspace", governanceBaseline);
        if (candidateGovernance.blocking) throw new Error("delivery_candidate_governance_blocked");
        await verificationFence!.assertVerified(input.workspacePath);
        const { stageGuardedCandidate } = await import("@osstack/autonomy");
        const staged = await stageGuardedCandidate({ workspace_path: input.workspacePath, expected_base_commit_sha: localContract.contract.base_head, commands: verifyCommands, hardened: true });
        assertDeliveryContractPaths(localContract, staged.changed_paths);
        const candidate = await captureDeliveryCandidate(input.workspacePath, localContract.contract.base_head);
        const receipt = buildDeliveryVerificationReceipt({ frozen: localContract, runId: input.run.run_id, runKind: "guarded-local", candidate,
          workspaceStateDigest: await verificationFence!.assertVerified(input.workspacePath), commands: input.verdict.verify_commands ?? [], reviews: input.reviews, builderAgentId: input.run.agent_id,
          builderIdentity: { ...profileRouting!.summary.builder_identity }, contextReceiptRefs: executionContext?.receiptRefs() ?? [] });
        const ref = await persistDeliveryHostRecord(evidenceRoot, receipt);
        await verifyPersistedDeliveryReceipt({ root: evidenceRoot, ref, frozen: localContract, runId: input.run.run_id, workspace: input.workspacePath });
        receiptRef = ref; candidateWorkspace = input.workspacePath;
      } }, lessonDrafts: { enabled: false } } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(effectiveCommandTimeoutMs !== undefined
      ? { commandTimeoutMs: effectiveCommandTimeoutMs }
      : {}),
    ...(localContract ? { budget: {
      max_task_iterations: Math.min(contractPolicy!.budget.max_builder_iterations, contractPolicy!.budget.max_review_rounds),
      max_runtime_ms: contractPolicy!.budget.max_wall_time_ms, no_progress_limit: contractPolicy!.budget.max_no_progress_rounds,
    }, maxIterations: Math.min(maxIterations ?? 1, contractPolicy!.budget.max_builder_iterations, contractPolicy!.budget.max_review_rounds),
    commandTimeoutMs: Math.min(effectiveCommandTimeoutMs ?? GUARDED_LOCAL_COMMAND_TIMEOUT_MS, contractPolicy!.budget.max_wall_time_ms) } : {}),
    ...(useWorktree ? { useWorktree: true } : {}),
    ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
    policyGate: makePolicyGate(workspacePath),
  });
  const result = await engine.runOnce();
  const artifactArgs = ensureFlags(
    args,
    ["--report", "--scorecard", "--proof"],
  );
  const governance = candidateGovernance ?? (governanceMode === undefined
    ? undefined
    : await deps.createLoopGovernanceEvidence(
      governanceMode,
      workspacePath,
      governanceScope ?? "workspace",
      governanceBaseline,
    ));
  const events = governance === undefined
    ? result.events
    : deps.appendGovernanceVerifyEvent(
      result.events,
      result.loop_id,
      governance,
    );
  const probeObservation = await deps.observeLoopProbeEvents(
    workspacePath,
    events,
  );
  const artifacts = await deps.writeRequestedLoopArtifacts(
    result.state,
    workspacePath,
    artifactArgs,
    events,
    governance,
  );
  const learnedLessons = await deps.learnLessonsFromLoopState(result.state);
  const contractSucceeded = receiptRef !== undefined && result.state.completed_tasks.length === 1
    && result.state.completed_tasks.every(completed => completed.outcome === "success") && governance?.blocking !== true && result.budget?.exceeded !== true;
  const summary = {
    ...(localContract ? { delivery_contract: { digest: localContract.digest, brief: localContract.brief,
      achieved_completion: contractSucceeded ? "local_verified" : null, verification_receipt: receiptRef ?? null,
      candidate_workspace: candidateWorkspace ?? result.completedTasks.find(completed => completed.worktree_path)?.worktree_path ?? null, qualification: "local_host_receipt_only" } } : {}),
    prompt,
    stages,
    suggested_verify: suggestedVerify,
    verify_commands: verifyCommands,
    task: task.task,
    task_path: task.path,
    loop_id: result.loop_id,
    json_path: result.jsonPath,
    markdown_path: result.markdownPath,
    completed_tasks: result.state.completed_tasks,
    events,
    ...(guardedLocal
      ? {
          autonomy,
          profile: profileRouting?.summary,
        }
      : {}),
    ...(probeObservation === undefined
      ? {}
      : { probe_observation: probeObservation }),
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...(artifacts !== undefined ? { artifacts } : {}),
    ...(governance !== undefined ? { governance } : {}),
    ...(learnedLessons !== undefined
      ? { learned_lessons: learnedLessons }
      : {}),
    ...(result.state.key_metrics !== undefined
      ? { metrics: result.state.key_metrics }
      : {}),
  };
  if (args.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`deliver=${result.loop_id}`);
    console.log(`task=${task.path}`);
    if (suggestedVerify !== undefined) {
      console.log(`suggested_verify=${suggestedVerify}`);
    }
    if (governance !== undefined) {
      console.log(
        `governance=${governance.status} mode=${governance.mode} blocking=${governance.blocking ? "yes" : "no"}`,
      );
    }
    if (artifacts?.report !== undefined) {
      console.log(`report=${artifacts.report}`);
    }
    if (artifacts?.proof_dir !== undefined) {
      console.log(`proof=${artifacts.proof_dir}`);
    }
  }
  return (localContract !== undefined && !contractSucceeded) || result.state.completed_tasks.some(
    (completed) => completed.outcome !== "success",
  ) || governance?.blocking === true
    ? 2
    : 0;
}

function ensureFlags(args: string[], flags: string[]): string[] {
  const next = [...args];
  for (const flag of flags) {
    if (!next.includes(flag)) next.push(flag);
  }
  return next;
}

export async function suggestVerifyCommand(
  workspacePath: string,
  options: { includeYarn?: boolean } = {},
): Promise<string | undefined> {
  if (await fileExists(join(workspacePath, "pnpm-lock.yaml"))) {
    return "pnpm test";
  }
  if (
    await fileExists(join(workspacePath, "bun.lockb"))
    || await fileExists(join(workspacePath, "bun.lock"))
  ) {
    return "bun test";
  }
  if (await fileExists(join(workspacePath, "package-lock.json"))) {
    return "npm test";
  }
  if (
    options.includeYarn === true
    && await fileExists(join(workspacePath, "yarn.lock"))
  ) {
    return "yarn test";
  }
  try {
    const packageJson = JSON.parse(
      await readFile(join(workspacePath, "package.json"), "utf-8"),
    ) as unknown;
    if (
      isRecord(packageJson)
      && isRecord(packageJson["scripts"])
      && typeof packageJson["scripts"]["test"] === "string"
    ) {
      return "npm test";
    }
  } catch {
    // No package.json or unreadable package metadata.
  }
  return undefined;
}

async function resolveGuardedProfileRouting(
  args: string[],
  agentId: string | undefined,
  verifierAgentIds: readonly string[],
  adapters: AgentAdapter[],
): Promise<LoopProfileRoutingResult | Error> {
  const resolution = await resolveLoopProfileRouting(
    args,
    agentId,
    verifierAgentIds,
    { adapters: () => adapters },
  );
  return resolution
    ?? new Error("guarded-local did not resolve an execution profile");
}

function deliverBlocked(
  args: string[],
  code: string,
  message: string,
): 2 {
  if (args.includes("--json")) {
    console.log(JSON.stringify({
      error: {
        code,
        message,
      },
    }, null, 2));
  } else {
    console.error(`osstack: [${code}] ${message}`);
  }
  return 2;
}

async function isGitWorktree(workspacePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspacePath, "rev-parse", "--is-inside-work-tree"],
      { timeout: 10_000 },
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

function parseDeliverGovernanceMode(
  args: string[],
): DeliverGovernanceMode | undefined | Error {
  const index = args.indexOf("--govern");
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) return "warn";
  if (value === "warn" || value === "strict") return value;
  return new Error("--govern must be warn or strict");
}

function parseDeliverGovernanceScope(
  args: string[],
  mode: DeliverGovernanceMode | undefined,
): DeliverGovernanceScope | undefined | Error {
  const index = args.indexOf("--govern-scope");
  if (index < 0) return mode === undefined ? undefined : "workspace";
  if (mode === undefined) {
    return new Error("--govern-scope requires --govern");
  }
  const value = args[index + 1];
  if (
    value === "workspace"
    || value === "changed"
    || value === "baseline"
  ) {
    return value;
  }
  return new Error(
    "--govern-scope must be workspace, changed, or baseline",
  );
}

function parsePositiveIntegerFlag(
  value: string | undefined,
  name: string,
): number | undefined | Error {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function firstPositionalValue(
  args: string[],
  flagsWithValues: Set<string>,
): string | undefined {
  return positionalValues(args, flagsWithValues)[0];
}

function positionalValues(
  args: string[],
  flagsWithValues: Set<string>,
): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (flagsWithValues.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("--")) continue;
    values.push(arg);
  }
  return values;
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length
    ? args[index + 1]
    : undefined;
}

function flagValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) {
      values.push(args[i + 1]!);
      i++;
    }
  }
  return values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
