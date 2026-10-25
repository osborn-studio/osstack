import { createHash } from "node:crypto";
import {
  AUTONOMY_EMPTY_DIFF_SHA256,
  FrozenDeliveryContractV2,
  DeliveryReceiptReferenceV2,
  AutonomyRiskDecision,
  type AutonomyRiskPhase,
  type AutonomyRiskSignal,
  type AutonomyRunState,
  ScopedApprovalDecision,
  ScopedApprovalRequest,
  validateScopedApprovalDecisionForRequest,
} from "@osstack/protocol";
import type {
  GitHubDeliveryInput,
  GitHubDeliveryResult,
} from "@osstack/github";
import {
  DeployTargetPolicy as DeployTargetPolicySchema,
  assertFrozenDeliveryContract,
  type DeployTargetPolicy,
} from "@osstack/core";
import { z } from "zod";
import {
  createScopedApprovalRequest,
  scopedApprovalDigest,
  verifyScopedApprovalDecision,
} from "./approval.js";
import {
  AttemptProgressSchema,
  evaluateProgressBudget,
} from "./progress-budget.js";
import {
  classifyPostDiffRisk,
  classifyPreflightRisk,
} from "./risk.js";
import {
  DeployEligibilityDecisionSchema,
  RollbackDrillEvidenceSchema,
  type DeployEligibilityDecision,
  type DeployEligibilityInput,
  type RollbackDrillEvidence,
} from "./deploy-policy.js";
import {
  DeployScriptAuthoritySchema,
  ProjectDeployResultSchema,
  type DeployScriptAuthority,
  type ProjectDeployInput,
  type ProjectDeployResult,
  type ProjectDeployPhase,
} from "./deploy-runner.js";
import {
  assertAutonomyTransition,
  type AutonomyTransitionInput,
} from "./state-machine.js";
import {
  AutonomyTaskIntent,
  DeliveryBudget,
  PostDiffInput,
  type AutonomyTaskIntent as AutonomyTaskIntentType,
  type DeliveryBudget as DeliveryBudgetType,
  type PostDiffInput as PostDiffInputType,
} from "./types.js";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const GitCommitSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const GitHubDeliveryEvidence = z
  .object({
    pushedCommit: GitCommitSha,
    pr: z
      .object({
        number: z.number().int().positive(),
        url: z.string().url(),
        reused: z.boolean(),
      })
      .strict(),
    mergeCommit: GitCommitSha,
    mergedAt: z.string().datetime(),
  })
  .strict();

const RuntimeIdentity = z
  .object({
    provider_id: z.string().min(1),
    model_id: z.string().min(1),
    evidence_source: z.enum(["reported", "configured"]),
  })
  .strict();
export type RuntimeIdentity = z.infer<typeof RuntimeIdentity>;

export const ContractPullRequestEvidence = z.object({ pushedCommit: GitCommitSha,
  pr: z.object({ number: z.number().int().positive(), url: z.string().url(), reused: z.boolean() }).strict() }).strict();
export type ContractPullRequestEvidence = z.infer<typeof ContractPullRequestEvidence>;

