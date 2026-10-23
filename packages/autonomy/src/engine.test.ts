import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  AUTONOMY_EMPTY_DIFF_SHA256,
  type ScopedApprovalDecision,
  type ScopedApprovalDecisionPayload,
  type ScopedApprovalRequest,
} from "@osstack/protocol";
import { freezeDeliveryContract, deliveryCheckReference, type DeployTargetPolicy } from "@osstack/core";
import { describe, expect, it } from "vitest";
import {
  canonicalScopedApprovalDecisionPayload,
} from "./approval.js";
import {
  GuardedDeliveryEngine,
  type AutonomyRunProjection,
  type FinalProofInput,
  type GuardedDeliveryPolicy,
  type GuardedDeliveryPorts,
  type LocalDeliveryResult,
} from "./engine.js";
import {
  evaluateDeployEligibility,
} from "./deploy-policy.js";
import type {
  ProjectDeployResult,
} from "./deploy-runner.js";
import type {
  AutonomyTaskIntent,
  DeliveryBudget,
  PostDiffInput,
} from "./types.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY = publicKey.export({
  type: "spki",
  format: "pem",
}).toString();
const NOW = "2026-07-28T18:00:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const DEPLOY_SHA = "e".repeat(64);

function intent(
  expectedPaths: string[],
  requestedActions = ["build", "verify"],
  goal = "Implement the scoped change",
): AutonomyTaskIntent {
  return {
    autonomy_run_id: "run-1",
    task_id: "task-1",
    repo_id: "owner/repo",
    workspace_path: "/tmp/repo",
    goal,
    expected_paths: expectedPaths,
    requested_actions: [...requestedActions].sort(),
    contract_sha256: SHA_A,
  };
}

function postDiff(paths: string[]): PostDiffInput {
  return {
    base_commit_sha: "1".repeat(40),
    changed_paths: [...paths].sort(),
    staged_diff_binary:
      paths.length === 0
        ? ""
        : paths.map((path) => `diff --git a/${path} b/${path}\n+change`).join("\n"),
    status_porcelain_v1_z:
      paths.map((path) => `M  ${path}\0`).join(""),
    commands: ["pnpm test"],
    dependency_changes: [],
  };
}

function progress(seed: string, score = 1) {
  return {
    finding_fingerprints: [],
    changed_files_sha256: seed.repeat(64).slice(0, 64),
    verification_sha256: seed.toUpperCase().toLowerCase().repeat(64).slice(0, 64),
    failed_commands: [],
    acceptance_score: score,
  };
}

function localSuccess(paths: string[]): LocalDeliveryResult {
  return {
    verification_passed: true,
    review_passed: true,
    post_diff: postDiff(paths),
    progress: {
      ...progress("2"),
      verification_sha256: "3".repeat(64),
    },
    builder_identity: {
      provider_id: "anthropic",
      model_id: "claude",
      evidence_source: "reported",
    },
    evaluator_identity: {
      provider_id: "kimi",
      model_id: "kimi-k3",
      evidence_source: "reported",
    },
  };
}

function localFailure(paths: string[]): LocalDeliveryResult {
  return {
    ...localSuccess(paths),
    review_passed: false,
    progress: {
      finding_fingerprints: ["finding-1"],
      changed_files_sha256: "4".repeat(64),
      verification_sha256: "5".repeat(64),
      failed_commands: ["review"],
      acceptance_score: 0.2,
    },
  };
}

function deployTarget(
  patch: Partial<DeployTargetPolicy> = {},
): DeployTargetPolicy {
  return {
    enabled: true,
    command: ["node", "scripts/deploy.mjs"],
    verify_command: ["node", "scripts/verify.mjs"],
    health_check: ["node", "scripts/health.mjs"],
    rollback: ["node", "scripts/rollback.mjs"],
    timeout_ms: 5_000,
    health_timeout_ms: 5_000,
    allowed_change_types: ["docs", "source"],
    allowed_paths: ["docs/**", "src/**"],
    forbidden_paths: [],
    allowed_base_branches: ["main"],
    allowed_environment: [],
    freeze_windows: [],
    ...patch,
  };
}

function commandEvidence(exitCode = 0) {
  return {
    argv: ["node", "scripts/fake.mjs"],
    exit_code: exitCode,
    duration_ms: 10,
    stdout_summary: "",
    stderr_summary: "",
    timed_out: false,
  };
}

function healthyDeploy(
  target: "staging" | "production",
): ProjectDeployResult {
  return {
    target,
    deploy: commandEvidence(),
    verify: commandEvidence(),
    health: commandEvidence(),
    outcome: "healthy",
  };
}

