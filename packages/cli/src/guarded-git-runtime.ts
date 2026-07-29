import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertGuardedCandidateBase,
  assertGuardedCandidateHead,
  commitGuardedCandidate,
  contractDecisionIdForApprovalNonce,
  GuardedDeliveryEngine,
  GuardedDeliveryContextSchema,
  LocalDeliveryResult,
  SqliteGuardedDeliveryStore,
  stageGuardedCandidate,
  type CandidateProofInput,
  type FinalProofInput,
  type GuardedDeliveryPolicy,
  type GuardedDeliveryResult,
  type ProofReference,
} from "@osstack/autonomy";
import {
  defaultAdapters,
  type AgentAdapter,
} from "@osstack/agents";
import {
  getContractDecision,
} from "@osstack/core";
import {
  deliverToGitHub,
  type GitHubDeliveryResult,
} from "@osstack/github";
import {
  LoopEngine,
  LoopProfileRoutingEvidence,
  Task,
  type LoopEvent,
  type LoopState,
} from "@osstack/loop";
import {
  ScopedApprovalDecision,
  type ScopedApprovalDecision as ScopedApprovalDecisionType,
} from "@osstack/protocol";
import { z } from "zod";
import { makePolicyGate } from "./policy-gate.js";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const GitCommitSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const AbsolutePath = z.string().min(1).refine(
  (value) => value.startsWith("/"),
  "path must be absolute",
);
const RuntimeProfile = LoopProfileRoutingEvidence.extend({
  builder_identity: z.record(z.unknown()),
  evaluator_identity: z.record(z.unknown()),
}).passthrough();

export const GuardedGitRouting = z
  .object({
    schema_version: z.literal(1),
    task: Task,
    profile: RuntimeProfile,
    verify_commands: z.array(z.string().min(1)).min(1),
    command_timeout_ms: z.number().int().min(1_000),
    evidence_root: AbsolutePath,
    base_commit_sha: GitCommitSha,
    policy_sha256: Sha256,
    max_auto_risk: z.enum(["R1", "R2"]),
    protected_policy_paths: z.array(z.string().min(1)),
    approval_ttl_ms: z.number().int().min(1_000).max(86_400_000),
    git: z
      .object({
        remote: z.string().min(1),
        base: z.string().min(1),
        branch: z.string().min(1),
        title: z.string().min(1).max(256),
        body_file: AbsolutePath,
        ci_timeout_ms: z.number().int().min(1_000).max(86_400_000),
      })
      .strict(),
  })
  .strict();
export type GuardedGitRouting = z.infer<typeof GuardedGitRouting>;

export interface GuardedGitProofInput {
  stage: "candidate" | "final";
  routing: GuardedGitRouting;
  evidence: CandidateProofInput | FinalProofInput;
  candidate_proof?: ProofReference;
  git_delivery?: GitHubDeliveryResult;
}

export interface GuardedGitRuntimeDeps {
  db: Parameters<typeof getContractDecision>[0];
  dbPath: string;
  trustedApprovalPublicKeys: ReadonlyMap<string, string>;
  adapters?: () => AgentAdapter[];
  now?: () => Date;
  writeProof(input: GuardedGitProofInput): Promise<ProofReference>;
  deliverGit?: typeof deliverToGitHub;
  assertPolicyUnchanged?: (
    workspacePath: string,
    expectedPolicySha256: string,
  ) => Promise<void>;
  evaluateGovernance?: (
    workspacePath: string,
  ) => Promise<{ blocking: boolean; evidence: unknown }>;
}

export interface GuardedGitStartInput {
  autonomy_run_id: string;
  task_id: string;
  repo_id: string;
  workspace_path: string;
  goal: string;
  expected_paths: string[];
  requested_actions: string[];
  contract_sha256: string;
  routing: GuardedGitRouting;
  budget: GuardedDeliveryPolicy["budget"];
}

