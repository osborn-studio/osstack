import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import {
  getLatestSuccessfulRollbackDrill,
  listRollbackDrills,
  recordRollbackDrill,
  rollbackDrillEligibilityEvidence,
} from "./rollback-drills.js";

const SHA = "a".repeat(64);
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "osstack-rollback-drill-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function command(exitCode = 0) {
  return {
    argv: ["node", "scripts/rollback.mjs"],
    exit_code: exitCode,
    duration_ms: 10,
    stdout_summary: "",
    stderr_summary: "",
    timed_out: false,
  };
}

describe("rollback drill persistence", () => {
  it("persists successful controlled drills across restart and exposes eligibility evidence", () => {
    const path = join(directory, "state.db");
    const first = openDb({ path, minFreeBytes: 0 });
    const stored = recordRollbackDrill(first, path, {
      drill_id: "drill-1",
      repo_id: "owner/repo",
      workspace_path: "/workspace/repo",
      deploy_script_digest_sha256: SHA,
      rollback: command(),
      post_rollback_health: command(),
      started_at: 100,
      completed_at: 101,
    });
    expect(stored).toMatchObject({
      passed: true,
      failure_reason: null,
      target: "controlled_non_production",
    });
    expect(
      recordRollbackDrill(first, path, {
        drill_id: "drill-1",
        repo_id: "owner/repo",
        workspace_path: "/workspace/repo",
        deploy_script_digest_sha256: SHA,
        rollback: command(),
        post_rollback_health: command(),
        started_at: 100,
        completed_at: 101,
      }),
    ).toEqual(stored);
    first.close();

    const reopened = openDb({ path, minFreeBytes: 0 });
    try {
      expect(
        getLatestSuccessfulRollbackDrill(reopened, "owner/repo"),
      ).toEqual(stored);
      expect(rollbackDrillEligibilityEvidence(stored)).toEqual({
        passed_at: "1970-01-01T00:01:41.000Z",
        deploy_script_digest_sha256: SHA,
        post_rollback_health_passed: true,
      });
      expect(() =>
        reopened
          .prepare(
            "UPDATE autonomy_rollback_drills SET passed = 0 WHERE drill_id = ?",
          )
          .run("drill-1"),
      ).toThrow(/append-only/);
    } finally {
      reopened.close();
    }
  });

  it("records failed attempts and invalidates earlier successful eligibility", () => {
    const path = join(directory, "state.db");
    const db = openDb({ path, minFreeBytes: 0 });
    try {
      const successful = recordRollbackDrill(db, path, {
        drill_id: "drill-pass",
        repo_id: "owner/repo",
        workspace_path: "/workspace/repo",
        deploy_script_digest_sha256: SHA,
        rollback: command(),
        post_rollback_health: command(),
        started_at: 100,
        completed_at: 101,
      });
      const failed = recordRollbackDrill(db, path, {
        drill_id: "drill-fail",
        repo_id: "owner/repo",
        workspace_path: "/workspace/repo",
        deploy_script_digest_sha256: SHA,
        rollback: command(),
        post_rollback_health: command(9),
        started_at: 102,
        completed_at: 103,
      });
      expect(failed).toMatchObject({
        passed: false,
        failure_reason: "post_rollback_health_failed",
      });
      expect(listRollbackDrills(db, "owner/repo")).toEqual([
        failed,
        successful,
      ]);
      expect(
        getLatestSuccessfulRollbackDrill(db, "owner/repo"),
      ).toBeUndefined();
      expect(() =>
        recordRollbackDrill(db, path, {
          drill_id: "drill-fail",
          repo_id: "other/repo",
          workspace_path: "/workspace/repo",
          deploy_script_digest_sha256: SHA,
          rollback: command(),
          post_rollback_health: command(9),
          started_at: 102,
          completed_at: 103,
        }),
      ).toThrow(/conflicting rollback drill/);
    } finally {
      db.close();
    }
  });
});