function signDecision(
  request: ScopedApprovalRequest,
  overrides: Partial<ScopedApprovalDecisionPayload> = {},
): ScopedApprovalDecision {
  const payload: ScopedApprovalDecisionPayload = {
    approval_id: request.approval_id,
    request_sha256: request.request_sha256,
    autonomy_run_id: request.autonomy_run_id,
    phase: request.phase,
    contract_sha256: request.contract_sha256,
    diff_sha256: request.diff_sha256,
    action_scope: request.action_scope,
    decision: "approve",
    nonce: request.nonce,
    issued_at: NOW,
    expires_at: "2026-07-28T19:00:00.000Z",
    decided_by: { type: "human", id: "owner" },
    ...overrides,
  };
  return {
    payload,
    signature: {
      algorithm: "Ed25519",
      key_id: "owner-key",
      value_base64url: sign(
        null,
        Buffer.from(canonicalScopedApprovalDecisionPayload(payload)),
        privateKey,
      ).toString("base64url"),
    },
  };
}

class Harness {
  readonly calls: string[] = [];
  readonly usedNonces = new Set<string>();
  projection: AutonomyRunProjection | undefined;
  localResults: LocalDeliveryResult[] = [localSuccess(["docs/readme.md"])];
  candidateFailure: Error | undefined;
  gitFailure: Error | undefined;
  finalFailure: Error | undefined;
  prepareMergedFailure: Error | undefined;
  productionFrozen = false;
  deployResults: ProjectDeployResult[] = [];
  readonly finalProofInputs: FinalProofInput[] = [];

  readonly policy: GuardedDeliveryPolicy = {
    policy_sha256: SHA_B,
    protected_policy_paths: [],
    routing: { builder: "claude-code", evaluator: "kimi-code" },
    budget: {
      max_builder_iterations: 3,
      max_review_rounds: 3,
      max_wall_time_ms: 5_400_000,
      max_no_progress_rounds: 2,
    },
    approval_ttl_ms: 3_600_000,
    trusted_approval_public_keys: new Map([["owner-key", PUBLIC_KEY]]),
    consume_approval_nonce: (nonce) => {
      if (this.usedNonces.has(nonce)) return false;
      this.usedNonces.add(nonce);
      return true;
    },
    git: {
      remote: "origin",
      base: "main",
      branch: "codex/run-1",
      title: "Guarded delivery",
      body_file: "/tmp/body.md",
      ci_timeout_ms: 60_000,
    },
  };

  readonly ports: GuardedDeliveryPorts = {
    now: () => new Date(NOW),
    load: async (autonomyRunId) => {
      this.calls.push("load");
      return this.projection?.autonomy_run_id === autonomyRunId
        ? this.projection
        : undefined;
    },
    persist: async (transition) => {
      this.calls.push(`persist:${transition.to_state}`);
      expect(transition.from_state).toBe(this.projection?.state ?? "queued");
      const context = {
        ...(this.projection?.context ?? {}),
        ...(transition.context_patch ?? {}),
      };
      this.projection = {
        autonomy_run_id: transition.autonomy_run_id,
        state: transition.to_state,
        revision: (this.projection?.revision ?? 0) + 1,
        context,
      };
      return this.projection;
    },
    runLocal: async () => {
      expect(this.projection?.state).toBe("building");
      this.calls.push("runLocal");
      const result = this.localResults.shift();
      if (result === undefined) throw new Error("missing fake local result");
      return result;
    },
    writeCandidateProof: async () => {
      expect(this.projection?.state).toBe("candidate_proof");
      this.calls.push("writeCandidateProof");
      if (this.candidateFailure !== undefined) throw this.candidateFailure;
      return {
        manifest_path: "/tmp/candidate/manifest.json",
        manifest_sha256: SHA_C,
      };
    },
    writeFinalProof: async (input) => {
      expect(this.projection?.state).toBe("final_proof");
      this.calls.push("writeFinalProof");
      this.finalProofInputs.push(input);
      if (this.finalFailure !== undefined) throw this.finalFailure;
      return {
        manifest_path: "/tmp/final/manifest.json",
        manifest_sha256: "d".repeat(64),
      };
    },
    commit: async () => {
      expect(this.projection?.state).toBe("committing");
      this.calls.push("commit");
      return { commit: "6".repeat(40) };
    },
    deliverGit: async () => {
      expect(this.projection?.state).toBe("pushing");
      this.calls.push("deliverGit");
      if (this.gitFailure !== undefined) throw this.gitFailure;
      return {
        pushedCommit: "6".repeat(40),
        pr: {
          number: 42,
          url: "https://github.com/owner/repo/pull/42",
          reused: false,
        },
        mergeCommit: "7".repeat(40),
        mergedAt: "2026-07-28T18:05:00.000Z",
      };
    },
    prepareMergedWorkspace: async () => {
      this.calls.push("prepareMergedWorkspace");
      if (this.prepareMergedFailure !== undefined) {
        throw this.prepareMergedFailure;
      }
    },
    resolveDeployScriptAuthority: async () => {
      this.calls.push("resolveDeployScriptAuthority");
      return {
        schema_version: 1,
        digest_sha256: DEPLOY_SHA,
        files: [
          {
            path: "scripts/deploy.mjs",
            sha256: DEPLOY_SHA,
          },
        ],
      };
    },
    evaluateDeploy: (policy, input) => {
      this.calls.push(`evaluateDeploy:${input.target}`);
      return evaluateDeployEligibility(policy, input);
    },
    deploy: async (input) => {
      this.calls.push(`deploy:${input.target}`);
      const result = this.deployResults.shift();
      if (result === undefined) {
        throw new Error("missing fake deploy result");
      }
      await input.before_phase?.("deploy");
      await input.before_phase?.("verify");
      await input.before_phase?.("health");
      if (result.rollback !== undefined) {
        await input.before_phase?.("rollback");
        if (result.post_rollback_health !== undefined) {
          await input.before_phase?.("post_rollback_health");
        }
      }
      return result;
    },
    isProductionFrozen: async () => {
      this.calls.push("isProductionFrozen");
      return this.productionFrozen;
    },
    freezeProduction: async (input) => {
      this.calls.push("freezeProduction");
      return {
        repo_id: input.repo_id,
        reason: input.reason,
        source_run_id: input.source_run_id,
        frozen_at: input.frozen_at,
      };
    },
  };

