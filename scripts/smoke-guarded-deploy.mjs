import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GuardedDeliveryEngine,
  computeDeployScriptAuthority,
  evaluateDeployEligibility,
  runProjectDeploy,
} from "../packages/autonomy/dist/index.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const COMMIT_SHA = "c".repeat(40);
const MERGE_SHA = "d".repeat(40);
const NOW = "2026-07-28T20:00:00.000Z";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceFixture = join(root, "fixtures", "autonomy", "r2-deploy");
const temporary = await mkdtemp(join(tmpdir(), "osstack-guarded-deploy-smoke-"));
const workspace = join(temporary, "workspace");
const proofRoot = join(temporary, "proof");
const statePath = join(temporary, "fixture-state.json");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function targetPolicy(command) {
  return {
    enabled: true,
    command: ["node", command],
    verify_command: ["node", "health-check.mjs"],
    health_check: ["node", "health-check.mjs"],
    rollback: ["node", "rollback.mjs"],
    timeout_ms: 5_000,
    health_timeout_ms: 5_000,
    allowed_change_types: ["source"],
    allowed_paths: ["src/**"],
    forbidden_paths: [],
    allowed_base_branches: ["main"],
    allowed_environment: [
      "OSSTACK_SOAK_FIXTURE_ONLY",
      "OSSTACK_SOAK_FIXTURE_STATE",
    ],
    freeze_windows: [],
  };
}

async function writeProof(stage, input) {
  const directory = join(proofRoot, stage);
  await mkdir(directory, { recursive: true });
  const artifact = `${JSON.stringify({
    schema_version: 1,
    stage,
    autonomy_run_id: input.autonomy_run_id,
    ...(stage === "final"
      ? {
          deploy_eligibility: input.deploy_eligibility,
          deploy_script_authority: input.deploy_script_authority,
          deploy_staging: input.deploy_staging,
          deploy_production: input.deploy_production,
          deploy_outcome: input.deploy_outcome,
        }
      : {}),
  }, null, 2)}\n`;
  await writeFile(join(directory, "delivery.json"), artifact, "utf8");
  const manifest = `${JSON.stringify({
    schema_version: 1,
    kind: "osstack.proof_pack",
    proof_stage: stage,
    run_id: input.autonomy_run_id,
    artifacts: [{
      path: "delivery.json",
      sha256: sha256(artifact),
      bytes: Buffer.byteLength(artifact),
    }],
  }, null, 2)}\n`;
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, manifest, "utf8");
  return {
    manifest_path: manifestPath,
    manifest_sha256: sha256(manifest),
  };
}