export const LocalDeliveryResult = z
  .object({
    delivery_receipt: DeliveryReceiptReferenceV2.optional(),
    verification_passed: z.boolean(),
    review_passed: z.boolean(),
    post_diff: PostDiffInput,
    progress: AttemptProgressSchema,
    telemetry: z
      .object({
        reviewer_mutation_count: z.number().int().nonnegative(),
        unauthorized_action_count: z.number().int().nonnegative(),
        adapter_unavailable_count: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    builder_identity: RuntimeIdentity,
    evaluator_identity: RuntimeIdentity,
  })
  .strict();
export type LocalDeliveryResult = z.infer<typeof LocalDeliveryResult>;

export const ProofReference = z
  .object({
    manifest_path: z.string().min(1),
    manifest_sha256: Sha256,
  })
  .strict();
export type ProofReference = z.infer<typeof ProofReference>;

export interface CandidateProofInput {
  autonomy_run_id: string;
  intent: AutonomyTaskIntentType;
  preflight_risk: AutonomyRiskDecision;
  post_diff_risk: AutonomyRiskDecision;
  local_result: LocalDeliveryResult;
  delivery_contract?: FrozenDeliveryContractV2;
  delivery_receipt?: DeliveryReceiptReferenceV2;
  approval_request?: ScopedApprovalRequest;
  approval_decision?: ScopedApprovalDecision;
}

export interface FinalProofInput extends CandidateProofInput {
  candidate_proof: ProofReference;
  git_delivery: GitHubDeliveryResult;
  deploy_eligibility?: {
    staging?: DeployEligibilityDecision | undefined;
    production?: DeployEligibilityDecision | undefined;
  };
  deploy_script_authority?: {
    staging?: DeployScriptAuthority | undefined;
    production?: DeployScriptAuthority | undefined;
  };
  deploy_staging?: ProjectDeployResult | undefined;
  deploy_production?: ProjectDeployResult | undefined;
  production_freeze?: ProductionFreezeEvidence | undefined;
  deploy_outcome?: GuardedDeployOutcome | undefined;
}

export interface CommitInput {
  autonomy_run_id: string;
  workspace_path: string;
  diff_sha256: string;
  idempotency_key: string;
}

export const GuardedDeployPolicySchema = z
  .object({
    base_branch: z.string().min(1),
    staging: DeployTargetPolicySchema.optional(),
    production: DeployTargetPolicySchema.optional(),
    rollback_drill: RollbackDrillEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((deploy, context) => {
    if (
      deploy.production?.enabled === true
      && deploy.staging?.enabled !== true
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["production"],
        message: "enabled production deployment requires enabled staging",
      });
    }
  });
export type GuardedDeployPolicy = z.infer<
  typeof GuardedDeployPolicySchema
>;

export const ProductionFreezeEvidenceSchema = z
  .object({
    repo_id: z.string().min(1),
    reason: z.string().min(1),
    source_run_id: z.string().min(1),
    frozen_at: z.number().finite(),
  })
  .strict();
export type ProductionFreezeEvidence = z.infer<
  typeof ProductionFreezeEvidenceSchema
>;

export const GuardedDeployOutcomeSchema = z.enum([
  "staging_skipped",
  "staging_healthy",
  "staging_failed",
  "production_skipped",
  "production_healthy",
  "production_rolled_back",
  "rollback_failed",
]);
export type GuardedDeployOutcome = z.infer<
  typeof GuardedDeployOutcomeSchema
>;

const DeployEligibilityEvidenceSchema = z
  .object({
    staging: DeployEligibilityDecisionSchema.optional(),
    production: DeployEligibilityDecisionSchema.optional(),
  })
  .strict();

const DeployScriptAuthorityEvidenceSchema = z
  .object({
    staging: DeployScriptAuthoritySchema.optional(),
    production: DeployScriptAuthoritySchema.optional(),
  })
  .strict();

export const GuardedDeliveryContextSchema = z
  .object({
    delivery_contract: FrozenDeliveryContractV2.optional(),
    delivery_receipt: DeliveryReceiptReferenceV2.optional(),
    delivery_completion_receipt: DeliveryReceiptReferenceV2.optional(),
    achieved_completion: z.enum(["local_verified", "pr_opened", "merged", "deployed"]).optional(),
    pr_delivery: ContractPullRequestEvidence.optional(),
    intent: AutonomyTaskIntent.optional(),
    started_at: z.string().datetime().optional(),
    routing: z.unknown().optional(),
    budget: DeliveryBudget.optional(),
    preflight_risk: AutonomyRiskDecision.optional(),
    post_diff_risk: AutonomyRiskDecision.optional(),
    pending_approval_phase: z.enum(["preflight", "post_diff"]).optional(),
    approval_request: ScopedApprovalRequest.optional(),
    approval_decision: ScopedApprovalDecision.optional(),
    local_result: LocalDeliveryResult.optional(),
    builder_iterations: z.number().int().nonnegative().optional(),
    review_rounds: z.number().int().nonnegative().optional(),
    no_progress_rounds: z.number().int().nonnegative().optional(),
    candidate_proof: ProofReference.optional(),
    commit: z.object({ commit: GitCommitSha }).strict().optional(),
    git_delivery: GitHubDeliveryEvidence.optional(),
    deploy_eligibility: DeployEligibilityEvidenceSchema.optional(),
    deploy_script_authority:
      DeployScriptAuthorityEvidenceSchema.optional(),
    deploy_staging: ProjectDeployResultSchema.optional(),
    deploy_production: ProjectDeployResultSchema.optional(),
    production_freeze: ProductionFreezeEvidenceSchema.optional(),
    deploy_outcome: GuardedDeployOutcomeSchema.optional(),
    final_proof: ProofReference.optional(),
    blocked_delivery_resume_state: z.literal("pushing").optional(),
    failure: z
      .object({
        operation: z.string().min(1),
        message: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export type GuardedDeliveryContext = z.infer<
  typeof GuardedDeliveryContextSchema
>;

export interface AutonomyRunProjection {
  autonomy_run_id: string;
  state: AutonomyRunState;
  revision: number;
  context: GuardedDeliveryContext;
}

export interface GuardedDeliveryTransitionInput
  extends AutonomyTransitionInput {
  context_patch?: Partial<GuardedDeliveryContext>;
  recovery?: {
    kind: "restart";
  };
}

export interface GuardedDeliveryPorts {
  now(): Date;
  load(
    autonomyRunId: string,
  ): Promise<AutonomyRunProjection | undefined>;
  persist(
    event: GuardedDeliveryTransitionInput,
  ): Promise<AutonomyRunProjection>;
  runLocal(input: {
    workspacePath: string;
    runId?: string;
    contract?: FrozenDeliveryContractV2;
    routing: unknown;
    budget: DeliveryBudgetType;
  }): Promise<LocalDeliveryResult>;
  verifyContractReceipt?: (input: { contract: FrozenDeliveryContractV2; ref: DeliveryReceiptReferenceV2; runId: string; workspacePath: string; expectedHeads: string[] }) => Promise<void>;
  openPullRequest?: (input: GitHubDeliveryInput, scope: { repository: string; headCommit: string; draft: boolean }) => Promise<ContractPullRequestEvidence>;
  writeContractCompletionReceipt?: (input: { runId: string; contract: FrozenDeliveryContractV2; verificationReceipt: DeliveryReceiptReferenceV2;
    candidateProof: ProofReference; achievedCompletion: "local_verified" | "pr_opened"; publication?: ContractPullRequestEvidence }) => Promise<DeliveryReceiptReferenceV2>;
  writeCandidateProof(input: CandidateProofInput): Promise<ProofReference>;
  writeFinalProof(input: FinalProofInput): Promise<ProofReference>;
  commit(input: CommitInput): Promise<{ commit: string }>;
  deliverGit(input: GitHubDeliveryInput): Promise<GitHubDeliveryResult>;
  prepareMergedWorkspace?: (input: {
    workspace_path: string;
    remote: string;
    base: string;
    expected_merge_commit_sha: string;
  }) => Promise<void>;
  resolveDeployScriptAuthority?: (input: {
    workspace_path: string;
    policy: DeployTargetPolicy;
  }) => Promise<DeployScriptAuthority>;
  evaluateDeploy?: (
    policy: DeployTargetPolicy,
    input: DeployEligibilityInput,
  ) => DeployEligibilityDecision;
  deploy?: (input: ProjectDeployInput) => Promise<ProjectDeployResult>;
  isProductionFrozen?: (repoId: string) => Promise<boolean>;
  freezeProduction?: (input: {
    repo_id: string;
    reason: string;
    source_run_id: string;
    frozen_at: number;
  }) => Promise<ProductionFreezeEvidence>;
}

export interface GuardedDeliveryPolicy {
  delivery_contract?: FrozenDeliveryContractV2;
  policy_sha256: string;
  max_auto_risk?: "R1" | "R2";
  protected_policy_paths: readonly string[];
  routing: unknown;
  budget: DeliveryBudgetType;
  approval_ttl_ms: number;
  trusted_approval_public_keys: ReadonlyMap<string, string>;
  consume_approval_nonce(nonce: string): boolean;
  deploy?: GuardedDeployPolicy;
  git: {
    remote: string;
    base: string;
    branch: string;
    title: string;
    body_file: string;
    ci_timeout_ms: number;
  };
}

export interface GuardedDeliveryResult {
  status: "completed" | "needs_approval" | "blocked";
  run: AutonomyRunProjection;
  approval_request?: ScopedApprovalRequest;
  reason?: string;
}

interface AttemptState {
  builderIterations: number;
  reviewRounds: number;
  noProgressRounds: number;
  previous?: LocalDeliveryResult["progress"];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stagedDiffSha256(postDiff: PostDiffInputType): string {
  return createHash("sha256")
    .update(postDiff.staged_diff_binary)
    .digest("hex");
}

function approvalNonce(
  autonomyRunId: string,
  phase: AutonomyRiskPhase,
  scopeSha256: string,
): string {
  return createHash("sha256")
    .update(`${autonomyRunId}\0${phase}\0${scopeSha256}`)
    .digest("base64url");
}

function hasIndependentReportedEvaluator(
  result: LocalDeliveryResult,
): boolean {
  const builder = result.builder_identity;
  const evaluator = result.evaluator_identity;
  return (
    builder.evidence_source === "reported"
    && evaluator.evidence_source === "reported"
    && (
      builder.provider_id !== evaluator.provider_id
      || builder.model_id !== evaluator.model_id
    )
  );
}

function requiresIndependentEvaluator(
  ...decisions: Array<AutonomyRiskDecision | undefined>
): boolean {
  return decisions.some(
    (decision) =>
      decision?.level === "R2"
      || decision?.level === "R3",
  );
}

function riskSignalKey(signal: AutonomyRiskSignal): string {
  return [
    signal.rule_id,
    signal.path ?? "",
    signal.command ?? "",
    signal.level,
    signal.message,
  ].join("\u0000");
}

function carryPreflightR3IntoPostDiff(
  preflight: AutonomyRiskDecision,
  postDiff: AutonomyRiskDecision,
): AutonomyRiskDecision {
  if (
    preflight.level !== "R3"
    || postDiff.level === "R3"
    || postDiff.level === "R4"
  ) {
    return postDiff;
  }
  const carrySignal: AutonomyRiskSignal = {
    rule_id: "risk.preflight-r3-carry-forward",
    level: "R3",
    message:
      "preflight R3 authority requires a diff-bound post-diff approval",
  };
  return AutonomyRiskDecision.parse({
    ...postDiff,
    level: "R3",
    signals: [...postDiff.signals, carrySignal].sort((left, right) => {
      const leftKey = riskSignalKey(left);
      const rightKey = riskSignalKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
  });
}

export class GuardedDeliveryEngine {
  private readonly policy: GuardedDeliveryPolicy;
  private readonly ports: GuardedDeliveryPorts;

  constructor(
    policy: GuardedDeliveryPolicy,
    ports: GuardedDeliveryPorts,
  ) {
    this.policy = {
      ...policy,
      policy_sha256: Sha256.parse(policy.policy_sha256),
      max_auto_risk: policy.max_auto_risk ?? "R2",
      budget: DeliveryBudget.parse(policy.budget),
      ...(policy.deploy === undefined
        ? {}
        : { deploy: GuardedDeployPolicySchema.parse(policy.deploy) }),
    };
    if (
      !Number.isInteger(policy.approval_ttl_ms)
      || policy.approval_ttl_ms < 1_000
      || policy.approval_ttl_ms > 86_400_000
    ) {
      throw new Error("approval_ttl_ms must be between 1000 and 86400000");
    }
    if (
      policy.deploy !== undefined
      && policy.deploy.base_branch !== policy.git.base
    ) {
      throw new Error(
        "deploy base_branch must match the guarded Git merge base",
      );
    }
    this.ports = ports;
  }

  async start(intentValue: AutonomyTaskIntentType): Promise<GuardedDeliveryResult> {
    const intent = AutonomyTaskIntent.parse(intentValue);
    const contract = this.policy.delivery_contract === undefined ? undefined : assertFrozenDeliveryContract(this.policy.delivery_contract);
    if (contract && (contract.digest !== intent.contract_sha256 || contract.contract.policy_digest !== this.policy.policy_sha256
      || contract.contract.canonical_repo !== intent.workspace_path || contract.contract.task_id !== intent.task_id || contract.contract.goal !== intent.goal
      || contract.contract.mode !== "implement" || contract.contract.requested_completion === "deployed" && this.policy.deploy === undefined))
      throw new Error("delivery_contract_intent_mismatch");
    const startedAt = this.ports.now().toISOString();
    let run: AutonomyRunProjection = {
      autonomy_run_id: intent.autonomy_run_id,
      state: "queued",
      revision: 0,
      context: {
        intent,
        ...(contract ? { delivery_contract: contract } : {}),
        started_at: startedAt,
        routing: this.policy.routing,
        budget: this.policy.budget,
        builder_iterations: 0,
        review_rounds: 0,
        no_progress_rounds: 0,
      },
    };
    run = await this.transition(run, "classifying", {
      context_patch: run.context,
    });

    const risk = classifyPreflightRisk(intent, {
      policy_sha256: this.policy.policy_sha256,
      now: () => this.ports.now().toISOString(),
      repo_id: intent.repo_id,
      protected_policy_paths: this.policy.protected_policy_paths,
    });
    if (risk.level === "R0" && !contract) {
      run = await this.transition(run, "completed", {
        risk_level: risk.level,
        risk_phase: "preflight",
        context_patch: { preflight_risk: risk },
      });
      return { status: "completed", run };
    }
    if (risk.level === "R4") {
      run = await this.transition(run, "blocked", {
        risk_level: risk.level,
        risk_phase: "preflight",
        context_patch: { preflight_risk: risk },
      });
      return {
        status: "blocked",
        run,
        reason: "R4 policy denial is permanent and cannot be approved",
      };
    }
    if (risk.level === "R3") {
      return await this.waitForApproval(run, risk, "preflight");
    }
    if (
      risk.level === "R2"
      && this.policy.max_auto_risk === "R1"
    ) {
      return await this.escalate(
        run,
        "R2 exceeds repository max_auto_risk R1",
        { preflight_risk: risk },
      );
    }

    run = await this.transition(run, "preparing", {
      risk_level: risk.level,
      risk_phase: "preflight",
      context_patch: { preflight_risk: risk },
    });
    return await this.runLocalAndClassify(run);
  }

  async resume(
    autonomyRunId: string,
    decision?: ScopedApprovalDecision,
  ): Promise<GuardedDeliveryResult> {
    const loaded = await this.ports.load(autonomyRunId);
    if (loaded === undefined) {
      throw new Error(`autonomy run ${autonomyRunId} was not found`);
    }
    if (Boolean(loaded.context.delivery_contract) !== Boolean(this.policy.delivery_contract)) throw new Error("delivery_contract_resume_mismatch");
    if (loaded.context.delivery_contract) {
      const contract = assertFrozenDeliveryContract(loaded.context.delivery_contract);
      if (contract.digest !== loaded.context.intent?.contract_sha256 || contract.contract.policy_digest !== this.policy.policy_sha256
        || !this.policy.delivery_contract || assertFrozenDeliveryContract(this.policy.delivery_contract).digest !== contract.digest)
        throw new Error("delivery_contract_resume_mismatch");
    }
    if (loaded.state === "completed") {
      return { status: "completed", run: loaded };
    }
    if (loaded.state === "awaiting_approval") {
      if (decision === undefined) {
        return {
          status: "needs_approval",
          run: loaded,
          ...(loaded.context.approval_request === undefined
            ? {}
            : { approval_request: loaded.context.approval_request }),
        };
      }
      return await this.resumeApproval(loaded, decision);
    }
    if (loaded.state === "blocked_delivery") {
      if (loaded.context.blocked_delivery_resume_state !== "pushing") {
        return await this.escalate(
          loaded,
          "blocked delivery is missing its persisted resume state",
        );
      }
      const run = await this.transition(loaded, "pushing", {
        blocked_delivery_resume_state: "pushing",
      });
      return await this.deliverGitAndFinalize(run);
    }
    if (loaded.state === "final_proof" && loaded.context.delivery_contract
      && ["local_verified", "pr_opened"].includes(loaded.context.delivery_contract.contract.requested_completion)) return await this.completeLimitedContract(loaded);
    if (loaded.state === "opening_pr" && loaded.context.pr_delivery) return await this.completeLimitedContract(loaded);
    if (loaded.state === "candidate_proof") {
      return await this.writeCandidateAndDeliver(loaded);
    }
    if (loaded.state === "committing") {
      return await this.commitAndDeliver(loaded);
    }
    if (loaded.state === "pushing") {
      return await this.deliverGitAndFinalize(loaded);
    }
    if (
      loaded.state === "opening_pr"
      || loaded.state === "waiting_ci"
      || loaded.state === "merging"
    ) {
      return await this.continuePersistedGitDelivery(loaded);
    }
    if (
      loaded.state === "deploying_staging"
      || loaded.state === "verifying_staging"
      || loaded.state === "deploying_production"
      || loaded.state === "health_checking"
      || loaded.state === "rolling_back"
    ) {
      return await this.recoverDeployState(loaded);
    }
    if (loaded.state === "deploy_frozen") {
      const finalProof = await this.transition(loaded, "final_proof");
      return await this.writeFinalAndComplete(finalProof);
    }
    if (loaded.state === "final_proof") {
      return await this.writeFinalAndComplete(loaded);
    }
    if (loaded.state === "preparing") {
      return await this.runLocalAndClassify(loaded);
    }
    if (
      loaded.state === "blocked"
      || loaded.state === "delivery_evidence_failed"
      || loaded.state === "escalated"
      || loaded.state === "cancelled"
    ) {
      return {
        status: "blocked",
        run: loaded,
        reason: `autonomy run is terminal in ${loaded.state}`,
      };
    }
    return await this.escalateRecoveredState(loaded);
  }

  private async resumeApproval(
    run: AutonomyRunProjection,
    decision: ScopedApprovalDecision,
  ): Promise<GuardedDeliveryResult> {
    const request = run.context.approval_request;
    const intent = this.requireIntent(run);
    if (request === undefined) {
      return await this.escalate(
        run,
        "awaiting_approval has no persisted approval request",
      );
    }
    const localResult = run.context.local_result;
    const currentDiffSha256 =
      request.phase === "preflight"
        ? AUTONOMY_EMPTY_DIFF_SHA256
        : localResult === undefined
          ? undefined
          : stagedDiffSha256(localResult.post_diff);
    if (currentDiffSha256 === undefined) {
      return await this.escalate(
        run,
        "post-diff approval has no authoritative staged diff",
      );
    }
    const verified = verifyScopedApprovalDecision(request, decision, {
      expected: {
        autonomy_run_id: run.autonomy_run_id,
        phase: request.phase,
        contract_sha256: intent.contract_sha256,
        diff_sha256: currentDiffSha256,
        action_scope: this.approvalActionScope(request.phase, run),
      },
      trusted_public_keys: this.policy.trusted_approval_public_keys,
      now: () => this.ports.now().toISOString(),
      consume_nonce: this.policy.consume_approval_nonce,
    });
    if (verified.decision.payload.decision === "reject") {
      const cancelled = await this.transition(run, "cancelled", {
        context_patch: { approval_decision: decision },
      });
      return {
        status: "blocked",
        run: cancelled,
        reason: "Owner rejected the scoped approval request",
      };
    }

    const destination =
      request.phase === "preflight" ? "preparing" : "candidate_proof";
    const resumed = await this.transition(run, destination, {
      verified_approval: verified,
      pending_approval_phase: request.phase,
      context_patch: {
        approval_decision: decision,
        pending_approval_phase: request.phase,
      },
    });
    return request.phase === "preflight"
      ? await this.runLocalAndClassify(resumed)
      : await this.writeCandidateAndDeliver(resumed);
  }

  private async runLocalAndClassify(
    initial: AutonomyRunProjection,
  ): Promise<GuardedDeliveryResult> {
    const intent = this.requireIntent(initial);
    const preflightRisk = this.requirePreflightRisk(initial);
    const budget = DeliveryBudget.parse(
      initial.context.budget ?? this.policy.budget,
    );
    const attempts: AttemptState = {
      builderIterations: initial.context.builder_iterations ?? 0,
      reviewRounds: initial.context.review_rounds ?? 0,
      noProgressRounds: initial.context.no_progress_rounds ?? 0,
      ...(initial.context.local_result === undefined
        ? {}
        : { previous: initial.context.local_result.progress }),
    };
    let run = initial;

    while (true) {
      if (run.state === "preparing" || run.state === "repairing") {
        run = await this.transition(run, "building");
      }
      if (run.state !== "building") {
        return await this.escalate(
          run,
          `cannot invoke local delivery from recovered state ${run.state}`,
        );
      }

      let localResult: LocalDeliveryResult;
      try {
        localResult = LocalDeliveryResult.parse(
          await this.ports.runLocal({
            workspacePath: intent.workspace_path,
            ...(run.context.delivery_contract ? { runId: run.autonomy_run_id, contract: run.context.delivery_contract } : {}),
            routing: run.context.routing ?? this.policy.routing,
            budget,
          }),
        );
      } catch (error) {
        return await this.escalate(
          run,
          `local delivery port failed: ${errorMessage(error)}`,
        );
      }
      if (run.context.delivery_contract && localResult.verification_passed && localResult.review_passed) {
        try { await this.verifyContract(run, localResult.delivery_receipt); }
        catch (error) { return await this.escalate(run, `contract receipt rejected: ${errorMessage(error)}`); }
      }
      attempts.builderIterations += 1;
      run = await this.transition(run, "verifying", {
        context_patch: {
          local_result: localResult,
          ...(localResult.delivery_receipt ? { delivery_receipt: localResult.delivery_receipt } : {}),
          builder_iterations: attempts.builderIterations,
        },
      });

      if (!localResult.verification_passed) {
        run = await this.transition(run, "repairing");
      } else {
        attempts.reviewRounds += 1;
        run = await this.transition(run, "reviewing", {
          context_patch: { review_rounds: attempts.reviewRounds },
        });
        if (
          requiresIndependentEvaluator(preflightRisk)
          && !hasIndependentReportedEvaluator(localResult)
        ) {
          return await this.escalate(
            run,
            "R2/R3 requires an independent evaluator with reported provider-or-model evidence",
          );
        }
        if (localResult.review_passed) {
          return await this.postClassify(run, localResult);
        }
        run = await this.transition(run, "repairing");
      }

      const elapsed = Math.max(
        0,
        this.ports.now().getTime()
          - Date.parse(run.context.started_at ?? this.ports.now().toISOString()),
      );
      const progress = evaluateProgressBudget({
        budget,
        builder_iterations: attempts.builderIterations,
        review_rounds: attempts.reviewRounds,
        elapsed_ms: elapsed,
        prior_no_progress_rounds: attempts.noProgressRounds,
        ...(attempts.previous === undefined
          ? {}
          : { previous: attempts.previous }),
        current: localResult.progress,
      });
      attempts.noProgressRounds = progress.no_progress_rounds;
      attempts.previous = localResult.progress;
      if (progress.exhausted) {
        return await this.escalate(
          run,
          progress.reasons.join("; "),
          { no_progress_rounds: attempts.noProgressRounds },
        );
      }
      run = await this.transition(run, "building", {
        context_patch: {
          no_progress_rounds: attempts.noProgressRounds,
        },
      });
    }
  }

  private async postClassify(
    reviewing: AutonomyRunProjection,
    localResult: LocalDeliveryResult,
  ): Promise<GuardedDeliveryResult> {
    const intent = this.requireIntent(reviewing);
    let run = await this.transition(reviewing, "post_classifying");
    const risk = carryPreflightR3IntoPostDiff(
      this.requirePreflightRisk(reviewing),
      classifyPostDiffRisk(localResult.post_diff, {
        policy_sha256: this.policy.policy_sha256,
        now: () => this.ports.now().toISOString(),
        repo_id: intent.repo_id,
        protected_policy_paths: this.policy.protected_policy_paths,
      }),
    );
    if (
      requiresIndependentEvaluator(risk)
      && !hasIndependentReportedEvaluator(localResult)
    ) {
      return await this.escalate(
        run,
        "post-diff R2/R3 requires an independent evaluator with reported provider-or-model evidence",
        { post_diff_risk: risk },
      );
    }
    if (risk.level === "R4") {
      run = await this.transition(run, "blocked", {
        risk_level: risk.level,
        risk_phase: "post_diff",
        context_patch: { post_diff_risk: risk },
      });
      return {
        status: "blocked",
        run,
        reason: "post-diff R4 policy denial is permanent",
      };
    }
    if (risk.level === "R3") {
      return await this.waitForApproval(run, risk, "post_diff");
    }
    if (
      risk.level === "R2"
      && this.policy.max_auto_risk === "R1"
    ) {
      return await this.escalate(
        run,
        "post-diff R2 exceeds repository max_auto_risk R1",
        { post_diff_risk: risk },
      );
    }
    run = await this.transition(run, "candidate_proof", {
      risk_level: risk.level,
      risk_phase: "post_diff",
      context_patch: { post_diff_risk: risk },
    });
    return await this.writeCandidateAndDeliver(run);
  }

  private async waitForApproval(
    run: AutonomyRunProjection,
    risk: AutonomyRiskDecision,
    phase: AutonomyRiskPhase,
  ): Promise<GuardedDeliveryResult> {
    const intent = this.requireIntent(run);
    const now = this.ports.now();
    const diffSha256 =
      phase === "preflight"
        ? AUTONOMY_EMPTY_DIFF_SHA256
        : stagedDiffSha256(this.requireLocalResult(run).post_diff);
    const actionScope = this.approvalActionScope(phase, run);
    const request = createScopedApprovalRequest({
      approval_id: `approval:${run.autonomy_run_id}:${phase}:${risk.input_sha256.slice(0, 16)}`,
      autonomy_run_id: run.autonomy_run_id,
      phase,
      contract_sha256: intent.contract_sha256,
      diff_sha256: diffSha256,
      action_scope: actionScope,
      risk: "R3",
      nonce: approvalNonce(run.autonomy_run_id, phase, diffSha256),
      requested_at: now.toISOString(),
      expires_at: new Date(
        now.getTime() + this.policy.approval_ttl_ms,
      ).toISOString(),
    });
    const waiting = await this.transition(run, "awaiting_approval", {
      risk_level: risk.level,
      risk_phase: phase,
      context_patch: {
        ...(phase === "preflight"
          ? { preflight_risk: risk }
          : { post_diff_risk: risk }),
        pending_approval_phase: phase,
        approval_request: request,
      },
    });
    return {
      status: "needs_approval",
      run: waiting,
      approval_request: request,
    };
  }

  private async writeCandidateAndDeliver(
    run: AutonomyRunProjection,
  ): Promise<GuardedDeliveryResult> {
    let candidate: ProofReference;
    try {
      await this.verifyContract(run, run.context.delivery_receipt);
      candidate = ProofReference.parse(
        await this.ports.writeCandidateProof(
          this.candidateProofInput(run),
        ),
      );
    } catch (error) {
      const failed = await this.transition(
        run,
        "delivery_evidence_failed",
        {
          context_patch: {
            failure: {
              operation: "candidate_proof",
              message: errorMessage(error),
            },
          },
        },
      );
      return {
        status: "blocked",
        run: failed,
        reason: "candidate proof failed; commit and Git delivery were not invoked",
      };
    }
    if (run.context.delivery_contract?.contract.requested_completion === "local_verified") {
      const final = await this.transition(run, "final_proof", { context_patch: { candidate_proof: candidate } });
      return await this.completeLimitedContract(final);
    }
    const committing = await this.transition(run, "committing", {
      context_patch: { candidate_proof: candidate },
    });
    return await this.commitAndDeliver(committing);
  }

  private async commitAndDeliver(
    run: AutonomyRunProjection,
  ): Promise<GuardedDeliveryResult> {
    const intent = this.requireIntent(run);
    const localResult = this.requireLocalResult(run);
    const diffSha256 = stagedDiffSha256(localResult.post_diff);
    let commit: { commit: string };
    try {
      await this.verifyContract(run, run.context.delivery_receipt);
      this.assertPostDiffActionAuthorized(run, "commit");
      commit = await this.ports.commit({
        autonomy_run_id: run.autonomy_run_id,
        workspace_path: intent.workspace_path,
        diff_sha256: diffSha256,
        idempotency_key:
          `${run.autonomy_run_id}:commit:${diffSha256}`,
      });
      GitCommitSha.parse(commit.commit);
    } catch (error) {
      return await this.escalate(
        run,
        `commit failed: ${errorMessage(error)}`,
      );
    }
    const pushing = await this.transition(run, "pushing", {
      context_patch: { commit },
    });
    return await this.deliverGitAndFinalize(pushing);
  }

  private async deliverGitAndFinalize(
    run: AutonomyRunProjection,
  ): Promise<GuardedDeliveryResult> {
    const intent = this.requireIntent(run);
    const commit = run.context.commit;
    if (commit === undefined) {
      return await this.escalate(
        run,
        "Git delivery has no persisted candidate commit",
      );
    }
    try {
      await this.verifyContract(run, run.context.delivery_receipt);
      this.assertPostDiffActionAuthorized(run, "push");
      if (run.context.delivery_contract) this.assertPostDiffActionAuthorized(run, "open_pr");
      if (run.context.delivery_contract?.contract.requested_completion !== "pr_opened") this.assertPostDiffActionAuthorized(run, "merge");
    } catch (error) {
      return await this.escalate(
        run,
        `Git delivery scope check failed: ${errorMessage(error)}`,
      );
    }
    if (run.context.delivery_contract?.contract.requested_completion === "pr_opened") {
      const contract = run.context.delivery_contract;
      const scope = contract.contract.publication_scope;
      try {
        if (!this.ports.openPullRequest || scope.mode === "none" || scope.mode === "push") throw new Error("contract_pr_port_unavailable");
        this.assertPostDiffActionAuthorized(run, "open_pr");
        const publication = ContractPullRequestEvidence.parse(await this.ports.openPullRequest({
          workspacePath: intent.workspace_path, remote: this.policy.git.remote, base: this.policy.git.base,
          branch: this.policy.git.branch, title: this.policy.git.title, bodyFile: this.policy.git.body_file,
          mergeStrategy: "squash", ciTimeoutMs: this.policy.git.ci_timeout_ms,
        }, { repository: scope.repository, headCommit: commit.commit, draft: scope.mode === "draft_pr" }));
        if (publication.pushedCommit !== commit.commit) throw new Error("contract_publication_head_mismatch");
        const opened = await this.transition(run, "opening_pr", { context_patch: { pr_delivery: publication } });
        return await this.completeLimitedContract(opened);
      } catch (error) {
        const blocked = await this.transition(run, "blocked_delivery", { context_patch: { blocked_delivery_resume_state: "pushing",
          failure: { operation: "contract_pr_publication", message: errorMessage(error) } } });
        return { status: "blocked", run: blocked, reason: "PR publication unconfirmed; reconcile this persisted run before retry" };
      }
    }
    let gitDelivery: GitHubDeliveryResult;
    try {
      gitDelivery = GitHubDeliveryEvidence.parse(
        await this.ports.deliverGit({
          workspacePath: intent.workspace_path,
          remote: this.policy.git.remote,
          base: this.policy.git.base,
          branch: this.policy.git.branch,
          title: this.policy.git.title,
          bodyFile: this.policy.git.body_file,
          mergeStrategy: "squash",
          ciTimeoutMs: this.policy.git.ci_timeout_ms,
        }),
      );
    } catch (error) {
      const blocked = await this.transition(run, "blocked_delivery", {
        context_patch: {
          blocked_delivery_resume_state: "pushing",
          failure: {
            operation: "git_delivery",
            message: errorMessage(error),
          },
        },
      });
      return {
        status: "blocked",
        run: blocked,
        reason: "Git delivery is retryable from the persisted pushing state",
      };
    }

    let next = await this.transition(run, "opening_pr", {
      context_patch: { git_delivery: gitDelivery },
    });
    next = await this.transition(next, "waiting_ci");
    next = await this.transition(next, "merging");
    return await this.deployAfterMerge(next);
  }

  private async continuePersistedGitDelivery(
    initial: AutonomyRunProjection,
  ): Promise<GuardedDeliveryResult> {
    if (initial.context.git_delivery === undefined) {
      return await this.escalate(
        initial,
        `recovered ${initial.state} state has no persisted Git delivery evidence`,
      );
    }
    GitHubDeliveryEvidence.parse(initial.context.git_delivery);
    let run = initial;
    if (run.state === "opening_pr") {
      run = await this.transition(run, "waiting_ci");
    }
    if (run.state === "waiting_ci") {
      run = await this.transition(run, "merging");
    }
    if (run.state === "merging") {
      return await this.deployAfterMerge(run);
    }
    return await this.writeFinalAndComplete(run);
  }

  private async deployAfterMerge(
    run: AutonomyRunProjection,
  ): Promise<GuardedDeliveryResult> {
    if (run.context.delivery_contract?.contract.requested_completion === "merged") {
      const final = await this.transition(run, "final_proof");
      return await this.writeFinalAndComplete(final);
    }
    const stagingPolicy = this.policy.deploy?.staging;
    if (stagingPolicy === undefined) {
      const finalProof = await this.transition(run, "final_proof");
      return await this.writeFinalAndComplete(finalProof);
    }
    const intent = this.requireIntent(run);
    const gitDelivery = run.context.git_delivery;
    if (
      gitDelivery === undefined
      || this.ports.prepareMergedWorkspace === undefined
    ) {
      return await this.finalizeSkippedDeploy(
        run,
        "staging",
        "post-merge workspace verification is not configured",
      );
    }
    try {
      await this.ports.prepareMergedWorkspace({
        workspace_path: intent.workspace_path,
        remote: this.policy.git.remote,
        base: this.policy.git.base,
        expected_merge_commit_sha: gitDelivery.mergeCommit,
      });
    } catch (error) {
      return await this.finalizeSkippedDeploy(
        run,
        "staging",
        `post-merge workspace verification failed: ${errorMessage(error)}`,
      );
    }

    let prepared: {
      authority: DeployScriptAuthority;
      decision: DeployEligibilityDecision;
    };
    try {
      prepared = await this.prepareDeployTarget(
        run,
        "staging",
        stagingPolicy,
      );
    } catch (error) {
      return await this.finalizeSkippedDeploy(
        run,
        "staging",
        `staging deploy eligibility failed: ${errorMessage(error)}`,
      );
    }
    const contextPatch: Partial<GuardedDeliveryContext> = {
      deploy_eligibility: {
        ...(run.context.deploy_eligibility ?? {}),
        staging: prepared.decision,
      },
      deploy_script_authority: {
        ...(run.context.deploy_script_authority ?? {}),
        staging: prepared.authority,
      },
    };
    if (!prepared.decision.allowed) {
      const finalProof = await this.transition(run, "final_proof", {
        context_patch: {
          ...contextPatch,
          deploy_outcome: "staging_skipped",
        },
      });
      return await this.writeFinalAndComplete(finalProof);
    }

    let current = await this.transition(run, "deploying_staging", {
      context_patch: contextPatch,
    });
    let result: ProjectDeployResult;
    try {
      result = ProjectDeployResultSchema.parse(
        await this.requireDeployPort()({
          target: "staging",
          workspace_path: this.requireIntent(current).workspace_path,
          policy: stagingPolicy,
          expected_script_digest_sha256:
            prepared.authority.digest_sha256,
          before_phase: async (phase) => {
            if (
              phase === "verify"
              && current.state === "deploying_staging"
            ) {
              current = await this.transition(
                current,
                "verifying_staging",
              );
            }
          },
        }),
      );
      this.assertDeployResultTarget(result, "staging");
    } catch (error) {
      const finalProof = await this.transition(
        current,
        "final_proof",
        {
          context_patch: {
            deploy_outcome: "staging_failed",
            failure: {
              operation: "staging_deploy",
              message: errorMessage(error),
            },
          },
        },
      );
      return await this.writeFinalAndComplete(finalProof);
    }
    if (result.outcome !== "healthy") {
      const finalProof = await this.transition(current, "final_proof", {
        context_patch: {
          deploy_staging: result,
          deploy_outcome: "staging_failed",
        },
      });
      return await this.writeFinalAndComplete(finalProof);
    }
    if (current.state === "deploying_staging") {
      current = await this.transition(current, "verifying_staging", {
        context_patch: { deploy_staging: result },
      });
    }
    return await this.continueProductionAfterStaging(current, result);
  }

  private async continueProductionAfterStaging(
    run: AutonomyRunProjection,
    stagingResult: ProjectDeployResult,
  ): Promise<GuardedDeliveryResult> {
    const productionPolicy = this.policy.deploy?.production;
    if (productionPolicy === undefined) {
      const finalProof = await this.transition(run, "final_proof", {
        context_patch: {
          deploy_staging: stagingResult,
          deploy_outcome: "staging_healthy",
        },
      });
      return await this.writeFinalAndComplete(finalProof);
    }

    let prepared: {
      authority: DeployScriptAuthority;
      decision: DeployEligibilityDecision;
    };
    try {
      prepared = await this.prepareDeployTarget(
        run,
        "production",
        productionPolicy,
      );
    } catch (error) {
      return await this.finalizeSkippedDeploy(
        run,
        "production",
        `production deploy eligibility failed: ${errorMessage(error)}`,
        { deploy_staging: stagingResult },
      );
    }
    const contextPatch: Partial<GuardedDeliveryContext> = {
      deploy_staging: stagingResult,
      deploy_eligibility: {
        ...(run.context.deploy_eligibility ?? {}),
        production: prepared.decision,
      },
      deploy_script_authority: {
        ...(run.context.deploy_script_authority ?? {}),
        production: prepared.authority,
      },
    };
    if (!prepared.decision.allowed) {
      const finalProof = await this.transition(run, "final_proof", {
        context_patch: {
          ...contextPatch,
          deploy_outcome: "production_skipped",
        },
      });
      return await this.writeFinalAndComplete(finalProof);
    }

    let current = await this.transition(
      run,
      "deploying_production",
      { context_patch: contextPatch },
    );
    let result: ProjectDeployResult;
    try {
      result = ProjectDeployResultSchema.parse(
        await this.requireDeployPort()({
          target: "production",
          workspace_path: this.requireIntent(current).workspace_path,
          policy: productionPolicy,
          expected_script_digest_sha256:
            prepared.authority.digest_sha256,
          before_phase: async (phase) => {
            current = await this.persistProductionPhase(
              current,
              phase,
            );
          },
        }),
      );
      this.assertDeployResultTarget(result, "production");
    } catch (error) {
      return await this.freezeFailedProduction(
        current,
        `production deploy port failed: ${errorMessage(error)}`,
      );
    }

    if (result.outcome === "healthy") {
      if (current.state === "deploying_production") {
        current = await this.transition(current, "health_checking");
      }
      const finalProof = await this.transition(
        current,
        "final_proof",
        {
          context_patch: {
            deploy_production: result,
            deploy_outcome: "production_healthy",
          },
        },
      );
      return await this.writeFinalAndComplete(finalProof);
    }

    if (current.state !== "rolling_back") {
      current = await this.transition(current, "rolling_back", {
        context_patch: { deploy_production: result },
      });
    }
    const outcome: GuardedDeployOutcome =
      result.outcome === "rollback_failed"
        ? "rollback_failed"
        : "production_rolled_back";
    let freeze: ProductionFreezeEvidence;
    try {
      freeze = ProductionFreezeEvidenceSchema.parse(
        await this.requireFreezePort()({
          repo_id: this.requireIntent(current).repo_id,
          reason: `automatic production freeze after ${result.outcome}`,
          source_run_id: current.autonomy_run_id,
          frozen_at: this.ports.now().getTime() / 1_000,
        }),
      );
    } catch (error) {
      return await this.escalate(
        current,
        `production freeze failed: ${errorMessage(error)}`,
        { deploy_production: result, deploy_outcome: outcome },
      );
    }
    const frozen = await this.transition(current, "deploy_frozen", {
      context_patch: {
        deploy_production: result,
        production_freeze: freeze,
        deploy_outcome: outcome,
      },
    });
    const finalProof = await this.transition(frozen, "final_proof");
    return await this.writeFinalAndComplete(finalProof);
  }

  private async prepareDeployTarget(
    run: AutonomyRunProjection,
    target: "staging" | "production",
    policy: DeployTargetPolicy,
  ): Promise<{
    authority: DeployScriptAuthority;
    decision: DeployEligibilityDecision;
  }> {
    const intent = this.requireIntent(run);
    const local = this.requireLocalResult(run);
    const candidate = run.context.candidate_proof;
    if (candidate === undefined) {
      throw new Error("deploy eligibility requires candidate proof");
    }
    const resolveAuthority =
      this.ports.resolveDeployScriptAuthority;
    const evaluate = this.ports.evaluateDeploy;
    if (resolveAuthority === undefined || evaluate === undefined) {
      throw new Error("deploy eligibility ports are not configured");
    }
    const authority = DeployScriptAuthoritySchema.parse(
      await resolveAuthority({
        workspace_path: intent.workspace_path,
        policy,
      }),
    );
    let actionApproved = false;
    this.assertPostDiffActionAuthorized(run, `deploy:${target}`);
    if (
      this.requirePreflightRisk(run).level === "R3"
      || this.requirePostDiffRisk(run).level === "R3"
    ) {
      actionApproved = true;
    }
    let productionFrozen = false;
    if (target === "production") {
      if (this.ports.isProductionFrozen === undefined) {
        throw new Error("production freeze status port is not configured");
      }
      productionFrozen = await this.ports.isProductionFrozen(
        intent.repo_id,
      );
    }
    const decision = DeployEligibilityDecisionSchema.parse(
      evaluate(policy, {
        target,
        base_branch:
          this.policy.deploy?.base_branch ?? this.policy.git.base,
        changed_paths: [...local.post_diff.changed_paths],
        diff_stats: this.deployDiffStats(local.post_diff),
        final_risk: this.requirePostDiffRisk(run).level,
        deterministic_pass: local.verification_passed,
        kimi_pass: local.review_passed,
        governance_pass: local.verification_passed,
        ci_pass: true,
        candidate_proof_sha256: candidate.manifest_sha256,
        deploy_script_digest_sha256: authority.digest_sha256,
        production_frozen: productionFrozen,
        deploy_action_approved: actionApproved,
        ...(target === "production"
          && this.policy.deploy?.rollback_drill !== undefined
          ? {
              rollback_drill:
                this.policy.deploy.rollback_drill as RollbackDrillEvidence,
            }
          : {}),
        now: this.ports.now(),
      }),
    );
    return { authority, decision };
  }

  private deployDiffStats(
    postDiff: PostDiffInputType,
  ): DeployEligibilityInput["diff_stats"] {
    let additions = 0;
    let deletions = 0;
    for (const line of postDiff.staged_diff_binary.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        additions += 1;
      } else if (
        line.startsWith("-")
        && !line.startsWith("---")
      ) {
        deletions += 1;
      }
    }
    return {
      additions,
      deletions,
      files_changed: postDiff.changed_paths.length,
    };
  }

  private async persistProductionPhase(
    run: AutonomyRunProjection,
    phase: ProjectDeployPhase,
  ): Promise<AutonomyRunProjection> {
    if (
      phase === "health"
      && run.state === "deploying_production"
    ) {
      return await this.transition(run, "health_checking");
    }
    if (
      phase === "rollback"
      && (
        run.state === "deploying_production"
        || run.state === "health_checking"
      )
    ) {
      return await this.transition(run, "rolling_back");
    }
    return run;
  }

  private async finalizeSkippedDeploy(
    run: AutonomyRunProjection,
    target: "staging" | "production",
    reason: string,
    contextPatch: Partial<GuardedDeliveryContext> = {},
  ): Promise<GuardedDeliveryResult> {
    const decision: DeployEligibilityDecision = {
      allowed: false,
      reasons: ["deploy_eligibility_unavailable"],
      requires_approval: false,
      change_types: [],
      unknown_paths: [],
    };
    const finalProof = await this.transition(run, "final_proof", {
      context_patch: {
        ...contextPatch,
        deploy_eligibility: {
          ...(run.context.deploy_eligibility ?? {}),
          [target]: decision,
        },
        deploy_outcome:
          target === "staging"
            ? "staging_skipped"
            : "production_skipped",
        failure: {
          operation: `${target}_deploy_eligibility`,
          message: reason,
        },
      },
    });
    return await this.writeFinalAndComplete(finalProof);
  }

  private async recoverDeployState(
    run: AutonomyRunProjection,
  ): Promise<GuardedDeliveryResult> {
    if (
      run.state === "deploying_staging"
      || run.state === "verifying_staging"
    ) {
      const result = run.context.deploy_staging;
      if (result === undefined) {
        return await this.escalate(
          run,
          "recovered staging deployment has no durable result; refusing replay",
        );
      }
      let current = run;
      if (
        result.outcome === "healthy"
        && current.state === "deploying_staging"
      ) {
        current = await this.transition(
          current,
          "verifying_staging",
        );
      }
      if (result.outcome === "healthy") {
        return await this.continueProductionAfterStaging(
          current,
          result,
        );
      }
      const finalProof = await this.transition(
        current,
        "final_proof",
        {
          context_patch: { deploy_outcome: "staging_failed" },
        },
      );
      return await this.writeFinalAndComplete(finalProof);
    }

    const result = run.context.deploy_production;
    if (result === undefined) {
      return await this.freezeFailedProduction(
        run,
        "recovered production deployment has no durable result; freezing and refusing replay",
      );
    }
    let current = run;
    if (result.outcome === "healthy") {
      if (current.state === "deploying_production") {
        current = await this.transition(current, "health_checking");
      }
      const finalProof = await this.transition(
        current,
        "final_proof",
        {
          context_patch: { deploy_outcome: "production_healthy" },
        },
      );
      return await this.writeFinalAndComplete(finalProof);
    }
    return await this.escalate(
      current,
      "recovered unhealthy production deployment requires operator review",
    );
  }

  private async freezeFailedProduction(
    run: AutonomyRunProjection,
    reason: string,
  ): Promise<GuardedDeliveryResult> {
    let current = run;
    if (
      current.state === "deploying_production"
      || current.state === "health_checking"
    ) {
      current = await this.transition(current, "rolling_back", {
        context_patch: {
          deploy_outcome: "rollback_failed",
          failure: {
            operation: "production_deploy",
            message: reason,
          },
        },
      });
    }
    let freeze: ProductionFreezeEvidence;
    try {
      freeze = ProductionFreezeEvidenceSchema.parse(
        await this.requireFreezePort()({
          repo_id: this.requireIntent(current).repo_id,
          reason: "automatic production freeze after deploy execution error",
          source_run_id: current.autonomy_run_id,
          frozen_at: this.ports.now().getTime() / 1_000,
        }),
      );
    } catch (error) {
      return await this.escalate(
        current,
        `production freeze failed after deploy error: ${errorMessage(error)}`,
        {
          deploy_outcome: "rollback_failed",
          failure: {
            operation: "production_deploy",
            message: reason,
          },
        },
      );
    }
    const frozen = await this.transition(current, "deploy_frozen", {
      context_patch: {
        deploy_outcome: "rollback_failed",
        production_freeze: freeze,
        failure: {
          operation: "production_deploy",
          message: reason,
        },
      },
    });
    const finalProof = await this.transition(frozen, "final_proof");
    return await this.writeFinalAndComplete(finalProof);
  }

  private requireDeployPort(): (
    input: ProjectDeployInput,
  ) => Promise<ProjectDeployResult> {
    if (this.ports.deploy === undefined) {
      throw new Error("deploy execution port is not configured");
    }
    return this.ports.deploy;
  }

  private requireFreezePort(): NonNullable<
    GuardedDeliveryPorts["freezeProduction"]
  > {
    if (this.ports.freezeProduction === undefined) {
      throw new Error("production freeze port is not configured");
    }
    return this.ports.freezeProduction;
  }

  private assertDeployResultTarget(
    result: ProjectDeployResult,
    target: "staging" | "production",
  ): void {
    if (result.target !== target) {
      throw new Error(
        `deploy port returned ${result.target} evidence for ${target}`,
      );
    }
  }

  private async writeFinalAndComplete(
    run: AutonomyRunProjection,
  ): Promise<GuardedDeliveryResult> {
    const candidate = run.context.candidate_proof;
    const gitDelivery = run.context.git_delivery;
    if (candidate === undefined || gitDelivery === undefined) {
      return await this.failFinalEvidence(
        run,
        "final proof inputs are missing candidate or Git delivery evidence",
      );
    }
    let finalProof: ProofReference;
    try {
      await this.verifyContract(run, run.context.delivery_receipt);
      if (run.context.delivery_contract?.contract.requested_completion === "deployed"
        && !["staging_healthy", "production_healthy"].includes(run.context.deploy_outcome ?? "")) throw new Error("delivery_requested_deployment_not_achieved");
      finalProof = ProofReference.parse(
        await this.ports.writeFinalProof({
          ...this.candidateProofInput(run),
          candidate_proof: candidate,
          git_delivery: gitDelivery,
          ...(run.context.deploy_eligibility === undefined
            ? {}
            : {
                deploy_eligibility:
                  run.context.deploy_eligibility,
              }),
          ...(run.context.deploy_script_authority === undefined
            ? {}
            : {
                deploy_script_authority:
                  run.context.deploy_script_authority,
              }),
          ...(run.context.deploy_staging === undefined
            ? {}
            : { deploy_staging: run.context.deploy_staging }),
          ...(run.context.deploy_production === undefined
            ? {}
            : {
                deploy_production:
                  run.context.deploy_production,
              }),
          ...(run.context.production_freeze === undefined
            ? {}
            : {
                production_freeze:
                  run.context.production_freeze,
              }),
          ...(run.context.deploy_outcome === undefined
            ? {}
            : { deploy_outcome: run.context.deploy_outcome }),
        }),
      );
    } catch (error) {
      return await this.failFinalEvidence(run, errorMessage(error));
    }
    if (
      run.context.deploy_outcome === "staging_failed"
      || run.context.deploy_outcome === "rollback_failed"
      || run.context.failure?.operation ===
        "staging_deploy_eligibility"
      || run.context.failure?.operation ===
        "production_deploy_eligibility"
    ) {
      return await this.escalate(
        run,
        run.context.failure?.message
          ?? `deployment ended in ${run.context.deploy_outcome}`,
        { final_proof: finalProof },
      );
    }
    const completed = await this.transition(run, "completed", {
      context_patch: { final_proof: finalProof, ...(run.context.delivery_contract ? {
        achieved_completion: run.context.delivery_contract.contract.requested_completion,
      } : {}) },
    });
    return { status: "completed", run: completed };
  }

  private async failFinalEvidence(
    run: AutonomyRunProjection,
    message: string,
  ): Promise<GuardedDeliveryResult> {
    const failed = await this.transition(run, "delivery_evidence_failed", {
      context_patch: {
        failure: { operation: "final_proof", message },
      },
    });
    return {
      status: "blocked",
      run: failed,
      reason: run.context.delivery_contract ? "Contract completion evidence could not be verified" : "Git merged but final delivery evidence could not be written",
    };
  }

  private async verifyContract(run: AutonomyRunProjection, ref: DeliveryReceiptReferenceV2 | undefined): Promise<void> {
    const contract = run.context.delivery_contract;
    if (!contract) return;
    if (!ref || !this.ports.verifyContractReceipt) throw new Error("delivery_contract_host_receipt_required");
    const frozen = assertFrozenDeliveryContract(contract);
    await this.ports.verifyContractReceipt({ contract: frozen, ref, runId: run.autonomy_run_id, workspacePath: this.requireIntent(run).workspace_path,
      expectedHeads: run.context.commit ? [run.context.commit.commit, ...(run.context.git_delivery ? [run.context.git_delivery.mergeCommit] : [])] : [frozen.contract.base_head] });
  }

  private async completeLimitedContract(initial: AutonomyRunProjection): Promise<GuardedDeliveryResult> {
    let run = initial;
    if (run.state === "opening_pr") run = await this.transition(run, "final_proof");
    try {
      await this.verifyContract(run, run.context.delivery_receipt);
      const contract = run.context.delivery_contract;
      const achieved = contract?.contract.requested_completion;
      if (!contract || !["local_verified", "pr_opened"].includes(achieved ?? "") || !run.context.candidate_proof
        || !run.context.delivery_receipt || !this.ports.writeContractCompletionReceipt
        || achieved === "pr_opened" && !run.context.pr_delivery) throw new Error("delivery_contract_completion_evidence_missing");
      const completion = DeliveryReceiptReferenceV2.parse(await this.ports.writeContractCompletionReceipt({ runId: run.autonomy_run_id,
        contract, verificationReceipt: run.context.delivery_receipt, candidateProof: run.context.candidate_proof,
        achievedCompletion: achieved as "local_verified" | "pr_opened", ...(run.context.pr_delivery ? { publication: run.context.pr_delivery } : {}) }));
      const completed = await this.transition(run, "completed", { context_patch: { delivery_completion_receipt: completion,
        achieved_completion: achieved, final_proof: run.context.candidate_proof } });
      return { status: "completed", run: completed };
    } catch (error) { return await this.failFinalEvidence(run, errorMessage(error)); }
  }

  private candidateProofInput(
    run: AutonomyRunProjection,
  ): CandidateProofInput {
    const context = run.context;
    return {
      autonomy_run_id: run.autonomy_run_id,
      intent: this.requireIntent(run),
      preflight_risk: this.requirePreflightRisk(run),
      post_diff_risk: this.requirePostDiffRisk(run),
      local_result: this.requireLocalResult(run),
      ...(context.delivery_contract ? { delivery_contract: context.delivery_contract } : {}),
      ...(context.delivery_receipt ? { delivery_receipt: context.delivery_receipt } : {}),
      ...(context.approval_request === undefined
        ? {}
        : { approval_request: context.approval_request }),
      ...(context.approval_decision === undefined
        ? {}
        : { approval_decision: context.approval_decision }),
    };
  }

  private async transition(
    current: AutonomyRunProjection,
    toState: AutonomyRunState,
    options: Omit<
      GuardedDeliveryTransitionInput,
      "autonomy_run_id" | "from_state" | "to_state"
    > = {},
  ): Promise<AutonomyRunProjection> {
    const transition: GuardedDeliveryTransitionInput = {
      autonomy_run_id: current.autonomy_run_id,
      from_state: current.state,
      to_state: toState,
      ...options,
    };
    assertAutonomyTransition(transition);
    const persisted = await this.ports.persist(transition);
    if (
      persisted.autonomy_run_id !== current.autonomy_run_id
      || persisted.state !== toState
      || persisted.revision <= current.revision
    ) {
      throw new Error(
        `persist port did not confirm ${current.state} -> ${toState}`,
      );
    }
    return persisted;
  }

  private async escalate(
    run: AutonomyRunProjection,
    reason: string,
    contextPatch: Partial<GuardedDeliveryContext> = {},
  ): Promise<GuardedDeliveryResult> {
    const escalated = await this.transition(run, "escalated", {
      context_patch: {
        ...contextPatch,
        failure: { operation: run.state, message: reason },
      },
    });
    return { status: "blocked", run: escalated, reason };
  }

  private async escalateRecoveredState(
    run: AutonomyRunProjection,
  ): Promise<GuardedDeliveryResult> {
    const legalEscalationStates: AutonomyRunState[] = [
      "classifying",
      "building",
      "verifying",
      "repairing",
      "reviewing",
      "post_classifying",
    ];
    if (legalEscalationStates.includes(run.state)) {
      return await this.escalate(
        run,
        `recovered state ${run.state} lacks a safe deterministic continuation`,
      );
    }
    const cancelled = await this.transition(run, "cancelled", {
      context_patch: {
        failure: {
          operation: "recovery",
          message: `recovered state ${run.state} cannot be resumed`,
        },
      },
    });
    return {
      status: "blocked",
      run: cancelled,
      reason: `recovered state ${run.state} cannot be resumed`,
    };
  }

  private requireIntent(run: AutonomyRunProjection): AutonomyTaskIntentType {
    return AutonomyTaskIntent.parse(run.context.intent);
  }

  private requireLocalResult(run: AutonomyRunProjection): LocalDeliveryResult {
    return LocalDeliveryResult.parse(run.context.local_result);
  }

  private requirePreflightRisk(
    run: AutonomyRunProjection,
  ): AutonomyRiskDecision {
    const risk = run.context.preflight_risk;
    if (risk === undefined) {
      throw new Error("autonomy run is missing preflight risk evidence");
    }
    return risk;
  }

  private requirePostDiffRisk(
    run: AutonomyRunProjection,
  ): AutonomyRiskDecision {
    const risk = run.context.post_diff_risk;
    if (risk === undefined) {
      throw new Error("autonomy run is missing post-diff risk evidence");
    }
    return risk;
  }

  private assertPostDiffActionAuthorized(
    run: AutonomyRunProjection,
    action: string,
  ): void {
    const contract = run.context.delivery_contract;
    if (contract && !contract.contract.requested_actions.some(requested => requested === action)) {
      throw new Error(`${action} is absent from the frozen delivery contract`);
    }
    const preflight = this.requirePreflightRisk(run);
    const postDiff = this.requirePostDiffRisk(run);
    if (preflight.level !== "R3" && postDiff.level !== "R3") return;

    const request = ScopedApprovalRequest.parse(
      run.context.approval_request,
    );
    const decision = ScopedApprovalDecision.parse(
      run.context.approval_decision,
    );
    if (request.phase !== "post_diff") {
      throw new Error(`${action} requires a post-diff approval scope`);
    }
    if (
      !request.action_scope.includes(action)
      || !decision.payload.action_scope.includes(action)
    ) {
      throw new Error(
        `${action} is absent from the signed post-diff approval scope`,
      );
    }
    if (decision.payload.decision !== "approve") {
      throw new Error(`${action} requires an approved decision`);
    }
    const requestDigest = scopedApprovalDigest({
      autonomy_run_id: request.autonomy_run_id,
      contract_sha256: request.contract_sha256,
      diff_sha256: request.diff_sha256,
      action_scope: request.action_scope,
    });
    if (request.request_sha256 !== requestDigest) {
      throw new Error(
        `${action} approval request digest no longer matches its scope`,
      );
    }
    validateScopedApprovalDecisionForRequest(request, decision);
  }

  private approvalActionScope(
    phase: AutonomyRiskPhase,
    run: AutonomyRunProjection,
  ): string[] {
    if (phase === "preflight") return ["build", "verify"];
    const contract = run.context.delivery_contract?.contract;
    if (contract) {
      // Bind only the effects needed by this completion, never broaden an older signed scope.
      if (contract.requested_completion === "local_verified") return ["verify"];
      const actions = new Set(["commit", "open_pr", "push"]);
      if (["merged", "deployed"].includes(contract.requested_completion)) actions.add("merge");
      if (contract.requested_completion === "deployed") {
        for (const target of ["staging", "production"] as const) {
          const action = `deploy:${target}`;
          if (this.policy.deploy?.[target] && contract.requested_actions.some(requested => requested === action)) actions.add(action);
        }
      }
      return [...actions].filter(action => contract.requested_actions.some(requested => requested === action)).sort();
    }
    const actions = new Set(["commit", "merge", "push"]);
    if (this.policy.deploy?.staging !== undefined) {
      actions.add("deploy:staging");
    }
    if (this.policy.deploy?.production !== undefined) {
      actions.add("deploy:production");
    }
    return [...actions].sort();
  }
}
