import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAutonomyRun,
  getAutonomyRun,
  transitionAutonomyRun,
} from "./autonomy-runs.js";
import { openDb } from "./db.js";
import {
  acknowledgeNotification,
  enqueueAutonomyNotification,
  listDueNotifications,
  listNotificationAttention,
  notificationPayload,
  recordNotificationAttempt,
  summarizeNotificationOutbox,
} from "./notification-outbox.js";

const SHA = "a".repeat(64);
let directory: string;
let dbPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "osstack-notification-outbox-"));
  dbPath = join(directory, "state.db");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("autonomy notification outbox", () => {
  it("atomically enqueues a fixed redacted payload when attention state is entered", () => {
    const db = openDb({ path: dbPath, minFreeBytes: 0 });
    try {
      seedRun(db);
      const current = getAutonomyRun(db, "run-1")!;
      transitionAutonomyRun(db, dbPath, {
        autonomy_run_id: "run-1",
        transition_id: "run-1:awaiting",
        expected_revision: current.revision,
        to_state: "awaiting_approval",
        event: {
          kind: "awaiting_approval",
          raw_diff: "must remain only in transition evidence",
          approval: { token: "must-not-enter-outbox" },
        },
        notification_kinds: ["awaiting_approval"],
        occurred_at: 101,
      });

      const rows = listNotificationAttention(db);
      expect(rows).toHaveLength(1);
      expect(notificationPayload(rows[0]!)).toEqual({
        schema_version: 1,
        notification_id: rows[0]!.notification_id,
        kind: "awaiting_approval",
        autonomy_run_id: "run-1",
        repo_id: "owner/repo",
        run_state: "awaiting_approval",
        summary: "Signed Owner approval required",
        status_command: [
          "osstack",
          "autonomy",
          "status",
          "run-1",
          "--json",
        ],
      });
      const serialized = rows[0]!.payload_json;
      expect(serialized).not.toContain("raw_diff");
      expect(serialized).not.toContain("token");
      expect(serialized).not.toContain("must-not-enter-outbox");
    } finally {
      db.close();
    }
  });

  it("suppresses duplicate source events and rejects arbitrary sensitive fields", () => {
    const db = openDb({ path: dbPath, minFreeBytes: 0 });
    try {
      seedRun(db);
      const input = {
        kind: "escalated" as const,
        autonomy_run_id: "run-1",
        repo_id: "owner/repo",
        run_state: "escalated",
        source_transition_id: "run-1:escalated",
        occurred_at: 102,
      };
      const first = enqueueAutonomyNotification(db, dbPath, input);
      const duplicate = enqueueAutonomyNotification(db, dbPath, input);
      expect(duplicate).toEqual(first);
      expect(listNotificationAttention(db)).toHaveLength(1);
      expect(() =>
        enqueueAutonomyNotification(db, dbPath, {
          ...input,
          occurred_at: 103,
        }),
      ).toThrow(/conflicting notification event/);

      expect(() =>
        enqueueAutonomyNotification(db, dbPath, {
          ...input,
          source_transition_id: "run-1:secret",
          webhook_url: "https://secret.invalid/token",
        } as never),
      ).toThrow();
      expect(listNotificationAttention(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("persists retry state, dead-letters at the bound, and remains visible until acknowledged", () => {
    const db = openDb({ path: dbPath, minFreeBytes: 0 });
    try {
      seedRun(db);
      const created = enqueueAutonomyNotification(db, dbPath, {
        kind: "delivery_evidence_failed",
        autonomy_run_id: "run-1",
        repo_id: "owner/repo",
        run_state: "delivery_evidence_failed",
        source_transition_id: "run-1:evidence-failed",
        occurred_at: 100,
      });

      const retry = recordNotificationAttempt(db, dbPath, {
        notification_id: created.notification_id,
        expected_attempt_count: 0,
        outcome: "failed",
        error_code: "timeout",
        attempted_at: 101,
        max_attempts: 2,
        next_attempt_at: 111,
      });
      expect(retry).toMatchObject({
        status: "pending",
        attempt_count: 1,
        last_error_code: "timeout",
        next_attempt_at: 111,
      });
      expect(listDueNotifications(db, 110)).toEqual([]);
      expect(listDueNotifications(db, 111)).toHaveLength(1);

      const dead = recordNotificationAttempt(db, dbPath, {
        notification_id: created.notification_id,
        expected_attempt_count: 1,
        outcome: "failed",
        error_code: "transport_error",
        attempted_at: 112,
        max_attempts: 2,
        next_attempt_at: 132,
      });
      expect(dead).toMatchObject({
        status: "dead_letter",
        attempt_count: 2,
        dead_lettered_at: 112,
      });
      expect(summarizeNotificationOutbox(db, 120)).toEqual({
        pending_count: 0,
        dead_letter_count: 1,
        oldest_pending_at: null,
        oldest_dead_letter_at: 100,
        oldest_attention_age_seconds: 20,
      });

      const acknowledged = acknowledgeNotification(db, dbPath, {
        notification_id: created.notification_id,
        acknowledged_at: 121,
        acknowledged_by: "owner",
      });
      expect(acknowledged.status).toBe("acknowledged");
      expect(summarizeNotificationOutbox(db, 121).dead_letter_count).toBe(0);
    } finally {
      db.close();
    }
  });
});

function seedRun(db: ReturnType<typeof openDb>): void {
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
}
