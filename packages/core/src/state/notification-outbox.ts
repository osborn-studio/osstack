import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { withWrite } from "./db.js";

export const AutonomyNotificationKind = z.enum([
  "awaiting_approval",
  "escalated",
  "deploy_frozen",
  "rollback_failed",
  "delivery_evidence_failed",
]);
export type AutonomyNotificationKind = z.infer<
  typeof AutonomyNotificationKind
>;

export const NotificationFailureCode = z.enum([
  "timeout",
  "transport_error",
  "invalid_response",
]);
export type NotificationFailureCode = z.infer<
  typeof NotificationFailureCode
>;

const PublicReference = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f;
  }), {
    message: "public notification references cannot contain control bytes",
  });

export const AutonomyNotificationPayload = z
  .object({
    schema_version: z.literal(1),
    notification_id: z.string().regex(/^an_[a-f0-9]{32}$/),
    kind: AutonomyNotificationKind,
    autonomy_run_id: PublicReference,
    repo_id: PublicReference,
    run_state: PublicReference,
    summary: z.enum([
      "Signed Owner approval required",
      "Guarded autonomy run escalated",
      "Production deployment frozen",
      "Production rollback failed",
      "Delivery proof integrity failed",
    ]),
    status_command: z.tuple([
      z.literal("osstack"),
      z.literal("autonomy"),
      z.literal("status"),
      PublicReference,
      z.literal("--json"),
    ]),
  })
  .strict();
export type AutonomyNotificationPayload = z.infer<
  typeof AutonomyNotificationPayload
>;

export const NotificationOutboxStatus = z.enum([
  "pending",
  "delivered",
  "dead_letter",
  "acknowledged",
]);
export type NotificationOutboxStatus = z.infer<
  typeof NotificationOutboxStatus
>;

export const NotificationOutboxRow = z
  .object({
    notification_id: z.string().regex(/^an_[a-f0-9]{32}$/),
    dedupe_key: z.string().min(1),
    kind: AutonomyNotificationKind,
    autonomy_run_id: z.string().min(1),
    repo_id: z.string().min(1),
    run_state: z.string().min(1),
    payload_json: z.string().min(1),
    status: NotificationOutboxStatus,
    attempt_count: z.number().int().nonnegative(),
    next_attempt_at: z.number().finite(),
    last_attempt_at: z.number().finite().nullable(),
    delivered_at: z.number().finite().nullable(),
    dead_lettered_at: z.number().finite().nullable(),
    acknowledged_at: z.number().finite().nullable(),
    acknowledged_by: z.string().min(1).nullable(),
    last_error_code: NotificationFailureCode.nullable(),
    created_at: z.number().finite(),
    updated_at: z.number().finite(),
  })
  .strict();
export type NotificationOutboxRow = z.infer<
  typeof NotificationOutboxRow
>;

export const EnqueueAutonomyNotificationInput = z
  .object({
    kind: AutonomyNotificationKind,
    autonomy_run_id: PublicReference,
    repo_id: PublicReference,
    run_state: PublicReference,
    source_transition_id: PublicReference,
    occurred_at: z.number().finite(),
  })
  .strict();
export type EnqueueAutonomyNotificationInput = z.infer<
  typeof EnqueueAutonomyNotificationInput
>;

export const RecordNotificationAttemptInput = z
  .discriminatedUnion("outcome", [
    z
      .object({
        notification_id: z.string().regex(/^an_[a-f0-9]{32}$/),
        expected_attempt_count: z.number().int().nonnegative(),
        outcome: z.literal("delivered"),
        attempted_at: z.number().finite(),
      })
      .strict(),
    z
      .object({
        notification_id: z.string().regex(/^an_[a-f0-9]{32}$/),
        expected_attempt_count: z.number().int().nonnegative(),
        outcome: z.literal("failed"),
        error_code: NotificationFailureCode,
        attempted_at: z.number().finite(),
        max_attempts: z.number().int().positive().max(20),
        next_attempt_at: z.number().finite(),
      })
      .strict(),
  ]);
export type RecordNotificationAttemptInput = z.infer<
  typeof RecordNotificationAttemptInput
>;

export interface NotificationOutboxSummary {
  pending_count: number;
  dead_letter_count: number;
  oldest_pending_at: number | null;
  oldest_dead_letter_at: number | null;
  oldest_attention_age_seconds: number;
}

const SUMMARY_BY_KIND: Record<AutonomyNotificationKind, AutonomyNotificationPayload["summary"]> = {
  awaiting_approval: "Signed Owner approval required",
  escalated: "Guarded autonomy run escalated",
  deploy_frozen: "Production deployment frozen",
  rollback_failed: "Production rollback failed",
  delivery_evidence_failed: "Delivery proof integrity failed",
};

