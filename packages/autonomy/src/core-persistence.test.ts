import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAutonomyRun,
  listAutonomyTransitions,
  openDb,
} from "@osstack/core";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { SqliteGuardedDeliveryStore } from "./core-persistence.js";
import {
  GuardedDeliveryEngine,
  type GuardedDeliveryPolicy,
} from "./engine.js";

const NOW = new Date("2026-07-28T23:00:00.000Z");
const POLICY_SHA = "a".repeat(64);
const CONTRACT_SHA = "b".repeat(64);
const BASE_SHA = "c".repeat(40);
const COMMIT_SHA = "d".repeat(40);
const MERGE_SHA = "e".repeat(40);

let directory: string;
let dbPath: string;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "osstack-autonomy-store-"));
  dbPath = join(directory, "state.db");
  db = openDb({ path: dbPath });
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function policy(): GuardedDeliveryPolicy {
  return {
    policy_sha256: POLICY_SHA,
    protected_policy_paths: [],
    routing: {
      builder_agent_id: "claude-code",
      evaluator_agent_id: "kimi-code",
    },
    budget: {
      max_builder_iterations: 3,
      max_review_rounds: 3,
      max_wall_time_ms: 5_400_000,
      max_no_progress_rounds: 2,
    },
    approval_ttl_ms: 3_600_000,
    trusted_approval_public_keys: new Map(),
    consume_approval_nonce: () => false,
    git: {
      remote: "origin",
      base: "main",
      branch: "osstack/task-docs",
      title: "docs: update guide",
      body_file: join(directory, "candidate.md"),
      ci_timeout_ms: 60_000,
    },
  };
}

describe("SQLite guarded delivery persistence", () => {
  it("round-trips engine context and append-only transitions through completion", async () => {
    const store = new SqliteGuardedDeliveryStore({
      db,
      dbPath,
      now: () => NOW,
    });
    const candidate = {
      manifest_path: join(directory, "candidate", "manifest.json"),
      manifest_sha256: "1".repeat(64),
    };
    const final = {
      manifest_path: join(directory, "final", "manifest.json"),
      manifest_sha256: "2".repeat(64),
    };
    const runLocal = vi.fn(async () => ({
      verification_passed: true,
      review_passed: true,
      post_diff: {
        base_commit_sha: BASE_SHA,
        changed_paths: ["docs/guide.md"],
        staged_diff_binary:
          "diff --git a/docs/guide.md b/docs/guide.md\n" +
          "--- a/docs/guide.md\n" +
          "+++ b/docs/guide.md\n" +
          "+safe docs\n",
        status_porcelain_v1_z: "M  docs/guide.md\0",
        commands: ["pnpm test"],
        dependency_changes: [],
      },
      progress: {
        finding_fingerprints: [],
        changed_files_sha256: "3".repeat(64),
        verification_sha256: "4".repeat(64),
        failed_commands: [],
        acceptance_score: 1,
      },
      builder_identity: {
        provider_id: "anthropic",
        model_id: "claude-current",
        evidence_source: "reported" as const,
      },
      evaluator_identity: {
        provider_id: "kimi",
        model_id: "kimi-code/k3",
        evidence_source: "reported" as const,
      },
    }));
    const engine = new GuardedDeliveryEngine(policy(), {
      now: () => NOW,
      load: (runId) => store.load(runId),
      persist: (event) => store.persist(event),
      runLocal,
      writeCandidateProof: async () => candidate,
      writeFinalProof: async () => final,
      commit: async () => ({ commit: COMMIT_SHA }),
      deliverGit: async () => ({
        pushedCommit: COMMIT_SHA,
        pr: {
          number: 42,
          url: "https://github.com/gilosbornhello/osstack/pull/42",
          reused: false,
        },
        mergeCommit: MERGE_SHA,
        mergedAt: NOW.toISOString(),
      }),
    });

    const result = await engine.start({
      autonomy_run_id: "run-docs",
      task_id: "task-docs",
      repo_id: "gilosbornhello/example",
      workspace_path: directory,
      goal: "update documentation",
      expected_paths: ["docs/guide.md"],
      requested_actions: ["build", "commit", "merge", "push", "verify"],
      contract_sha256: CONTRACT_SHA,
    });

    expect(result).toMatchObject({
      status: "completed",
      run: {
        autonomy_run_id: "run-docs",
        state: "completed",
        context: {
          candidate_proof: candidate,
          final_proof: final,
          commit: { commit: COMMIT_SHA },
          git_delivery: {
            pushedCommit: COMMIT_SHA,
            pr: { number: 42 },
          },
        },
      },
    });
    expect(runLocal).toHaveBeenCalledTimes(1);
    expect(await store.load("run-docs")).toEqual(result.run);

    const row = getAutonomyRun(db, "run-docs");
    expect(row).toMatchObject({
      task_id: "task-docs",
      repo_id: "gilosbornhello/example",
      state: "completed",
      revision: result.run.revision,
      candidate_proof_json: expect.any(String),
      git_delivery_json: expect.any(String),
      final_proof_json: expect.any(String),
    });
    const transitions = listAutonomyTransitions(db, "run-docs");
    expect(transitions.map((entry) => entry.to_state)).toEqual([
      "queued",
      "classifying",
      "preparing",
      "building",
      "verifying",
      "reviewing",
      "post_classifying",
      "candidate_proof",
      "committing",
      "pushing",
      "opening_pr",
      "waiting_ci",
      "merging",
      "final_proof",
      "completed",
    ]);
    expect(
      transitions.map((entry) => entry.seq),
    ).toEqual(transitions.map((_, index) => index + 1));
  });
});
