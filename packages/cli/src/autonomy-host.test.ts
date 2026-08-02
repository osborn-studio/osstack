import { mkdtempSync, rmSync } from "node:fs";
import {
  mkdir,
  readFile,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAutonomyRun,
  getAutonomyRun,
  openDb,
  transitionAutonomyRun,
} from "@osstack/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClockJumpDetector,
  enforceAutonomyRetention,
  inspectAutonomyRetention,
} from "./autonomy-host.js";

const SHA = "a".repeat(64);
let directory: string;
let dbPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "osstack-autonomy-host-"));
  dbPath = join(directory, "state.db");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("host clock evidence", () => {
  it("detects wall-clock drift against a monotonic clock in either direction", () => {
    const detector = new ClockJumpDetector(1_000);
    expect(detector.observe(10_000, 5_000).jump_detected).toBe(false);
    expect(detector.observe(11_000, 6_000)).toMatchObject({
      jump_detected: false,
      drift_ms: 0,
    });
    expect(detector.observe(20_000, 7_000)).toMatchObject({
      jump_detected: true,
      drift_ms: 8_000,
    });
    expect(detector.observe(19_000, 8_000)).toMatchObject({
      jump_detected: true,
      drift_ms: -2_000,
    });
  });
});

describe("host artifact retention", () => {
  it("copy-truncates oversized logs and removes only expired terminal proofs", async () => {
    const db = openDb({ path: dbPath, minFreeBytes: 0 });
    try {
      await mkdir(join(directory, "logs"), { recursive: true });
      await writeFile(join(directory, "logs", "daemon.log"), "0123456789abcdef");
      seedRun(db, "run_recent", false);
      seedRun(db, "run_old_terminal", true);
      seedRun(db, "run_old_active", false);
      for (const runId of [
        "run_recent",
        "run_old_terminal",
        "run_old_active",
      ]) {
        const path = join(directory, "autonomy", runId);
        await mkdir(path, { recursive: true });
        await writeFile(join(path, "proof.json"), "{}\n");
      }
      await utimes(
        join(directory, "autonomy", "run_recent"),
        199_000,
        199_000,
      );
      await utimes(
        join(directory, "autonomy", "run_old_terminal"),
        1_000,
        1_000,
      );
      await utimes(
        join(directory, "autonomy", "run_old_active"),
        1_000,
        1_000,
      );

      const before = await inspectAutonomyRetention({
        home: directory,
        db,
        now: () => 200_000,
        max_log_bytes: 10,
        max_log_files: 2,
        proof_retention_days: 1,
        proof_min_keep: 1,
      });
      expect(before).toMatchObject({
        oversized_log_count: 1,
        expired_terminal_proof_count: 1,
      });

      const enforced = await enforceAutonomyRetention({
        home: directory,
        db,
        now: () => 200_000,
        max_log_bytes: 10,
        max_log_files: 2,
        proof_retention_days: 1,
        proof_min_keep: 1,
      });
      expect(enforced.rotated_logs).toEqual([
        join(directory, "logs", "daemon.log"),
      ]);
      expect(await readFile(
        join(directory, "logs", "daemon.log.1"),
        "utf8",
      )).toBe("0123456789abcdef");
      expect((await stat(join(directory, "logs", "daemon.log"))).size).toBe(0);
      expect(enforced.removed_proof_dirs).toEqual([
        join(directory, "autonomy", "run_old_terminal"),
      ]);
      await expect(
        stat(join(directory, "autonomy", "run_old_terminal")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(
        join(directory, "autonomy", "run_old_active"),
      )).isDirectory()).toBe(true);
    } finally {
      db.close();
    }
  });
});

function seedRun(
  db: ReturnType<typeof openDb>,
  runId: string,
  terminal: boolean,
): void {
  createAutonomyRun(db, dbPath, {
    autonomy_run_id: runId,
    transition_id: `${runId}:queued`,
    task_id: `task-${runId}`,
    repo_id: `owner/${runId}`,
    workspace_path: `/workspace/${runId}`,
    contract_sha256: SHA,
    budget: { max_builder_iterations: 1 },
    attempt: {},
    event: { kind: "queued" },
    occurred_at: 100,
  });
  if (!terminal) return;
  const row = getAutonomyRun(db, runId)!;
  transitionAutonomyRun(db, dbPath, {
    autonomy_run_id: runId,
    transition_id: `${runId}:completed`,
    expected_revision: row.revision,
    to_state: "completed",
    event: { kind: "completed" },
    occurred_at: 101,
  });
}
