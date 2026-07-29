import { createHash } from "node:crypto";
import {
  AUTONOMY_EMPTY_DIFF_SHA256,
  type AutonomyRiskDecision,
  type AutonomyRiskPhase,
  type AutonomyRunState,
  type ScopedApprovalDecision,
  type ScopedApprovalRequest,
} from "@osstack/protocol";
import type {
  GitHubDeliveryInput,
  GitHubDeliveryResult,
} from "@osstack/github";
import { z } from "zod";
import {
  createScopedApprovalRequest,
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
const GitHubDeliveryEvidence = z
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

export const LocalDeliveryResult = z
  .object({
    verification_passed: z.boolean(),
    review_passed: z.boolean(),
    post_diff: PostDiffInput,
    progress: AttemptProgressSchema,
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
  approval_request?: ScopedApprovalRequest;
  approval_decision?: ScopedApprovalDecision;
}

export interface FinalProofInput extends CandidateProofInput {
  candidate_proof: ProofReference;
  git_delivery: GitHubDeliveryResult;
}

export interface CommitInput {
  autonomy_run_id: string;
  workspace_path: string;
  diff_sha256: string;
  idempotency_key: string;
}

export interface GuardedDeliveryContext {
  intent?: AutonomyTaskIntentType;
  started_at?: string;
  routing?: unknown;
  budget?: DeliveryBudgetType;
  preflight_risk?: AutonomyRiskDecision;
  post_diff_risk?: AutonomyRiskDecision;
  pending_approval_phase?: AutonomyRiskPhase;
  approval_request?: ScopedApprovalRequest;
  approval_decision?: ScopedApprovalDecision;
  local_result?: LocalDeliveryResult;
  builder_iterations?: number;
  review_rounds?: number;
  no_progress_rounds?: number;
  candidate_proof?: ProofReference;
  commit?: { commit: string };
  git_delivery?: GitHubDeliveryResult;
  final_proof?: ProofReference;
  blocked_delivery_resume_state?: "pushing";
  failure?: { operation: string; message: string };
}

export interface AutonomyRunProjection {
  autonomy_run_id: string;
  state: AutonomyRunState;
  revision: number;
  context: GuardedDeliveryContext;
}

export interface GuardedDeliveryTransitionInput
  extends AutonomyTransitionInput {
  context_patch?: Partial<GuardedDeliveryContext>;
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
    routing: unknown;
    budget: DeliveryBudgetType;
  }): Promise<LocalDeliveryResult>;
  writeCandidateProof(input: CandidateProofInput): Promise<ProofReference>;
  writeFinalProof(input: FinalProofInput): Promise<ProofReference>;
  commit(input: CommitInput): Promise<{ commit: string }>;
  deliverGit(input: GitHubDeliveryInput): Promise<GitHubDeliveryResult>;
}

export interface GuardedDeliveryPolicy {
  policy_sha256: string;
  protected_policy_paths: readonly string[];
  routing: unknown;
  budget: DeliveryBudgetType;
  approval_ttl_ms: number;
  trusted_approval_public_keys: ReadonlyMap<string, string>;
  consume_approval_nonce(nonce: string): boolean;
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
      budget: DeliveryBudget.parse(policy.budget),
    };
    if (
      !Number.isInteger(policy.approval_ttl_ms)
      || policy.approval_ttl_ms < 1_000
      || policy.approval_ttl_ms > 86_400_000
    ) {
      throw new Error("approval_ttl_ms must be between 1000 and 86400000");
    }
    this.ports = ports;
  }

  async start(intentValue: AutonomyTaskIntentType): Promise<GuardedDeliveryResult> {
    const intent = AutonomyTaskIntent.parse(intentValue);
    const startedAt = this.ports.now().toISOString();
    let run: AutonomyRunProjection = {
      autonomy_run_id: intent.autonomy_run_id,
      state: "queued",
      revision: 0,
      context: {
        intent,
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
    if (risk.level === "R0") {
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
        action_scope: request.action_scope,
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
      attempts.builderIterations += 1;
      run = await this.transition(run, "verifying", {
        context_patch: {
          local_result: localResult,
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
    const risk = classifyPostDiffRisk(localResult.post_diff, {
      policy_sha256: this.policy.policy_sha256,
      now: () => this.ports.now().toISOString(),
      repo_id: intent.repo_id,
      protected_policy_paths: this.policy.protected_policy_paths,
    });
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
    const actionScope =
      phase === "preflight"
        ? ["build", "verify"]
        : ["commit", "merge", "push"];
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
    next = await this.transition(next, "final_proof");
    return await this.writeFinalAndComplete(next);
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
      run = await this.transition(run, "final_proof");
    }
    return await this.writeFinalAndComplete(run);
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
      finalProof = ProofReference.parse(
        await this.ports.writeFinalProof({
          ...this.candidateProofInput(run),
          candidate_proof: candidate,
          git_delivery: gitDelivery,
        }),
      );
    } catch (error) {
      return await this.failFinalEvidence(run, errorMessage(error));
    }
    const completed = await this.transition(run, "completed", {
      context_patch: { final_proof: finalProof },
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
      reason: "Git merged but final delivery evidence could not be written",
    };
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
}