  engine(): GuardedDeliveryEngine {
    return new GuardedDeliveryEngine(this.policy, this.ports);
  }
}

describe("GuardedDeliveryEngine", () => {
  it("completes R0 without invoking a local or delivery write port", async () => {
    const harness = new Harness();
    const result = await harness.engine().start(
      intent([], ["read"], "Read and report repository status"),
    );

    expect(result.status).toBe("completed");
    expect(result.run.state).toBe("completed");
    expect(harness.calls).not.toContain("runLocal");
    expect(harness.calls).not.toContain("writeCandidateProof");
    expect(harness.calls).not.toContain("commit");
    expect(harness.calls).not.toContain("deliverGit");
  });

  it("takes an R1 documentation change through final proof", async () => {
    const harness = new Harness();
    const result = await harness.engine().start(intent(["docs/readme.md"]));

    expect(result.status).toBe("completed");
    expect(result.run.state).toBe("completed");
    expect(harness.calls).toEqual(expect.arrayContaining([
      "runLocal",
      "writeCandidateProof",
      "commit",
      "deliverGit",
      "writeFinalProof",
    ]));
    expect(harness.calls.some((call) => call.startsWith("deploy:"))).toBe(
      false,
    );
  });

  it("escalates R2 when repository auto-risk is capped at R1", async () => {
    const harness = new Harness();
    harness.policy.max_auto_risk = "R1";

    const result = await harness.engine().start(intent(["src/app.ts"]));

    expect(result.status).toBe("blocked");
    expect(result.run.state).toBe("escalated");
    expect(result.reason).toMatch(/max_auto_risk R1/);
    expect(result.approval_request).toBeUndefined();
    expect(harness.calls).not.toContain("runLocal");
  });

  it("requires reported provider-or-model independence for R2", async () => {
    const harness = new Harness();
    harness.localResults = [{
      ...localSuccess(["src/app.ts"]),
      evaluator_identity: {
        provider_id: "anthropic",
        model_id: "claude",
        evidence_source: "reported",
      },
    }];

    const result = await harness.engine().start(intent(["src/app.ts"]));

    expect(result.status).toBe("blocked");
    expect(result.run.state).toBe("escalated");
    expect(result.reason).toMatch(/independent evaluator/);
    expect(harness.calls).not.toContain("writeCandidateProof");
  });

  it("returns needs_approval for R3 before local execution", async () => {
    const harness = new Harness();
    const result = await harness.engine().start(intent(["src/auth/login.ts"]));

    expect(result.status).toBe("needs_approval");
    expect(result.run.state).toBe("awaiting_approval");
    expect(result.approval_request).toMatchObject({
      phase: "preflight",
      diff_sha256: AUTONOMY_EMPTY_DIFF_SHA256,
      action_scope: ["build", "verify"],
    });
    expect(harness.calls).not.toContain("runLocal");
  });

  it("resumes approved R3 only with the matching request digest", async () => {
    const harness = new Harness();
    harness.localResults = [localSuccess(["src/auth/login.ts"])];
    const waiting = await harness.engine().start(intent(["src/auth/login.ts"]));
    const request = waiting.approval_request!;

    await expect(harness.engine().resume(
      "run-1",
      signDecision(request, { request_sha256: "e".repeat(64) }),
    )).rejects.toThrow(/request_sha256 does not match request/);
    expect(harness.calls).not.toContain("runLocal");

    const resumed = await harness.engine().resume(
      "run-1",
      signDecision(request),
    );
    expect(resumed.status).toBe("needs_approval");
    expect(resumed.approval_request?.phase).toBe("post_diff");
    expect(harness.calls).toContain("runLocal");
  });

  it("requires post-diff approval when preflight was R3 even if the diff is lower risk", async () => {
    const harness = new Harness();
    harness.localResults = [localSuccess(["docs/readme.md"])];
    const waiting = await harness.engine().start(
      intent(["src/auth/login.ts"]),
    );

    const resumed = await harness.engine().resume(
      "run-1",
      signDecision(waiting.approval_request!),
    );

    expect(resumed.status).toBe("needs_approval");
    expect(resumed.run.state).toBe("awaiting_approval");
    expect(resumed.approval_request).toMatchObject({
      phase: "post_diff",
      action_scope: ["commit", "merge", "push"],
    });
    expect(resumed.run.context.post_diff_risk).toMatchObject({
      phase: "post_diff",
      level: "R3",
      signals: expect.arrayContaining([
        expect.objectContaining({
          rule_id: "risk.preflight-r3-carry-forward",
          level: "R3",
        }),
      ]),
    });
    expect(harness.calls).not.toContain("writeCandidateProof");
    expect(harness.calls).not.toContain("commit");
  });

  it("rechecks post-diff approval scope immediately before commit", async () => {
    const harness = new Harness();
    harness.localResults = [localSuccess(["src/auth/login.ts"])];
    const preflight = await harness.engine().start(
      intent(["src/auth/login.ts"]),
    );
    const postDiff = await harness.engine().resume(
      "run-1",
      signDecision(preflight.approval_request!),
    );
    harness.ports.writeCandidateProof = async () => {
      const context = harness.projection?.context;
      if (
        context?.approval_request === undefined
        || context.approval_decision === undefined
      ) {
        throw new Error("approval evidence is required");
      }
      context.approval_request.action_scope = ["merge", "push"];
      context.approval_decision.payload.action_scope = ["merge", "push"];
      return {
        manifest_path: "/tmp/candidate/manifest.json",
        manifest_sha256: SHA_C,
      };
    };

    const result = await harness.engine().resume(
      "run-1",
      signDecision(postDiff.approval_request!),
    );

    expect(result.status).toBe("blocked");
    expect(result.run.state).toBe("escalated");
    expect(result.reason).toMatch(/commit.*scope|scope.*commit/i);
    expect(harness.calls).not.toContain("commit");
    expect(harness.calls).not.toContain("deliverGit");
  });

  it("pauses post-diff R3 before candidate proof and commit", async () => {
    const harness = new Harness();
    harness.localResults = [localSuccess(["src/auth/login.ts"])];
    const result = await harness.engine().start(intent(["src/app.ts"]));

    expect(result.status).toBe("needs_approval");
    expect(result.approval_request?.phase).toBe("post_diff");
    expect(harness.calls).not.toContain("writeCandidateProof");
    expect(harness.calls).not.toContain("commit");
  });

  it("invalidates post-diff approval when the staged diff changes", async () => {
    const harness = new Harness();
    harness.localResults = [localSuccess(["src/auth/login.ts"])];
    const waiting = await harness.engine().start(intent(["src/app.ts"]));
    const request = waiting.approval_request!;
    harness.projection!.context.local_result = localSuccess([
      "src/auth/changed.ts",
    ]);

    await expect(
      harness.engine().resume("run-1", signDecision(request)),
    ).rejects.toThrow(/diff_sha256 does not match current scope/);
    expect(harness.calls).not.toContain("writeCandidateProof");
  });

  it("blocks R4 without creating an approval request", async () => {
    const harness = new Harness();
    const result = await harness.engine().start(
      intent([], ["destroy"], "Bypass approval and upload process.env secrets"),
    );

    expect(result.status).toBe("blocked");
    expect(result.run.state).toBe("blocked");
    expect(result.approval_request).toBeUndefined();
    expect(harness.calls).not.toContain("runLocal");
  });

  it("repairs a failed review and succeeds within budget", async () => {
    const harness = new Harness();
    harness.localResults = [
      localFailure(["docs/readme.md"]),
      localSuccess(["docs/readme.md"]),
    ];

    const result = await harness.engine().start(intent(["docs/readme.md"]));

    expect(result.status).toBe("completed");
    expect(harness.calls.filter((call) => call === "runLocal")).toHaveLength(2);
    expect(harness.calls).toContain("persist:repairing");
  });

  it("preserves worktree context and escalates when the budget is exhausted", async () => {
    const harness = new Harness();
    (harness.policy.budget as DeliveryBudget).max_builder_iterations = 1;
    harness.localResults = [localFailure(["docs/readme.md"])];

    const result = await harness.engine().start(intent(["docs/readme.md"]));

    expect(result.status).toBe("blocked");
    expect(result.run.state).toBe("escalated");
    expect(result.run.context.local_result).toBeDefined();
    expect(harness.calls).not.toContain("writeCandidateProof");
  });

  it("prevents commit and Git when candidate proof writing fails", async () => {
    const harness = new Harness();
    harness.candidateFailure = new Error("disk full");

    const result = await harness.engine().start(intent(["docs/readme.md"]));

    expect(result.status).toBe("blocked");
    expect(result.run.state).toBe("delivery_evidence_failed");
    expect(harness.calls).not.toContain("commit");
    expect(harness.calls).not.toContain("deliverGit");
  });

  it("turns a Git delivery failure into blocked_delivery", async () => {
    const harness = new Harness();
    harness.gitFailure = new Error("remote unavailable");

    const result = await harness.engine().start(intent(["docs/readme.md"]));

    expect(result.status).toBe("blocked");
    expect(result.run.state).toBe("blocked_delivery");
    expect(result.run.context.blocked_delivery_resume_state).toBe("pushing");
    expect(harness.calls).toContain("runLocal");
    expect(harness.calls).toContain("writeCandidateProof");
    expect(harness.calls).toContain("commit");
    expect(harness.calls).toContain("deliverGit");
    expect(harness.calls).not.toContain("deploy");
  });

  it("leaves final proof failures in delivery_evidence_failed", async () => {
    const harness = new Harness();
    harness.finalFailure = new Error("proof volume unavailable");

    const result = await harness.engine().start(intent(["docs/readme.md"]));

    expect(result.status).toBe("blocked");
    expect(result.run.state).toBe("delivery_evidence_failed");
    expect(harness.calls).toContain("deliverGit");
  });

  it("persists each side-effect state before invoking its port", async () => {
    const harness = new Harness();
    await harness.engine().start(intent(["docs/readme.md"]));

    for (const [persisted, sideEffect] of [
      ["persist:building", "runLocal"],
      ["persist:candidate_proof", "writeCandidateProof"],
      ["persist:committing", "commit"],
      ["persist:pushing", "deliverGit"],
      ["persist:final_proof", "writeFinalProof"],
    ] as const) {
      expect(harness.calls.indexOf(persisted)).toBeLessThan(
        harness.calls.indexOf(sideEffect),
      );
    }
  });

  it("runs healthy staging after merge and includes deploy evidence in final proof", async () => {
    const harness = new Harness();
    harness.policy.deploy = {
      base_branch: "main",
      staging: deployTarget(),
    };
    harness.deployResults = [healthyDeploy("staging")];

    const result = await harness.engine().start(intent(["docs/readme.md"]));

    expect(result).toMatchObject({
      status: "completed",
      run: {
        context: {
          deploy_outcome: "staging_healthy",
          deploy_staging: {
            target: "staging",
            outcome: "healthy",
          },
        },
      },
    });
    expect(harness.calls.indexOf("deliverGit")).toBeLessThan(
      harness.calls.indexOf("prepareMergedWorkspace"),
    );
    expect(harness.calls.indexOf("prepareMergedWorkspace")).toBeLessThan(
      harness.calls.indexOf("deploy:staging"),
    );
    expect(harness.calls).toEqual(expect.arrayContaining([
      "persist:deploying_staging",
      "persist:verifying_staging",
    ]));
    expect(harness.finalProofInputs.at(-1)).toMatchObject({
      deploy_outcome: "staging_healthy",
      deploy_eligibility: {
        staging: { allowed: true },
      },
      deploy_staging: { outcome: "healthy" },
    });
  });

  it("runs production only after healthy staging and a matching rollback drill", async () => {
    const harness = new Harness();
    harness.policy.deploy = {
      base_branch: "main",
      staging: deployTarget(),
      production: deployTarget(),
      rollback_drill: {
        passed_at: NOW,
        deploy_script_digest_sha256: DEPLOY_SHA,
        post_rollback_health_passed: true,
      },
    };
    harness.deployResults = [
      healthyDeploy("staging"),
      healthyDeploy("production"),
    ];

    const result = await harness.engine().start(intent(["src/app.ts"]));

    expect(result).toMatchObject({
      status: "completed",
      run: {
        context: {
          deploy_outcome: "production_healthy",
          deploy_staging: { outcome: "healthy" },
          deploy_production: { outcome: "healthy" },
        },
      },
    });
    expect(harness.calls.indexOf("deploy:staging")).toBeLessThan(
      harness.calls.indexOf("deploy:production"),
    );
    expect(harness.calls).toContain("persist:health_checking");
  });

  it("binds an R3 approval to the exact configured deploy action", async () => {
    const harness = new Harness();
    harness.policy.deploy = {
      base_branch: "main",
      staging: deployTarget(),
    };
    harness.localResults = [localSuccess(["src/auth/login.ts"])];
    harness.deployResults = [healthyDeploy("staging")];

    const preflight = await harness.engine().start(
      intent(["src/auth/login.ts"]),
    );
    const postDiff = await harness.engine().resume(
      "run-1",
      signDecision(preflight.approval_request!),
    );
    expect(postDiff.approval_request?.action_scope).toEqual([
      "commit",
      "deploy:staging",
      "merge",
      "push",
    ]);

    const result = await harness.engine().resume(
      "run-1",
      signDecision(postDiff.approval_request!),
    );
    expect(result.status).toBe("completed");
    expect(harness.calls).toContain("deploy:staging");
  });

  it("records denylisted staging eligibility without invoking deployment", async () => {
    const harness = new Harness();
    harness.policy.deploy = {
      base_branch: "main",
      staging: deployTarget({
        forbidden_paths: ["docs/private/**"],
      }),
    };
    harness.localResults = [localSuccess(["docs/private/readme.md"])];

    const result = await harness.engine().start(
      intent(["docs/private/readme.md"]),
    );

    expect(result).toMatchObject({
      status: "completed",
      run: {
        context: {
          deploy_outcome: "staging_skipped",
          deploy_eligibility: {
            staging: {
              allowed: false,
              reasons: expect.arrayContaining([
                "forbidden_path:docs/private/readme.md",
              ]),
            },
          },
        },
      },
    });
    expect(harness.calls).not.toContain("deploy:staging");
  });

  it("rolls an unhealthy production release back, freezes, and proves it", async () => {
    const harness = new Harness();
    harness.policy.deploy = {
      base_branch: "main",
      staging: deployTarget(),
      production: deployTarget(),
      rollback_drill: {
        passed_at: NOW,
        deploy_script_digest_sha256: DEPLOY_SHA,
        post_rollback_health_passed: true,
      },
    };
    harness.deployResults = [
      healthyDeploy("staging"),
      {
        target: "production",
        deploy: commandEvidence(),
        verify: commandEvidence(),
        health: commandEvidence(9),
        rollback: commandEvidence(),
        post_rollback_health: commandEvidence(),
        outcome: "health_failed_rolled_back",
      },
    ];

    const result = await harness.engine().start(intent(["src/app.ts"]));

    expect(result).toMatchObject({
      status: "completed",
      run: {
        context: {
          deploy_outcome: "production_rolled_back",
          production_freeze: {
            repo_id: "owner/repo",
            source_run_id: "run-1",
          },
        },
      },
    });
    expect(harness.calls).toEqual(expect.arrayContaining([
      "persist:rolling_back",
      "freezeProduction",
      "persist:deploy_frozen",
    ]));
    expect(harness.finalProofInputs.at(-1)).toMatchObject({
      deploy_production: {
        rollback: { exit_code: 0 },
        post_rollback_health: { exit_code: 0 },
      },
      production_freeze: {
        source_run_id: "run-1",
      },
    });
  });

  it("writes final rollback evidence and escalates failed rollback health", async () => {
    const harness = new Harness();
    harness.policy.deploy = {
      base_branch: "main",
      staging: deployTarget(),
      production: deployTarget(),
      rollback_drill: {
        passed_at: NOW,
        deploy_script_digest_sha256: DEPLOY_SHA,
        post_rollback_health_passed: true,
      },
    };
    harness.deployResults = [
      healthyDeploy("staging"),
      {
        target: "production",
        deploy: commandEvidence(),
        verify: commandEvidence(),
        health: commandEvidence(9),
        rollback: commandEvidence(),
        post_rollback_health: commandEvidence(9),
        outcome: "rollback_failed",
      },
    ];

    const result = await harness.engine().start(intent(["src/app.ts"]));

    expect(result).toMatchObject({
      status: "blocked",
      run: {
        state: "escalated",
        context: {
          deploy_outcome: "rollback_failed",
          final_proof: {
            manifest_sha256: "d".repeat(64),
          },
        },
      },
    });
    expect(harness.calls).toContain("writeFinalProof");
  });

  it("allows staging but skips production while a durable freeze is active", async () => {
    const harness = new Harness();
    harness.productionFrozen = true;
    harness.policy.deploy = {
      base_branch: "main",
      staging: deployTarget(),
      production: deployTarget(),
      rollback_drill: {
        passed_at: NOW,
        deploy_script_digest_sha256: DEPLOY_SHA,
        post_rollback_health_passed: true,
      },
    };
    harness.deployResults = [healthyDeploy("staging")];

    const result = await harness.engine().start(intent(["src/app.ts"]));

    expect(result).toMatchObject({
      status: "completed",
      run: {
        context: {
          deploy_outcome: "production_skipped",
          deploy_eligibility: {
            production: {
              allowed: false,
              reasons: expect.arrayContaining(["production_frozen"]),
            },
          },
        },
      },
    });
    expect(harness.calls).toContain("deploy:staging");
    expect(harness.calls).not.toContain("deploy:production");
  });

  it("writes final evidence when the staging deploy port throws", async () => {
    const harness = new Harness();
    harness.policy.deploy = {
      base_branch: "main",
      staging: deployTarget(),
    };

    const result = await harness.engine().start(intent(["src/app.ts"]));

    expect(result).toMatchObject({
      status: "blocked",
      run: {
        state: "escalated",
        context: {
          deploy_outcome: "staging_failed",
          final_proof: {
            manifest_sha256: "d".repeat(64),
          },
        },
      },
    });
    expect(harness.calls).toContain("writeFinalProof");
  });

  it("never deploys and escalates after proving a merged-tree mismatch", async () => {
    const harness = new Harness();
    harness.prepareMergedFailure = new Error("merged tree mismatch");
    harness.policy.deploy = {
      base_branch: "main",
      staging: deployTarget(),
    };

    const result = await harness.engine().start(intent(["src/app.ts"]));

    expect(result).toMatchObject({
      status: "blocked",
      run: {
        state: "escalated",
        context: {
          deploy_outcome: "staging_skipped",
          final_proof: {
            manifest_sha256: "d".repeat(64),
          },
        },
      },
    });
    expect(harness.calls).not.toContain("deploy:staging");
    expect(harness.calls).toContain("writeFinalProof");
  });

  it("freezes production when the deploy port throws after staging", async () => {
    const harness = new Harness();
    harness.policy.deploy = {
      base_branch: "main",
      staging: deployTarget(),
      production: deployTarget(),
      rollback_drill: {
        passed_at: NOW,
        deploy_script_digest_sha256: DEPLOY_SHA,
        post_rollback_health_passed: true,
      },
    };
    harness.deployResults = [healthyDeploy("staging")];

    const result = await harness.engine().start(intent(["src/app.ts"]));

    expect(result).toMatchObject({
      status: "blocked",
      run: {
        state: "escalated",
        context: {
          deploy_outcome: "rollback_failed",
          production_freeze: {
            source_run_id: "run-1",
          },
          final_proof: {
            manifest_sha256: "d".repeat(64),
          },
        },
      },
    });
    expect(harness.calls).toEqual(expect.arrayContaining([
      "persist:rolling_back",
      "freezeProduction",
      "persist:deploy_frozen",
      "writeFinalProof",
    ]));
  });

  it.each([
    "deploying_production",
    "health_checking",
    "rolling_back",
  ] as const)(
    "freezes production when recovery finds %s without durable deploy evidence",
    async (state) => {
      const harness = new Harness();
      harness.policy.deploy = {
        base_branch: "main",
        staging: deployTarget(),
        production: deployTarget(),
        rollback_drill: {
          passed_at: NOW,
          deploy_script_digest_sha256: DEPLOY_SHA,
          post_rollback_health_passed: true,
        },
      };
      harness.deployResults = [
        healthyDeploy("staging"),
        healthyDeploy("production"),
      ];
      await harness.engine().start(intent(["src/app.ts"]));
      const completed = harness.projection!;
      const recoveryContext = { ...completed.context };
      delete recoveryContext.deploy_production;
      delete recoveryContext.deploy_outcome;
      delete recoveryContext.final_proof;
      delete recoveryContext.production_freeze;
      harness.projection = {
        ...completed,
        state,
        revision: completed.revision + 1,
        context: recoveryContext,
      };
      harness.calls.length = 0;

      const recovered = await harness.engine().resume("run-1");

      expect(recovered).toMatchObject({
        status: "blocked",
        run: {
          state: "escalated",
          context: {
            deploy_outcome: "rollback_failed",
            production_freeze: {
              repo_id: "owner/repo",
              source_run_id: "run-1",
            },
          },
        },
      });
      expect(harness.calls).toEqual(expect.arrayContaining([
        "freezeProduction",
        "persist:deploy_frozen",
        "writeFinalProof",
      ]));
    },
  );
});

