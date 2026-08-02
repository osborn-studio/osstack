import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAutonomyRun,
  enqueueAutonomyNotification,
  getAutonomyRun,
  getNotification,
  openDb,
  summarizeNotificationOutbox,
} from "@osstack/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  drainAutonomyNotifications,
  NotificationInvalidResponseError,
  type AutonomyNotificationSender,
} from "./autonomy-notification.js";

const SHA = "a".repeat(64);
let directory: string;
let dbPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "osstack-notification-drain-"));
  dbPath = join(directory, "state.db");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("autonomy notification delivery", () => {
  it("delivers a redacted message with a stable idempotency key exactly once", async () => {
    const db = openDb({ path: dbPath, minFreeBytes: 0 });
    try {
      const notificationId = seedNotification(db);
      const send = vi.fn<AutonomyNotificationSender["send"]>(
        async (message) => {
          expect(message.idempotency_key).toBe(notificationId);
          expect(message.payload.status_command).toEqual([
            "osstack",
            "autonomy",
            "status",
            "run-1",
            "--json",
          ]);
          expect(JSON.stringify(message)).not.toContain("diff");
          expect(JSON.stringify(message)).not.toContain("credential");
          expect(JSON.stringify(message)).not.toContain("webhook");
          expect(JSON.stringify(message)).not.toContain("approval_material");
        },
      );

      expect(await drainAutonomyNotifications({
        db,
        db_path: dbPath,
        sender: { send },
        now: () => 101,
      })).toEqual({
        selected: 1,
        delivered: 1,
        retried: 0,
        dead_lettered: 0,
      });
      expect(await drainAutonomyNotifications({
        db,
        db_path: dbPath,
        sender: { send },
        now: () => 102,
      })).toEqual({
        selected: 0,
        delivered: 0,
        retried: 0,
        dead_lettered: 0,
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(getNotification(db, notificationId)).toMatchObject({
        status: "delivered",
        attempt_count: 1,
      });
    } finally {
      db.close();
    }
  });

  it("persists timeout backoff across restart and dead-letters at the retry bound", async () => {
    let db = openDb({ path: dbPath, minFreeBytes: 0 });
    const notificationId = seedNotification(db);
    const primaryBeforeFailure = getAutonomyRun(db, "run-1");
    let aborted = false;
    const hanging: AutonomyNotificationSender = {
      send: async (_message, signal) =>
        await new Promise<void>(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    };

    expect(await drainAutonomyNotifications({
      db,
      db_path: dbPath,
      sender: hanging,
      now: () => 101,
      timeout_ms: 5,
      base_backoff_ms: 100,
      max_backoff_ms: 100,
      max_attempts: 2,
    })).toEqual({
      selected: 1,
      delivered: 0,
      retried: 1,
      dead_lettered: 0,
    });
    expect(aborted).toBe(true);
    expect(getNotification(db, notificationId)).toMatchObject({
      status: "pending",
      attempt_count: 1,
      next_attempt_at: 101.1,
      last_error_code: "timeout",
    });
    expect(getAutonomyRun(db, "run-1")).toEqual(primaryBeforeFailure);
    db.close();

    db = openDb({ path: dbPath, minFreeBytes: 0 });
    try {
      expect(await drainAutonomyNotifications({
        db,
        db_path: dbPath,
        sender: {
          send: async () => {
            throw new Error("remote relay offline");
          },
        },
        now: () => 101.1,
        timeout_ms: 5,
        base_backoff_ms: 100,
        max_backoff_ms: 100,
        max_attempts: 2,
      })).toEqual({
        selected: 1,
        delivered: 0,
        retried: 0,
        dead_lettered: 1,
      });
      expect(getNotification(db, notificationId)).toMatchObject({
        status: "dead_letter",
        attempt_count: 2,
        last_error_code: "transport_error",
      });
      expect(summarizeNotificationOutbox(db, 110)).toMatchObject({
        pending_count: 0,
        dead_letter_count: 1,
        oldest_attention_age_seconds: 10,
      });
    } finally {
      db.close();
    }
  });

  it("classifies invalid transport responses without persisting raw errors", async () => {
    const db = openDb({ path: dbPath, minFreeBytes: 0 });
    try {
      const notificationId = seedNotification(db);
      await drainAutonomyNotifications({
        db,
        db_path: dbPath,
        sender: {
          send: async () => {
            throw new NotificationInvalidResponseError(
              "response included secret=must-not-persist",
            );
          },
        },
        now: () => 101,
        max_attempts: 2,
      });
      const row = getNotification(db, notificationId)!;
      expect(row.last_error_code).toBe("invalid_response");
      expect(JSON.stringify(row)).not.toContain("must-not-persist");
    } finally {
      db.close();
    }
  });
});

function seedNotification(
  db: ReturnType<typeof openDb>,
): string {
  createAutonomyRun(db, dbPath, {
    autonomy_run_id: "run-1",
    transition_id: "run-1:queued",
    task_id: "task-1",
    repo_id: "owner/repo",
    workspace_path: "/workspace/repo",
    contract_sha256: SHA,
    budget: { max_builder_iterations: 2 },
    attempt: { builder_iterations: 0 },
    event: { kind: "queued" },
    occurred_at: 100,
  });
  return enqueueAutonomyNotification(db, dbPath, {
    kind: "awaiting_approval",
    autonomy_run_id: "run-1",
    repo_id: "owner/repo",
    run_state: "awaiting_approval",
    source_transition_id: "run-1:approval",
    occurred_at: 100,
  }).notification_id;
}