function notificationId(dedupeKey: string): string {
  return `an_${createHash("sha256").update(dedupeKey).digest("hex").slice(0, 32)}`;
}

function outboxRow(value: unknown): NotificationOutboxRow {
  const row = NotificationOutboxRow.parse(value);
  AutonomyNotificationPayload.parse(JSON.parse(row.payload_json));
  return row;
}

export function notificationPayload(
  row: NotificationOutboxRow,
): AutonomyNotificationPayload {
  return AutonomyNotificationPayload.parse(JSON.parse(row.payload_json));
}

function encodePayload(payload: AutonomyNotificationPayload): string {
  return JSON.stringify(payload);
}

export function enqueueAutonomyNotificationInTransaction(
  db: Database.Database,
  value: EnqueueAutonomyNotificationInput,
): NotificationOutboxRow {
  const input = EnqueueAutonomyNotificationInput.parse(value);
  const dedupeKey = `${input.source_transition_id}:${input.kind}`;
  const id = notificationId(dedupeKey);
  const payload = AutonomyNotificationPayload.parse({
    schema_version: 1,
    notification_id: id,
    kind: input.kind,
    autonomy_run_id: input.autonomy_run_id,
    repo_id: input.repo_id,
    run_state: input.run_state,
    summary: SUMMARY_BY_KIND[input.kind],
    status_command: [
      "osstack",
      "autonomy",
      "status",
      input.autonomy_run_id,
      "--json",
    ],
  });
  db.prepare(
    `INSERT INTO autonomy_notification_outbox (
       notification_id, dedupe_key, kind, autonomy_run_id, repo_id,
       run_state, payload_json, status, attempt_count, next_attempt_at,
       last_attempt_at, delivered_at, dead_lettered_at, acknowledged_at,
       acknowledged_by, last_error_code, created_at, updated_at
     ) VALUES (
       @notification_id, @dedupe_key, @kind, @autonomy_run_id, @repo_id,
       @run_state, @payload_json, 'pending', 0, @occurred_at,
       NULL, NULL, NULL, NULL, NULL, NULL, @occurred_at, @occurred_at
     )
     ON CONFLICT(dedupe_key) DO NOTHING`,
  ).run({
    notification_id: id,
    dedupe_key: dedupeKey,
    kind: input.kind,
    autonomy_run_id: input.autonomy_run_id,
    repo_id: input.repo_id,
    run_state: input.run_state,
    payload_json: encodePayload(payload),
    occurred_at: input.occurred_at,
  });
  const row = getNotification(db, id)!;
  if (
    row.kind !== input.kind
    || row.autonomy_run_id !== input.autonomy_run_id
    || row.repo_id !== input.repo_id
    || row.run_state !== input.run_state
    || row.created_at !== input.occurred_at
  ) {
    throw new Error(
      `conflicting notification event for ${input.source_transition_id}`,
    );
  }
  return row;
}

export function enqueueAutonomyNotification(
  db: Database.Database,
  dbPath: string,
  value: EnqueueAutonomyNotificationInput,
): NotificationOutboxRow {
  return withWrite(
    db,
    dbPath,
    (transaction) =>
      enqueueAutonomyNotificationInTransaction(transaction, value),
  );
}

export function getNotification(
  db: Database.Database,
  notificationIdValue: string,
): NotificationOutboxRow | undefined {
  const row = db
    .prepare(
      `SELECT *
       FROM autonomy_notification_outbox
       WHERE notification_id = ?`,
    )
    .get(notificationIdValue);
  return row === undefined ? undefined : outboxRow(row);
}

export function listDueNotifications(
  db: Database.Database,
  now: number,
  limit = 50,
): NotificationOutboxRow[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("notification outbox limit must be between 1 and 500");
  }
  return (
    db.prepare(
      `SELECT *
       FROM autonomy_notification_outbox
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY next_attempt_at ASC, created_at ASC, notification_id ASC
       LIMIT ?`,
    ).all(now, limit) as unknown[]
  ).map(outboxRow);
}

export function listNotificationAttention(
  db: Database.Database,
): NotificationOutboxRow[] {
  return (
    db.prepare(
      `SELECT *
       FROM autonomy_notification_outbox
       WHERE status IN ('pending', 'dead_letter')
       ORDER BY created_at ASC, notification_id ASC`,
    ).all() as unknown[]
  ).map(outboxRow);
}

export class NotificationAttemptConflictError extends Error {
  constructor(notificationIdValue: string) {
    super(
      `notification ${notificationIdValue} changed before attempt could commit`,
    );
    this.name = "NotificationAttemptConflictError";
  }
}

