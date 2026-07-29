import {
  listDueNotifications,
  notificationPayload,
  recordNotificationAttempt,
  type AutonomyNotificationPayload,
  type NotificationFailureCode,
  type NotificationOutboxRow,
} from "@osstack/core";
import type Database from "better-sqlite3";

export interface AutonomyNotificationMessage {
  notification_id: string;
  idempotency_key: string;
  payload: AutonomyNotificationPayload;
}

export interface AutonomyNotificationSender {
  send(
    message: AutonomyNotificationMessage,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface DrainAutonomyNotificationsOptions {
  db: Database.Database;
  db_path: string;
  sender: AutonomyNotificationSender;
  now?: () => number;
  timeout_ms?: number;
  base_backoff_ms?: number;
  max_backoff_ms?: number;
  max_attempts?: number;
  limit?: number;
}

export interface AutonomyNotificationDrainReport {
  selected: number;
  delivered: number;
  retried: number;
  dead_lettered: number;
}

export class NotificationInvalidResponseError extends Error {
  constructor(message = "notification transport returned an invalid response") {
    super(message);
    this.name = "NotificationInvalidResponseError";
  }
}

class NotificationTimeoutError extends Error {
  constructor() {
    super("notification delivery timed out");
    this.name = "NotificationTimeoutError";
  }
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return resolved;
}

function failureCode(error: unknown): NotificationFailureCode {
  if (error instanceof NotificationTimeoutError) return "timeout";
  if (error instanceof NotificationInvalidResponseError) {
    return "invalid_response";
  }
  return "transport_error";
}

function backoffMs(
  row: NotificationOutboxRow,
  baseBackoffMs: number,
  maxBackoffMs: number,
): number {
  return Math.min(
    maxBackoffMs,
    baseBackoffMs * 2 ** Math.min(row.attempt_count, 20),
  );
}

async function sendWithTimeout(
  sender: AutonomyNotificationSender,
  row: NotificationOutboxRow,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      sender.send(
        {
          notification_id: row.notification_id,
          idempotency_key: row.notification_id,
          payload: notificationPayload(row),
        },
        controller.signal,
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new NotificationTimeoutError());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function drainAutonomyNotifications(
  options: DrainAutonomyNotificationsOptions,
): Promise<AutonomyNotificationDrainReport> {
  const timeoutMs = positiveInteger(
    options.timeout_ms,
    10_000,
    "notification timeout",
  );
  const baseBackoffMs = positiveInteger(
    options.base_backoff_ms,
    30_000,
    "notification base backoff",
  );
  const maxBackoffMs = positiveInteger(
    options.max_backoff_ms,
    3_600_000,
    "notification max backoff",
  );
  const maxAttempts = positiveInteger(
    options.max_attempts,
    5,
    "notification max attempts",
  );
  const limit = positiveInteger(options.limit, 50, "notification batch limit");
  if (maxBackoffMs < baseBackoffMs) {
    throw new Error(
      "notification max backoff must be at least the base backoff",
    );
  }
  if (maxAttempts > 20) {
    throw new Error("notification max attempts cannot exceed 20");
  }
  if (limit > 500) {
    throw new Error("notification batch limit cannot exceed 500");
  }

  const now = options.now ?? (() => Date.now() / 1_000);
  const rows = listDueNotifications(options.db, now(), limit);
  let delivered = 0;
  let retried = 0;
  let deadLettered = 0;

  for (const row of rows) {
    try {
      await sendWithTimeout(options.sender, row, timeoutMs);
      recordNotificationAttempt(options.db, options.db_path, {
        notification_id: row.notification_id,
        expected_attempt_count: row.attempt_count,
        outcome: "delivered",
        attempted_at: now(),
      });
      delivered += 1;
    } catch (error) {
      const attemptedAt = now();
      const next = recordNotificationAttempt(options.db, options.db_path, {
        notification_id: row.notification_id,
        expected_attempt_count: row.attempt_count,
        outcome: "failed",
        error_code: failureCode(error),
        attempted_at: attemptedAt,
        max_attempts: maxAttempts,
        next_attempt_at:
          attemptedAt
          + backoffMs(row, baseBackoffMs, maxBackoffMs) / 1_000,
      });
      if (next.status === "dead_letter") deadLettered += 1;
      else retried += 1;
    }
  }

  return {
    selected: rows.length,
    delivered,
    retried,
    dead_lettered: deadLettered,
  };
}