try {
  await cp(sourceFixture, workspace, { recursive: true });
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(
    join(workspace, "src", "greeting.ts"),
    'export const greeting = "deployed";\n',
    "utf8",
  );

  const staging = targetPolicy("deploy-staging.mjs");
  const production = targetPolicy("deploy-production.mjs");
  const productionAuthority = await computeDeployScriptAuthority({
    workspace_path: workspace,
    policy: production,
  });
  const timeline = [];
  let projection;
  let finalProofInput;
  let productionFrozen = false;
  const engine = new GuardedDeliveryEngine(
    {
      policy_sha256: SHA_A,
      max_auto_risk: "R2",
      protected_policy_paths: [
        ".osstack/repo.yaml",
        ".osstack/policy.yaml",
      ],
      routing: {
        builder: "fake-builder",
        evaluator: "fake-kimi",
      },
      budget: {
        max_builder_iterations: 2,
        max_review_rounds: 2,
        max_wall_time_ms: 60_000,
        max_no_progress_rounds: 1,
      },
      approval_ttl_ms: 60_000,
      trusted_approval_public_keys: new Map(),
      consume_approval_nonce: () => false,
      git: {
        remote: "origin",
        base: "main",
        branch: "osstack/guarded-deploy-smoke",
        title: "test: guarded deploy smoke",
        body_file: join(temporary, "pr-body.md"),
        ci_timeout_ms: 10_000,
      },
      deploy: {
        base_branch: "main",
        staging,
        production,
        rollback_drill: {
          passed_at: NOW,
          deploy_script_digest_sha256:
            productionAuthority.digest_sha256,
          post_rollback_health_passed: true,
        },
      },
    },
    {
      now: () => new Date(NOW),
      load: async (runId) =>
        projection?.autonomy_run_id === runId
          ? projection
          : undefined,
      persist: async (transition) => {
        timeline.push(`state:${transition.to_state}`);
        assert.equal(
          transition.from_state,
          projection?.state ?? "queued",
        );
        projection = {
          autonomy_run_id: transition.autonomy_run_id,
          state: transition.to_state,
          revision: (projection?.revision ?? 0) + 1,
          context: {
            ...(projection?.context ?? {}),
            ...(transition.context_patch ?? {}),
          },
        };
        return projection;
      },
      runLocal: async () => {
        timeline.push("effect:builder-reviewer");
        return {
          verification_passed: true,
          review_passed: true,
          post_diff: {
            base_commit_sha: "1".repeat(40),
            changed_paths: ["src/greeting.ts"],
            staged_diff_binary:
              "diff --git a/src/greeting.ts b/src/greeting.ts\n"
              + '+export const greeting = "deployed";\n',
            status_porcelain_v1_z: "M  src/greeting.ts\0",
            commands: ["pnpm test"],
            dependency_changes: [],
          },
          progress: {
            finding_fingerprints: [],
            changed_files_sha256: "2".repeat(64),
            verification_sha256: "3".repeat(64),
            failed_commands: [],
            acceptance_score: 1,
          },
          builder_identity: {
            provider_id: "anthropic",
            model_id: "claude",
            evidence_source: "reported",
          },
          evaluator_identity: {
            provider_id: "kimi",
            model_id: "kimi-code/k3",
            evidence_source: "reported",
          },
        };
      },
      writeCandidateProof: async (input) => {
        timeline.push("effect:candidate-proof");
        return writeProof("candidate", input);
      },
      commit: async () => {
        timeline.push("effect:commit");
        return { commit: COMMIT_SHA };
      },
      deliverGit: async () => {
        timeline.push("effect:fake-push-pr-ci-merge");
        return {
          pushedCommit: COMMIT_SHA,
          pr: {
            number: 42,
            url: "https://example.invalid/offline/pull/42",
            reused: false,
          },
          mergeCommit: MERGE_SHA,
          mergedAt: "2026-07-28T20:01:00.000Z",
        };
      },
      prepareMergedWorkspace: async (input) => {
        timeline.push("effect:prepare-merged-workspace");
        assert.equal(input.expected_merge_commit_sha, MERGE_SHA);
      },
      resolveDeployScriptAuthority: async (input) =>
        computeDeployScriptAuthority(input),
      evaluateDeploy: (policy, input) =>
        evaluateDeployEligibility(policy, input),
      deploy: async (input) => {
        timeline.push(`effect:deploy-${input.target}`);
        return runProjectDeploy({
          ...input,
          host_environment: {
            PATH: process.env.PATH,
            HOME: temporary,
            OSSTACK_SOAK_FIXTURE_ONLY: "1",
            OSSTACK_SOAK_FIXTURE_STATE: statePath,
          },
        });
      },
      isProductionFrozen: async () => productionFrozen,
      freezeProduction: async (input) => {
        productionFrozen = true;
        timeline.push("effect:freeze-production");
        return {
          ...input,
          frozen: true,
        };
      },
      writeFinalProof: async (input) => {
        timeline.push("effect:final-proof");
        finalProofInput = input;
        return writeProof("final", input);
      },
    },
  );

  const result = await engine.start({
    autonomy_run_id: "run-guarded-deploy-smoke",
    task_id: "task-guarded-deploy-smoke",
    repo_id: "fixture/guarded-deploy",
    workspace_path: workspace,
    goal: "Update the fixture greeting and deploy it",
    expected_paths: ["src/greeting.ts"],
    requested_actions: [
      "build",
      "commit",
      "deploy:production",
      "deploy:staging",
      "merge",
      "push",
      "verify",
    ],
    contract_sha256: SHA_B,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.run.state, "completed");
  assert.equal(result.run.context.deploy_outcome, "production_healthy");
  assert.equal(finalProofInput.deploy_staging.outcome, "healthy");
  assert.equal(finalProofInput.deploy_production.outcome, "healthy");
  assert.ok(
    timeline.indexOf("effect:candidate-proof")
      < timeline.indexOf("effect:fake-push-pr-ci-merge"),
  );
  assert.ok(
    timeline.indexOf("effect:fake-push-pr-ci-merge")
      < timeline.indexOf("effect:deploy-staging"),
  );
  assert.ok(
    timeline.indexOf("effect:deploy-staging")
      < timeline.indexOf("effect:deploy-production"),
  );
  assert.ok(
    timeline.indexOf("effect:deploy-production")
      < timeline.indexOf("effect:final-proof"),
  );
  assert.equal(productionFrozen, false);

  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.deployment, "production");
  assert.equal(state.healthy, true);
  assert.ok(
    state.events.some((event) => event.kind === "deploy_staging"),
  );
  assert.ok(
    state.events.some((event) => event.kind === "deploy_production"),
  );
  const finalManifestPath =
    result.run.context.final_proof.manifest_path;
  const finalManifest = JSON.parse(
    await readFile(finalManifestPath, "utf8"),
  );
  assert.equal(finalManifest.proof_stage, "final");
  const finalEvidence = JSON.parse(
    await readFile(join(dirname(finalManifestPath), "delivery.json"), "utf8"),
  );
  assert.equal(finalEvidence.deploy_staging.outcome, "healthy");
  assert.equal(finalEvidence.deploy_production.outcome, "healthy");
  assert.equal(finalEvidence.deploy_outcome, "production_healthy");

  console.log(JSON.stringify({
    smoke: "guarded-deploy",
    status: "passed",
    remote_writes: 0,
    run_id: result.run.autonomy_run_id,
    deploy_outcome: result.run.context.deploy_outcome,
    staging: finalEvidence.deploy_staging.outcome,
    production: finalEvidence.deploy_production.outcome,
    final_proof_verified: true,
    timeline,
  }, null, 2));
} finally {
  if (process.env.OSSTACK_KEEP_GUARDED_DEPLOY_SMOKE !== "1") {
    await rm(temporary, { recursive: true, force: true });
  } else {
    console.error(`kept guarded deploy smoke: ${temporary}`);
  }
}
