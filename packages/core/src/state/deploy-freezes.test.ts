import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutonomyRun } from "./autonomy-runs.js";
import { openDb } from "./db.js";
import {
  clearProductionFreeze,
  freezeProduction,
  getProductionFreeze,
  listProductionFreezes,
} from "./deploy-freezes.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "osstack-deploy-freezes-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function databasePath(): string {
  return join(directory, "state.db");
}

function createRun(
  db: ReturnType<typeof openDb>,
  path: string,
  runId = "ar_run_001",
): void {
  createAutonomyRun(db, path, {
    autonomy_run_id: runId,
    transition_id: `transition_${runId}`,
    task_id: "task_001",
    repo_id: "example-web",
    workspace_path: "/workspace/example-web",
    contract_sha256: SHA_A,
    budget: { max_builder_attempts: 2 },
    attempt: { builder: 0 },
    event: { type: "run.created" },
    occurred_at: 100,
  });
}

describe("production deployment freezes", () => {
  it("persists an unhealthy release freeze and keeps staging out of the table", () => {
    const path = databasePath();
    const db = openDb({ path, minFreeBytes: 0 });
    try {
      createRun(db, path);
      const frozen = freezeProduction(db, path, {
        repo_id: "example-web",
        reason: "production health check failed",
        source_run_id: "ar_run_001",
        frozen_at: 101,
      });
      expect(frozen).toMatchObject({
        repo_id: "example-web",
        target: "production",
        frozen: 1,
        reason: "production health check failed",
        source_run_id: "ar_run_001",
      });
      expect(getProductionFreeze(db, "example-web")).toEqual(frozen);
      expect(listProductionFreezes(db, { active_only: true })).toEqual([
        frozen,
      ]);
    } finally {
      db.close();
    }
  });

  it("requires a verified human decision identity and an audit reason to clear", () => {
    const path = databasePath();
    const db = openDb({ path, minFreeBytes: 0 });
    try {
      createRun(db, path);
      freezeProduction(db, path, {
        repo_id: "example-web",
        reason: "rollback completed",
        source_run_id: "ar_run_001",
        frozen_at: 101,
      });
      expect(() =>
        clearProductionFreeze(db, path, {
          repo_id: "example-web",
          reason: " ",
          cleared_at: 102,
          authority: {
            actor_type: "human",
            actor_id: "owner",
            key_id: "owner-key",
            decision_sha256: SHA_B,
            freeze_frozen_at: 101,
          },
        }),
      ).toThrow(/reason/i);
      expect(() =>
        clearProductionFreeze(db, path, {
          repo_id: "example-web",
          reason: "incident resolved",
          cleared_at: 102,
          authority: {
            actor_type: "agent" as never,
            actor_id: "builder",
            key_id: "agent-key",
            decision_sha256: SHA_B,
            freeze_frozen_at: 101,
          },
        }),
      ).toThrow(/human/i);

      const cleared = clearProductionFreeze(db, path, {
        repo_id: "example-web",
        reason: "rollback verified and incident resolved",
        cleared_at: 103,
        authority: {
          actor_type: "human",
          actor_id: "owner",
          key_id: "owner-key",
          decision_sha256: SHA_B,
          freeze_frozen_at: 101,
        },
      });
      expect(cleared).toMatchObject({
        frozen: 0,
        cleared_at: 103,
        cleared_by_type: "human",
        cleared_by_id: "owner",
        clear_reason: "rollback verified and incident resolved",
        clear_decision_sha256: SHA_B,
        clear_key_id: "owner-key",
      });
      expect(
        clearProductionFreeze(db, path, {
          repo_id: "example-web",
          reason: "rollback verified and incident resolved",
          cleared_at: 104,
          authority: {
            actor_type: "human",
            actor_id: "owner",
            key_id: "owner-key",
            decision_sha256: SHA_B,
            freeze_frozen_at: 101,
          },
        }),
      ).toEqual(cleared);
    } finally {
      db.close();
    }
  });

  it("survives restart, can be re-frozen, and rejects unrelated clear replay", () => {
    const path = databasePath();
    const first = openDb({ path, minFreeBytes: 0 });
    createRun(first, path);
    freezeProduction(first, path, {
      repo_id: "example-web",
      reason: "first incident",
      source_run_id: "ar_run_001",
      frozen_at: 101,
    });
    clearProductionFreeze(first, path, {
      repo_id: "example-web",
      reason: "first incident resolved",
      cleared_at: 102,
      authority: {
        actor_type: "human",
        actor_id: "owner",
        key_id: "owner-key",
        decision_sha256: SHA_B,
        freeze_frozen_at: 101,
      },
    });
    first.close();

    const reopened = openDb({ path, minFreeBytes: 0 });
    try {
      expect(getProductionFreeze(reopened, "example-web")?.frozen).toBe(0);
      freezeProduction(reopened, path, {
        repo_id: "example-web",
        reason: "second incident",
        source_run_id: "ar_run_001",
        frozen_at: 103,
      });
      expect(getProductionFreeze(reopened, "example-web")).toMatchObject({
        frozen: 1,
        reason: "second incident",
        cleared_at: null,
        clear_decision_sha256: null,
      });
      expect(() =>
        clearProductionFreeze(reopened, path, {
          repo_id: "example-web",
          reason: "stale replay",
          cleared_at: 104,
          authority: {
            actor_type: "human",
            actor_id: "owner",
            key_id: "owner-key",
            decision_sha256: "c".repeat(64),
            freeze_frozen_at: 101,
          },
        }),
      ).toThrow(/freeze|stale/i);
    } finally {
      reopened.close();
    }
  });
});
