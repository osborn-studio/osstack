import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import {
  AutonomyRepositoryBusyError,
  AutonomyRevisionConflictError,
  createAutonomyRun,
  getAutonomyRun,
  listAutonomyTransitions,
  listResumableAutonomyRuns,
  replayAutonomyRun,
  transitionAutonomyRun,
} from "./autonomy-runs.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "osstack-autonomy-runs-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function databasePath(): string {
  return join(directory, "state.db");
}

function createInput(
  overrides: Partial<Parameters<typeof createAutonomyRun>[2]> = {},
): Parameters<typeof createAutonomyRun>[2] {
  return {
    autonomy_run_id: "ar_run_001",
    transition_id: "art_transition_001",
    task_id: "task_001",
    repo_id: "repo_001",
    workspace_path: "/workspace/repo",
    contract_sha256: SHA_A,
    routing: {
      builder: "codex",
      verifier: "kimi",
      reviewer: "claude",
    },
    budget: {
      max_builder_attempts: 2,
      max_verifier_attempts: 2,
      max_reviewer_attempts: 1,
    },
    attempt: {
      builder: 0,
      verifier: 0,
      reviewer: 0,
    },
    event: {
      type: "run.created",
      source: "deliver",
    },
    occurred_at: 100,
    ...overrides,
  };
}