export interface GuardedLocalEvidence {
  state: LoopState;
  events: LoopEvent[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function stringIdentityField(
  identity: Record<string, unknown>,
  key: string,
): string {
  const value = identity[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`runtime identity ${key} is missing`);
  }
  return value;
}

function runtimeIdentity(identity: Record<string, unknown>) {
  const evidenceSource = stringIdentityField(
    identity,
    "evidence_source",
  );
  return {
    provider_id: stringIdentityField(identity, "provider_id"),
    model_id: stringIdentityField(identity, "model_id"),
    evidence_source: evidenceSource,
  };
}

function findingFingerprints(
  completed: LoopState["completed_tasks"][number],
): string[] {
  return uniqueSorted(
    (completed.review_artifacts ?? []).flatMap((artifact) =>
      artifact.findings.map((finding) => finding.fingerprint)
    ),
  );
}

function failedCommands(
  completed: LoopState["completed_tasks"][number],
): string[] {
  return uniqueSorted(
    [
      ...(completed.execution_commands ?? []),
      ...(completed.verify_commands ?? []),
    ]
      .filter((command) => command.exit_code !== 0)
      .map((command) => command.command),
  );
}

function reviewPassed(
  completed: LoopState["completed_tasks"][number],
): boolean {
  const artifacts = completed.review_artifacts ?? [];
  return artifacts.length > 0
    && artifacts.every((artifact) => artifact.verdict === "approved");
}

function policyFromRouting(
  routing: GuardedGitRouting,
  budget: GuardedDeliveryPolicy["budget"],
  deps: GuardedGitRuntimeDeps,
): GuardedDeliveryPolicy {
  return {
    policy_sha256: routing.policy_sha256,
    max_auto_risk: routing.max_auto_risk,
    protected_policy_paths: routing.protected_policy_paths,
    routing,
    budget,
    approval_ttl_ms: routing.approval_ttl_ms,
    trusted_approval_public_keys: deps.trustedApprovalPublicKeys,
    consume_approval_nonce: (nonce) =>
      getContractDecision(
        deps.db,
        contractDecisionIdForApprovalNonce(nonce),
      ) !== undefined,
    git: routing.git,
  };
}

export class GuardedGitRuntime {
  private readonly deps: GuardedGitRuntimeDeps;
  private readonly store: SqliteGuardedDeliveryStore;