function contractHarness(completion: "local_verified" | "pr_opened" = "local_verified") {
  const h = new Harness();
  const actions = completion === "local_verified" ? ["build", "verify"] : ["build", "verify", "commit", "push", "open_pr"];
  const task = intent(["docs/readme.md"], actions);
  const frozen = freezeDeliveryContract({ schema_version: 2, contract_id: "contract-1", task_id: task.task_id,
    canonical_repo: task.workspace_path, mode: "implement", base_head: "1".repeat(40), goal: task.goal,
    required_checks: [{ id: "tests", registry_ref: deliveryCheckReference("pnpm test") }], review_policy_ref: "profile:test",
    requested_completion: completion, allowed_paths: ["docs/readme.md"], requested_actions: actions,
    budget_ref: "policy", policy_digest: SHA_B, publication_scope: completion === "local_verified" ? { mode: "none" } : {
      mode: "review_pr", hostname: "github.com", repository: "owner/repo", remote: "origin", base_ref: "main", head_ref: "codex/run-1" }, merge_authority: { mode: "none" } });
  h.policy.delivery_contract = frozen;
  h.localResults = [{ ...localSuccess(["docs/readme.md"]), delivery_receipt: { path: "/tmp/receipt.json", digest: SHA_A } }];
  h.ports.verifyContractReceipt = async () => { h.calls.push("verifyContractReceipt"); };
  h.ports.writeContractCompletionReceipt = async (input) => { h.calls.push(`completion:${input.achievedCompletion}`); return { path: "/tmp/completion.json", digest: SHA_C }; };
  h.ports.openPullRequest = async () => { h.calls.push("openPullRequest"); return { pushedCommit: "6".repeat(40), pr: { number: 42, url: "https://github.com/owner/repo/pull/42", reused: false } }; };
  return { h, task: { ...task, contract_sha256: frozen.digest } };
}
describe("V2 contract completion ceilings", () => {
  it("signs only PR effects for R3 and completes approval through PR-only publication", async () => {
    const { h, task } = contractHarness("pr_opened");
    const frozen = freezeDeliveryContract({ ...h.policy.delivery_contract!.contract, allowed_paths: ["src/auth/login.ts"] });
    h.policy.delivery_contract = frozen;
    h.localResults = [{ ...localSuccess(["src/auth/login.ts"]), delivery_receipt: { path: "/tmp/receipt.json", digest: SHA_A } }];
    const runTask = { ...task, expected_paths: ["src/auth/login.ts"], contract_sha256: frozen.digest };
    const preflight = await h.engine().start(runTask);
    expect(preflight.status).toBe("needs_approval"); expect(preflight.approval_request?.action_scope).toEqual(["build", "verify"]);
    const postDiff = await h.engine().resume(runTask.autonomy_run_id, signDecision(preflight.approval_request!));
    expect(postDiff.status).toBe("needs_approval");
    expect(postDiff.approval_request).toMatchObject({ phase: "post_diff", action_scope: ["commit", "open_pr", "push"] });
    await expect(h.engine().resume(runTask.autonomy_run_id, signDecision(postDiff.approval_request!, { action_scope: ["commit", "merge", "open_pr", "push"] }))).rejects.toThrow();
    expect(h.calls).not.toContain("commit");
    const result = await h.engine().resume(runTask.autonomy_run_id, signDecision(postDiff.approval_request!));
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(h.calls.filter(call => call === "commit")).toHaveLength(1);
    expect(h.calls.filter(call => call === "openPullRequest")).toHaveLength(1);
    expect(h.calls).not.toContain("deliverGit"); expect(h.calls.filter(call => call.startsWith("deploy:"))).toEqual([]);
  });
  it.each(["commit", "push", "open_pr"])("rejects low-risk publication missing %s before starting", async missing => {
    const { h, task } = contractHarness("pr_opened");
    h.policy.delivery_contract!.contract.requested_actions = h.policy.delivery_contract!.contract.requested_actions.filter(action => action !== missing);
    await expect(h.engine().start(task)).rejects.toThrow();
    expect(h.calls).toEqual([]);
  });
  it("completes local verification without commit, push, merge or deploy", async () => {
    const { h, task } = contractHarness();
    const result = await h.engine().start(task);
    expect(result.status).toBe("completed");
    expect(result.run.context.achieved_completion).toBe("local_verified");
    expect(h.calls).toContain("completion:local_verified");
    expect(h.calls).not.toEqual(expect.arrayContaining(["commit"]));
    expect(h.calls).not.toContain("deliverGit");
    expect(h.calls).not.toContain("openPullRequest");
    expect(h.calls.filter(x => x.startsWith("deploy:"))).toEqual([]);
  });
  it("opens a PR through the existing publisher port and never invokes merge delivery", async () => {
    const { h, task } = contractHarness("pr_opened");
    let result = await h.engine().start(task);
    if (result.status === "needs_approval") result = await h.engine().resume(task.autonomy_run_id, signDecision(result.approval_request!));
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(h.calls).toContain("commit");
    expect(h.calls).toContain("openPullRequest");
    expect(h.calls).not.toContain("deliverGit");
    expect(result.run.context.achieved_completion).toBe("pr_opened");
  });
  it("refuses boolean local success without a host receipt", async () => {
    const { h, task } = contractHarness(); h.localResults = [localSuccess(["docs/readme.md"])];
    const result = await h.engine().start(task);
    expect(result.status).not.toBe("completed");
    expect(h.calls).not.toContain("writeCandidateProof");
    expect(h.calls).not.toContain("commit");
  });
  it("revalidates the candidate before side effects and fails closed on changed bytes", async () => {
    const { h, task } = contractHarness(); let reads = 0;
    h.ports.verifyContractReceipt = async () => { if (++reads > 1) throw new Error("candidate changed"); };
    const result = await h.engine().start(task);
    expect(result.status).not.toBe("completed"); expect(reads).toBe(2);
    expect(h.calls).not.toContain("commit");
  });
});

it("rejects a legacy projection resumed with a new V2 contract policy", async () => {
  const { h } = contractHarness(); const contract = h.policy.delivery_contract!;
  delete h.policy.delivery_contract;
  await h.engine().start(intent(["docs/readme.md"]));
  h.policy.delivery_contract = contract;
  await expect(h.engine().resume("run-1")).rejects.toThrow("delivery_contract_resume_mismatch");
});
it("rejects a persisted V2 projection resumed without its frozen policy contract", async () => {
  const { h, task } = contractHarness(); await h.engine().start(task); delete h.policy.delivery_contract;
  await expect(h.engine().resume("run-1")).rejects.toThrow("delivery_contract_resume_mismatch");
});