describe("autonomy run persistence", () => {
  it("atomically creates transition sequence 1 and projection revision 1", () => {
    const path = databasePath();
    const db = openDb({ path, minFreeBytes: 0 });
    try {
      const created = createAutonomyRun(db, path, createInput());
      expect(created).toMatchObject({
        autonomy_run_id: "ar_run_001",
        state: "queued",
        revision: 1,
        last_transition_id: "art_transition_001",
      });
      expect(JSON.parse(created.budget_json)).toEqual({
        max_builder_attempts: 2,
        max_reviewer_attempts: 1,
        max_verifier_attempts: 2,
      });

      expect(listAutonomyTransitions(db, "ar_run_001")).toEqual([
        expect.objectContaining({
          seq: 1,
          from_state: null,
          to_state: "queued",
          contract_decision_id: null,
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it("rolls back the initial transition when a repository already has an active writer", () => {
    const path = databasePath();
    const db = openDb({ path, minFreeBytes: 0 });
    try {
      createAutonomyRun(db, path, createInput());
      expect(() =>
        createAutonomyRun(
          db,
          path,
          createInput({
            autonomy_run_id: "ar_run_002",
            transition_id: "art_transition_002",
          }),
        ),
      ).toThrow(AutonomyRepositoryBusyError);
      expect(listAutonomyTransitions(db, "ar_run_002")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("uses compare-and-swap revision checks without appending stale transitions", () => {
    const path = databasePath();
    const db = openDb({ path, minFreeBytes: 0 });
    try {
      createAutonomyRun(db, path, createInput());
      transitionAutonomyRun(db, path, {
        autonomy_run_id: "ar_run_001",
        transition_id: "art_transition_002",
        expected_revision: 1,
        to_state: "classifying",
        event: { type: "classification.started" },
        occurred_at: 101,
      });

      expect(() =>
        transitionAutonomyRun(db, path, {
          autonomy_run_id: "ar_run_001",
          transition_id: "art_transition_stale",
          expected_revision: 1,
          to_state: "preparing",
          event: { type: "stale.writer" },
          occurred_at: 102,
        }),
      ).toThrow(AutonomyRevisionConflictError);
      expect(listAutonomyTransitions(db, "ar_run_001")).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("rejects unknown state names before writing", () => {
    const path = databasePath();
    const db = openDb({ path, minFreeBytes: 0 });
    try {
      createAutonomyRun(db, path, createInput());
      expect(() =>
        transitionAutonomyRun(db, path, {
          autonomy_run_id: "ar_run_001",
          transition_id: "art_transition_invalid",
          expected_revision: 1,
          to_state: "running" as never,
          event: { type: "invalid.state" },
          occurred_at: 101,
        }),
      ).toThrow();
      expect(getAutonomyRun(db, "ar_run_001")?.revision).toBe(1);
    } finally {
      db.close();
    }
  });

  it("replays the append-only trail and detects projection identity", () => {
    const path = databasePath();
    const db = openDb({ path, minFreeBytes: 0 });
    try {
      createAutonomyRun(db, path, createInput());
      transitionAutonomyRun(db, path, {
        autonomy_run_id: "ar_run_001",
        transition_id: "art_transition_002",
        expected_revision: 1,
        to_state: "classifying",
        event: { type: "classification.started" },
        occurred_at: 101,
      });
      transitionAutonomyRun(db, path, {
        autonomy_run_id: "ar_run_001",
        transition_id: "art_transition_003",
        expected_revision: 2,
        to_state: "preparing",
        event: { type: "classification.finished" },
        occurred_at: 102,
      });

      expect(replayAutonomyRun(db, "ar_run_001")).toEqual({
        autonomy_run_id: "ar_run_001",
        state: "preparing",
        revision: 3,
        last_transition_id: "art_transition_003",
      });
      expect(() =>
        db
          .prepare(
            "UPDATE autonomy_run_transitions SET event_json = ? WHERE transition_id = ?",
          )
          .run("{}", "art_transition_002"),
      ).toThrow(/append-only/);
      expect(() =>
        db
          .prepare(
            "DELETE FROM autonomy_run_transitions WHERE transition_id = ?",
          )
          .run("art_transition_002"),
      ).toThrow(/append-only/);
    } finally {
      db.close();
    }
  });

  it("recovers nonterminal runs after reopen and excludes terminal runs", () => {
    const path = databasePath();
    const first = openDb({ path, minFreeBytes: 0 });
    createAutonomyRun(first, path, createInput());
    transitionAutonomyRun(first, path, {
      autonomy_run_id: "ar_run_001",
      transition_id: "art_transition_002",
      expected_revision: 1,
      to_state: "blocked_delivery",
      event: { type: "delivery.retryable" },
      occurred_at: 101,
    });
    first.close();

    const reopened = openDb({ path, minFreeBytes: 0 });
    try {
      expect(listResumableAutonomyRuns(reopened)).toEqual([
        expect.objectContaining({
          autonomy_run_id: "ar_run_001",
          state: "blocked_delivery",
          revision: 2,
        }),
      ]);
      transitionAutonomyRun(reopened, path, {
        autonomy_run_id: "ar_run_001",
        transition_id: "art_transition_003",
        expected_revision: 2,
        to_state: "completed",
        event: { type: "run.completed" },
        occurred_at: 102,
      });
      expect(listResumableAutonomyRuns(reopened)).toEqual([]);

      createAutonomyRun(
        reopened,
        path,
        createInput({
          autonomy_run_id: "ar_run_002",
          transition_id: "art_transition_004",
        }),
      );
      transitionAutonomyRun(reopened, path, {
        autonomy_run_id: "ar_run_002",
        transition_id: "art_transition_005",
        expected_revision: 1,
        to_state: "escalated",
        event: { type: "run.escalated" },
        occurred_at: 103,
      });
      expect(listResumableAutonomyRuns(reopened)).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it("round-trips strict approval, proof, and Git delivery JSON", () => {
    const path = databasePath();
    const db = openDb({ path, minFreeBytes: 0 });
    try {
      createAutonomyRun(db, path, createInput());
      const updated = transitionAutonomyRun(db, path, {
        autonomy_run_id: "ar_run_001",
        transition_id: "art_transition_002",
        expected_revision: 1,
        to_state: "candidate_proof",
        event: { type: "candidate.proved", evidence_count: 2 },
        contract_decision_id: null,
        patch: {
          diff_sha256: SHA_B,
          approval: {
            approval_id: "approval_001",
            decision: "approve",
            request_sha256: SHA_A,
          },
          candidate_proof: {
            verdict: "pass",
            checks: ["typecheck", "test"],
          },
          git_delivery: {
            branch: "codex/autonomy-run-001",
            head_sha: SHA_B,
            pr_number: 157,
          },
          deploy: {
            staging: { outcome: "healthy" },
            production: { outcome: "health_failed_rolled_back" },
          },
          rollback: {
            command_exit_code: 0,
            post_rollback_health_passed: true,
          },
          final_proof: {
            merged: true,
            merge_commit_sha: SHA_A,
          },
        },
        occurred_at: 101,
      });

      expect(JSON.parse(updated.approval_json!)).toEqual({
        approval_id: "approval_001",
        decision: "approve",
        request_sha256: SHA_A,
      });
      expect(JSON.parse(updated.candidate_proof_json!)).toEqual({
        checks: ["typecheck", "test"],
        verdict: "pass",
      });
      expect(JSON.parse(updated.git_delivery_json!)).toEqual({
        branch: "codex/autonomy-run-001",
        head_sha: SHA_B,
        pr_number: 157,
      });
      expect(JSON.parse(updated.deploy_json!)).toEqual({
        production: { outcome: "health_failed_rolled_back" },
        staging: { outcome: "healthy" },
      });
      expect(JSON.parse(updated.rollback_json!)).toEqual({
        command_exit_code: 0,
        post_rollback_health_passed: true,
      });
      expect(JSON.parse(updated.final_proof_json!)).toEqual({
        merge_commit_sha: SHA_A,
        merged: true,
      });
    } finally {
      db.close();
    }
  });

  it("rejects non-JSON values without leaving a transition", () => {
    const path = databasePath();
    const db = openDb({ path, minFreeBytes: 0 });
    try {
      createAutonomyRun(db, path, createInput());
      expect(() =>
        transitionAutonomyRun(db, path, {
          autonomy_run_id: "ar_run_001",
          transition_id: "art_transition_invalid_json",
          expected_revision: 1,
          to_state: "classifying",
          event: { type: "invalid", omitted: undefined } as never,
          occurred_at: 101,
        }),
      ).toThrow();
      expect(listAutonomyTransitions(db, "ar_run_001")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("enforces approval audit foreign keys atomically", () => {
    const path = databasePath();
    const db = openDb({ path, minFreeBytes: 0 });
    try {
      createAutonomyRun(db, path, createInput());
      expect(() =>
        transitionAutonomyRun(db, path, {
          autonomy_run_id: "ar_run_001",
          transition_id: "art_transition_bad_audit",
          expected_revision: 1,
          to_state: "awaiting_approval",
          event: { type: "approval.requested" },
          contract_decision_id: "missing_decision",
          occurred_at: 101,
        }),
      ).toThrow();
      expect(getAutonomyRun(db, "ar_run_001")?.revision).toBe(1);
      expect(listAutonomyTransitions(db, "ar_run_001")).toHaveLength(1);

      db.prepare(
        `INSERT INTO contract_approval_decisions (
           decision_id, approval_id, contract_id, action, actor_type, actor_id,
           reason, decided_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "contract_decision_001",
        "contract_approval_001",
        "contract_001",
        "approve",
        "human",
        "owner_001",
        "approved for build",
        101,
        101,
      );
      transitionAutonomyRun(db, path, {
        autonomy_run_id: "ar_run_001",
        transition_id: "art_transition_linked_audit",
        expected_revision: 1,
        to_state: "awaiting_approval",
        event: { type: "approval.recorded" },
        contract_decision_id: "contract_decision_001",
        occurred_at: 102,
      });
      expect(listAutonomyTransitions(db, "ar_run_001").at(-1)).toMatchObject({
        contract_decision_id: "contract_decision_001",
      });
    } finally {
      db.close();
    }
  });
});
