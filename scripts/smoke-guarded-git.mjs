import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GuardedDeliveryEngine,
} from "../packages/autonomy/dist/index.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const COMMIT_SHA = "c".repeat(40);
const MERGE_SHA = "d".repeat(40);

class FakeDelivery {
  constructor({ failAfterPr = false } = {}) {
    this.projection = undefined;
    this.timeline = [];
    this.issuedActionIds = [];
    this.externalActions = new Set();
    this.failAfterPr = failAfterPr;
    this.failedOnce = false;
  }

  policy() {
    return {
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
        branch: "osstack/smoke",
        title: "test: guarded smoke",
        body_file: "/tmp/osstack-guarded-smoke-pr.md",
        ci_timeout_ms: 10_000,
      },
    };
  }

  ports(changedPaths) {
    return {
      now: () => new Date("2026-07-28T20:00:00.000Z"),
      load: async (runId) =>
        this.projection?.autonomy_run_id === runId
          ? this.projection
          : undefined,
      persist: async (transition) => {
        this.timeline.push(`state:${transition.to_state}`);
        assert.equal(
          transition.from_state,
          this.projection?.state ?? "queued",
        );
        this.projection = {
          autonomy_run_id: transition.autonomy_run_id,
          state: transition.to_state,
          revision: (this.projection?.revision ?? 0) + 1,
          context: {
            ...(this.projection?.context ?? {}),
            ...(transition.context_patch ?? {}),
          },
        };
        return this.projection;
      },
      runLocal: async () => {
        this.timeline.push("effect:builder-reviewer");
        return {
          verification_passed: true,
          review_passed: true,
          post_diff: {
            base_commit_sha: "1".repeat(40),
            changed_paths: [...changedPaths].sort(),
            staged_diff_binary: changedPaths
              .map((path) => `diff --git a/${path} b/${path}\n+smoke`)
              .join("\n"),
            status_porcelain_v1_z: changedPaths
              .map((path) => `M  ${path}\0`)
              .join(""),
            commands: ["npm test"],
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
      writeCandidateProof: async () => {
        this.timeline.push("effect:candidate-proof");
        return {
          manifest_path: "/tmp/candidate/manifest.json",
          manifest_sha256: "4".repeat(64),
        };
      },
      commit: async (input) => {
        this.timeline.push("effect:commit");
        this.issue(input.idempotency_key);
        return { commit: COMMIT_SHA };
      },
      deliverGit: async () => {
        const runId = this.projection.autonomy_run_id;
        this.issue(`${runId}:push:${COMMIT_SHA}`);
        this.timeline.push("effect:push");
        this.issue(`${runId}:pr:${COMMIT_SHA}`);
        this.timeline.push(
          this.failedOnce ? "effect:pr-reused" : "effect:pr",
        );
        if (this.failAfterPr && !this.failedOnce) {
          this.failedOnce = true;
          throw new Error("simulated daemon termination after PR");
        }
        this.issue(`${runId}:merge:42:${COMMIT_SHA}`);
        this.timeline.push("effect:merge");
        return {
          pushedCommit: COMMIT_SHA,
          pr: {
            number: 42,
            url: "https://github.com/example/fixture/pull/42",
            reused: this.failedOnce,
          },
          mergeCommit: MERGE_SHA,
          mergedAt: "2026-07-28T20:01:00.000Z",
        };
      },
      writeFinalProof: async () => {
        this.timeline.push("effect:final-proof");
        return {
          manifest_path: "/tmp/final/manifest.json",
          manifest_sha256: "5".repeat(64),
        };
      },
    };
  }

  issue(id) {
    if (this.externalActions.has(id)) return;
    this.externalActions.add(id);
    this.issuedActionIds.push(id);
  }
}

async function fixture(name) {
  return JSON.parse(
    await readFile(
      join("fixtures", "autonomy", name, "tasks", "task.json"),
      "utf8",
    ),
  );
}

function intent(task, runId) {
  return {
    autonomy_run_id: runId,
    task_id: task.task_id,
    repo_id: `fixture/${task.task_id}`,
    workspace_path: `/tmp/${task.task_id}`,
    goal: task.goal,
    expected_paths: [...task.expected_paths].sort(),
    requested_actions: [...task.requested_actions].sort(),
    contract_sha256: SHA_B,
  };
}

async function runFixture(name) {
  const task = await fixture(name);
  const fake = new FakeDelivery();
  const engine = new GuardedDeliveryEngine(
    fake.policy(),
    fake.ports(task.expected_paths),
  );
  const result = await engine.start(
    intent(task, `run-${name}`),
  );
  assert.equal(result.status, task.expected_status);
  assert.equal(
    result.run.context.preflight_risk.level,
    task.expected_risk,
  );
  if (result.status === "completed") {
    assert.ok(
      fake.timeline.indexOf("effect:candidate-proof")
        < fake.timeline.indexOf("effect:push"),
      `${name}: candidate proof must precede push`,
    );
    assert.ok(
      fake.timeline.indexOf("effect:merge")
        < fake.timeline.indexOf("effect:final-proof"),
      `${name}: final proof must follow merge`,
    );
  }
  if (task.expected_risk === "R3") {
    assert.equal(result.approval_request?.phase, "preflight");
    assert.ok(!fake.timeline.includes("effect:builder-reviewer"));
  }
  if (task.expected_risk === "R4") {
    assert.equal(result.approval_request, undefined);
    assert.ok(!fake.timeline.includes("effect:builder-reviewer"));
  }
  return {
    fixture: name,
    risk: result.run.context.preflight_risk.level,
    status: result.status,
  };
}

async function restartRecovery() {
  const task = await fixture("r1-docs");
  const fake = new FakeDelivery({ failAfterPr: true });
  const firstEngine = new GuardedDeliveryEngine(
    fake.policy(),
    fake.ports(task.expected_paths),
  );
  const first = await firstEngine.start(
    intent(task, "run-restart"),
  );
  assert.equal(first.run.state, "blocked_delivery");

  const recoveredEngine = new GuardedDeliveryEngine(
    fake.policy(),
    fake.ports(task.expected_paths),
  );
  const recovered = await recoveredEngine.resume("run-restart");
  assert.equal(recovered.status, "completed");
  assert.equal(
    fake.timeline.filter((entry) => entry === "effect:commit").length,
    1,
  );
  assert.equal(
    fake.issuedActionIds.length,
    new Set(fake.issuedActionIds).size,
    "recovery issued a duplicate external action id",
  );
  assert.equal(
    fake.issuedActionIds.filter((id) => id.includes(":pr:")).length,
    1,
  );
  return {
    fixture: "restart-recovery",
    status: "completed",
    unique_action_ids: fake.issuedActionIds.length,
  };
}

const results = [];
for (const name of [
  "r1-docs",
  "r2-typescript",
  "r3-auth",
  "r4-destructive",
]) {
  results.push(await runFixture(name));
}
results.push(await restartRecovery());

console.log(JSON.stringify({
  smoke: "guarded-git",
  status: "passed",
  results,
}, null, 2));