export function recordNotificationAttempt(
  db: Database.Database,
  dbPath: string,
  value: RecordNotificationAttemptInput,
): NotificationOutboxRow {
  const input = RecordNotificationAttemptInput.parse(value);
  return withWrite(db, dbPath, (transaction) => {
    const current = getNotification(transaction, input.notification_id);
    if (
      current === undefined
      || current.status !== "pending"
      || current.attempt_count !== input.expected_attempt_count
    ) {
      throw new NotificationAttemptConflictError(input.notification_id);
    }
    if (input.attempted_at < current.created_at) {
      throw new Error("notification attempt cannot predate the outbox item");
    }
    if (
      input.outcome === "failed"
      && input.next_attempt_at < input.attempted_at
    ) {
      throw new Error(
        "notification retry cannot be scheduled before the failed attempt",
      );
    }
    const nextAttemptCount = input.expected_attempt_count + 1;
    const result =
      input.outcome === "delivered"
        ? transaction
            .prepare(
              `UPDATE autonomy_notification_outbox
               SET status = 'delivered',
                   attempt_count = @next_attempt_count,
                   last_attempt_at = @attempted_at,
                   delivered_at = @attempted_at,
                   last_error_code = NULL,
                   updated_at = @attempted_at
               WHERE notification_id = @notification_id
                 AND status = 'pending'
                 AND attempt_count = @expected_attempt_count`,
            )
            .run({
              ...input,
              next_attempt_count: nextAttemptCount,
            })
        : transaction
            .prepare(
              `UPDATE autonomy_notification_outbox
               SET status = @next_status,
                   attempt_count = @next_attempt_count,
                   next_attempt_at = @next_attempt_at,
                   last_attempt_at = @attempted_at,
                   dead_lettered_at = @dead_lettered_at,
                   last_error_code = @error_code,
                   updated_at = @attempted_at
               WHERE notification_id = @notification_id
                 AND status = 'pending'
                 AND attempt_count = @expected_attempt_count`,
            )
            .run({
              ...input,
              next_attempt_count: nextAttemptCount,
              next_status:
                nextAttemptCount >= input.max_attempts
                  ? "dead_letter"
                  : "pending",
              dead_lettered_at:
                nextAttemptCount >= input.max_attempts
                  ? input.attempted_at
                  : null,
            });
    if (result.changes !== 1) {
      throw new NotificationAttemptConflictError(input.notification_id);
    }
    return getNotification(transaction, input.notification_id)!;
  });
}

export function acknowledgeNotification(
  db: Database.Database,
  dbPath: string,
  value: {
    notification_id: string;
    acknowledged_at: number;
    acknowledged_by: string;
  },
): NotificationOutboxRow {
  const input = z
    .object({
      notification_id: z.string().regex(/^an_[a-f0-9]{32}$/),
      acknowledged_at: z.number().finite(),
      acknowledged_by: PublicReference,
    })
    .strict()
    .parse(value);
  return withWrite(db, dbPath, (transaction) => {
    const current = getNotification(transaction, input.notification_id);
    if (current === undefined) {
      throw new NotificationAttemptConflictError(input.notification_id);
    }
    if (input.acknowledged_at < current.created_at) {
      throw new Error(
        "notification acknowledgement cannot predate the outbox item",
      );
    }
    const result = transaction
      .prepare(
        `UPDATE autonomy_notification_outbox
         SET status = 'acknowledged',
             acknowledged_at = @acknowledged_at,
             acknowledged_by = @acknowledged_by,
             updated_at = @acknowledged_at
         WHERE notification_id = @notification_id
           AND status IN ('delivered', 'dead_letter')`,
      )
      .run(input);
    if (result.changes !== 1) {
      throw new NotificationAttemptConflictError(input.notification_id);
    }
    return getNotification(transaction, input.notification_id)!;
  });
}

export function summarizeNotificationOutbox(
  db: Database.Database,
  now: number,
): NotificationOutboxSummary {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
         SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END)
           AS dead_letter_count,
         MIN(CASE WHEN status = 'pending' THEN created_at END)
           AS oldest_pending_at,
         MIN(CASE WHEN status = 'dead_letter' THEN created_at END)
           AS oldest_dead_letter_at
       FROM autonomy_notification_outbox`,
    )
    .get() as {
      pending_count: number | null;
      dead_letter_count: number | null;
      oldest_pending_at: number | null;
      oldest_dead_letter_at: number | null;
    };
  const oldest = [row.oldest_pending_at, row.oldest_dead_letter_at]
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)[0];
  return {
    pending_count: row.pending_count ?? 0,
    dead_letter_count: row.dead_letter_count ?? 0,
    oldest_pending_at: row.oldest_pending_at,
    oldest_dead_letter_at: row.oldest_dead_letter_at,
    oldest_attention_age_seconds:
      oldest === undefined ? 0 : Math.max(0, now - oldest),
  };
}