  constructor(deps: GuardedGitRuntimeDeps) {
    this.deps = deps;
    this.store = new SqliteGuardedDeliveryStore({
      db: deps.db,
      dbPath: deps.dbPath,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
  }

  async start(input: GuardedGitStartInput): Promise<GuardedDeliveryResult> {
    const routing = GuardedGitRouting.parse(input.routing);
    const verifiedBase = await assertGuardedCandidateBase({
      workspace_path: input.workspace_path,
      remote: routing.git.remote,
      base: routing.git.base,
    });
    if (verifiedBase.base_commit_sha !== routing.base_commit_sha) {
      throw new Error(
        "guarded routing base commit does not match the fetched base",
      );
    }
    await this.assertPolicy(routing, input.workspace_path);
    return await this.engine(routing, input.budget).start({
      autonomy_run_id: input.autonomy_run_id,
      task_id: input.task_id,
      repo_id: input.repo_id,
      workspace_path: input.workspace_path,
      goal: input.goal,
      expected_paths: uniqueSorted(input.expected_paths),
      requested_actions: uniqueSorted(input.requested_actions),
      contract_sha256: Sha256.parse(input.contract_sha256),
    });
  }

  async resume(
    autonomyRunId: string,
    decisionValue?: ScopedApprovalDecisionType,
  ): Promise<GuardedDeliveryResult> {
    const loaded = await this.store.load(autonomyRunId);
    if (loaded === undefined) {
      throw new Error(`autonomy run ${autonomyRunId} was not found`);
    }
    const context = GuardedDeliveryContextSchema.parse(loaded.context);
    const routing = GuardedGitRouting.parse(context.routing);
    const budget = context.budget;
    const intent = context.intent;
    if (budget === undefined || intent === undefined) {
      throw new Error("persisted autonomy run lacks budget or intent");
    }
    // Before local execution, policy must still match the classified
    // authority. Once an exact staged candidate exists, its persisted
    // base/diff digests and the commit port's TOCTOU checks are authoritative.
    // Re-reading a deliberately changed protected policy file here would
    // otherwise make an approved post-diff R3 run impossible to resume.
    if (context.local_result === undefined) {
      await this.assertPolicy(routing, intent.workspace_path);
    }
    return await this.engine(routing, budget).resume(
      autonomyRunId,
      decisionValue === undefined
        ? undefined
        : ScopedApprovalDecision.parse(decisionValue),
    );
  }

  private engine(
    routing: GuardedGitRouting,
    budget: GuardedDeliveryPolicy["budget"],
  ): GuardedDeliveryEngine {
    return new GuardedDeliveryEngine(
      policyFromRouting(routing, budget, this.deps),
      {
        now: this.deps.now ?? (() => new Date()),
        load: (runId) => this.store.load(runId),
        persist: (event) => this.store.persist(event),
        runLocal: ({ workspacePath }) =>
          this.runLocal(workspacePath, routing),
        writeCandidateProof: async (evidence) => {
          const proof = await this.deps.writeProof({
            stage: "candidate",
            routing,
            evidence,
          });
          await writeFile(
            routing.git.body_file,
            [
              "# OSStack guarded delivery",
              "",
              "Candidate proof: local `manifest.json`",
              `Candidate proof SHA-256: \`${proof.manifest_sha256}\``,
              "",
            ].join("\n"),
            "utf8",
          );
          return proof;
        },
        writeFinalProof: (evidence) =>
          this.deps.writeProof({
            stage: "final",
            routing,
            evidence,
            candidate_proof: evidence.candidate_proof,
            git_delivery: evidence.git_delivery,
          }),
        commit: async (input) => {
          const run = await this.store.load(input.autonomy_run_id);
          const local = run?.context.local_result;
          if (local === undefined) {
            throw new Error("commit port has no persisted local result");
          }
          return await commitGuardedCandidate({
            workspace_path: input.workspace_path,
            expected_base_commit_sha:
              local.post_diff.base_commit_sha,
            expected_diff_sha256: input.diff_sha256,
            idempotency_key: input.idempotency_key,
            message: routing.git.title,
          });
        },
        deliverGit: (input) =>
          (this.deps.deliverGit ?? deliverToGitHub)(input),
      },
    );
  }

  private async assertPolicy(
    routing: GuardedGitRouting,
    workspacePath: string,
  ): Promise<void> {
    await this.deps.assertPolicyUnchanged?.(
      workspacePath,
      routing.policy_sha256,
    );
  }

  private async runLocal(
    workspacePath: string,
    routing: GuardedGitRouting,
  ): Promise<LocalDeliveryResult> {
    await assertGuardedCandidateHead(
      workspacePath,
      routing.base_commit_sha,
    );
    await this.assertPolicy(routing, workspacePath);
    await mkdir(routing.evidence_root, { recursive: true });
    const stateFilePath = join(
      routing.evidence_root,
      "LOOP-STATE.json",
    );
    const engine = new LoopEngine({
      loopId: `loop_${routing.task.task_id}`,
      workspacePath,
      stateFilePath,
      sources: [],
      inputTasks: [routing.task],
      skipCompletedTasks: false,
      agentId: routing.profile.builder_agent_id,
      adapters: this.deps.adapters?.() ?? defaultAdapters(),
      verifierAgentIds: [routing.profile.evaluator_agent_id],
      enforceRoleSeparation: true,
      profileRouting: {
        profile_name: routing.profile.profile_name,
        reason: routing.profile.reason,
        builder_agent_id: routing.profile.builder_agent_id,
        evaluator_agent_id: routing.profile.evaluator_agent_id,
        builder_identity: routing.profile.builder_identity,
        evaluator_identity: routing.profile.evaluator_identity,
        independent: routing.profile.independent,
        independence_reason: routing.profile.independence_reason,
        ...(routing.profile.designer_agent_id === undefined
          ? {}
          : {
              designer_agent_id:
                routing.profile.designer_agent_id,
            }),
        ...(routing.profile.designer_identity === undefined
          ? {}
          : {
              designer_identity:
                routing.profile.designer_identity,
            }),
      },
      verifyCommands: routing.verify_commands,
      maxIterations: 1,
      commandTimeoutMs: routing.command_timeout_ms,
      artifactVerification: { requireGitDiff: true },
      policyGate: makePolicyGate(workspacePath),
    });
    const result = await engine.runOnce();
    if (result.policy?.denied === true) {
      throw new Error(result.policy.reason);
    }
    const completed = result.completedTasks.at(-1);
    if (completed === undefined) {
      throw new Error("guarded local loop produced no task result");
    }
    await writeFile(
      join(routing.evidence_root, "events.json"),
      `${JSON.stringify(result.events, null, 2)}\n`,
      "utf8",
    );
    const postDiff = await stageGuardedCandidate({
      workspace_path: workspacePath,
      expected_base_commit_sha: routing.base_commit_sha,
      commands: routing.verify_commands,
    });
    const governance = await this.deps.evaluateGovernance?.(
      workspacePath,
    );
    const reviewsPass = reviewPassed(completed);
    const verificationPass =
      completed.outcome === "success"
      && (completed.verify_commands ?? []).every(
        (command) => command.exit_code === 0,
      );
    return LocalDeliveryResult.parse({
      verification_passed:
        verificationPass && governance?.blocking !== true,
      review_passed: reviewsPass,
      post_diff: postDiff,
      progress: {
        finding_fingerprints: findingFingerprints(completed),
        changed_files_sha256: sha256(
          JSON.stringify({
            paths: postDiff.changed_paths,
            diff: postDiff.staged_diff_binary,
          }),
        ),
        verification_sha256: sha256(
          JSON.stringify({
            outcome: completed.outcome,
            verify_commands: completed.verify_commands ?? [],
            verify_issues: completed.verify_issues ?? [],
            review_artifacts: completed.review_artifacts ?? [],
            governance: governance?.evidence ?? null,
          }),
        ),
        failed_commands: failedCommands(completed),
        acceptance_score:
          verificationPass
            && reviewsPass
            && governance?.blocking !== true
            ? 1
            : 0,
      },
      builder_identity: runtimeIdentity(
        routing.profile.builder_identity,
      ),
      evaluator_identity: runtimeIdentity(
        routing.profile.evaluator_identity,
      ),
    });
  }
}
