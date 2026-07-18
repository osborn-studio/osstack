import type Database from "better-sqlite3";
import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const sessionId = z.string().regex(/^probe_[a-z0-9][a-z0-9_-]{7,63}$/);
const itemId = z.string().regex(/^pi_[a-z0-9][a-z0-9_-]{7,63}$/);
const eventId = z.string().regex(/^pe_[a-z0-9][a-z0-9_-]{7,63}$/);
const epochMilliseconds = z.number().int().nonnegative().finite();
const jsonText = z.string().min(2).superRefine((value, context) => {
  try {
    JSON.parse(value);
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "value must be valid JSON text",
    });
  }
});

const ProbeStoredSessionCreateV1 = z
  .object({
    session_id: sessionId,
    repo_id: z.string().trim().min(1).max(256),
    state: z.enum(["active", "paused", "completed", "abandoned"]),
    revision: z.number().int().positive(),
    snapshot_json: jsonText,
    created_at_ms: epochMilliseconds,
    updated_at_ms: epochMilliseconds,
  })
  .strict();

const ProbeStoredItemV1 = z
  .object({
    item_id: itemId,
    question_id: z.string().trim().min(1).max(256),
    state: z.enum(["open", "deferred", "resolved", "waived", "invalidated"]),
    current_quadrant: z.enum(["kk", "ku", "uk", "uu"]),
    severity: z.enum(["high", "medium", "low"]),
    updated_at_ms: epochMilliseconds,
    item_json: jsonText,
  })
  .strict();

const ProbeStoredEventV1 = z
  .object({
    event_id: eventId,
    revision: z.number().int().positive(),
    type: z.string().trim().min(1).max(128),
    idempotency_key: z.string().trim().min(1).max(256),
    event_json: jsonText,
    occurred_at_ms: epochMilliseconds,
  })
  .strict();

const ProbeCommandReceiptV1 = z
  .object({
    scope_key: z.string().trim().min(1).max(512),
    idempotency_key: z.string().trim().min(1).max(256),
    request_sha256: sha256,
    result_json: jsonText,
    created_at_ms: epochMilliseconds,
  })
  .strict();

export const RecordProbeArtifactInputV1 = z
  .object({
    receipt_id: z.string().regex(/^par_[a-z0-9][a-z0-9_-]{7,63}$/),
    session_id: sessionId,
    exported_revision: z.number().int().positive(),
    idempotency_key: z.string().trim().min(1).max(256),
    actor: z
      .object({
        type: z.enum(["human", "agent"]),
        id: z.string().trim().min(1).max(256),
      })
      .strict(),
    manifest_json: jsonText,
    rendered_at_ms: epochMilliseconds,
    request_sha256: sha256,
    result_json: jsonText,
  })
  .strict();
export type RecordProbeArtifactInputV1 = z.infer<
  typeof RecordProbeArtifactInputV1
>;

export const CreateProbeSessionInputV1 = z
  .object({
    session: ProbeStoredSessionCreateV1,
    items: z.array(ProbeStoredItemV1).max(100),
    event: ProbeStoredEventV1,
    receipt: ProbeCommandReceiptV1,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.event.revision !== input.session.revision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["event", "revision"],
        message: "initial event revision must match the session revision",
      });
    }
    if (
      input.event.idempotency_key !== input.receipt.idempotency_key ||
      input.receipt.scope_key !== `repo:${input.session.repo_id}`
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receipt"],
        message: "start receipt scope or idempotency key does not match",
      });
    }
  });
export type CreateProbeSessionInputV1 = z.infer<
  typeof CreateProbeSessionInputV1
>;

export const MutateProbeSessionInputV1 = z
  .object({
    session_id: sessionId,
    expected_revision: z.number().int().positive(),
    session: z
      .object({
        state: z.enum(["active", "paused", "completed", "abandoned"]),
        revision: z.number().int().positive(),
        snapshot_json: jsonText,
        updated_at_ms: epochMilliseconds,
      })
      .strict(),
    items: z.array(ProbeStoredItemV1).max(100),
    event: ProbeStoredEventV1,
    receipt: ProbeCommandReceiptV1,
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.session.revision !== input.expected_revision + 1 ||
      input.event.revision !== input.session.revision
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["session", "revision"],
        message: "a mutation must advance exactly one revision and event",
      });
    }
    if (
      input.event.idempotency_key !== input.receipt.idempotency_key ||
      input.receipt.scope_key !== `session:${input.session_id}`
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receipt"],
        message: "mutation receipt scope or idempotency key does not match",
      });
    }
  });
export type MutateProbeSessionInputV1 = z.infer<
  typeof MutateProbeSessionInputV1
>;

export interface ProbeSessionRowV1 {
  session_id: string;
  repo_id: string;
  state: "active" | "paused" | "completed" | "abandoned";
  revision: number;
  snapshot_json: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface ProbeItemRowV1 {
  session_id: string;
  item_id: string;
  question_id: string;
  state: "open" | "deferred" | "resolved" | "waived" | "invalidated";
  current_quadrant: "kk" | "ku" | "uk" | "uu";
  severity: "high" | "medium" | "low";
  updated_at_ms: number;
  item_json: string;
}

export interface ProbeEventRowV1 {
  event_id: string;
  session_id: string;
  revision: number;
  type: string;
  idempotency_key: string;
  event_json: string;
  occurred_at_ms: number;
}

export interface ProbeStoreCommandResultV1 {
  replayed: boolean;
  result_json: string;
}

export interface ReplayProbeCommandInputV1 {
  scope_key: string;
  idempotency_key: string;
  request_sha256: string;
}

export type ProbeStoreConflictCodeV1 =
  | "idempotency_conflict"
  | "revision_conflict"
  | "session_exists";

export class ProbeStoreConflictError extends Error {
  readonly code: ProbeStoreConflictCodeV1;
  readonly current_revision?: number;

  constructor(
    code: ProbeStoreConflictCodeV1,
    message: string,
    currentRevision?: number,
  ) {
    super(message);
    this.name = "ProbeStoreConflictError";
    this.code = code;
    if (currentRevision !== undefined) this.current_revision = currentRevision;
  }
}

interface ReceiptRow {
  request_sha256: string;
  result_json: string;
}

function replayReceipt(
  db: Database.Database,
  receipt: z.infer<typeof ProbeCommandReceiptV1>,
): ProbeStoreCommandResultV1 | undefined {
  const existing = db
    .prepare(`
      SELECT request_sha256, result_json
      FROM probe_command_receipts
      WHERE scope_key = ? AND idempotency_key = ?
    `)
    .get(receipt.scope_key, receipt.idempotency_key) as ReceiptRow | undefined;
  if (existing === undefined) return undefined;
  if (existing.request_sha256 !== receipt.request_sha256) {
    throw new ProbeStoreConflictError(
      "idempotency_conflict",
      "idempotency key was already used for a different request",
    );
  }
  return { replayed: true, result_json: existing.result_json };
}

export function replayProbeCommand(
  db: Database.Database,
  rawInput: ReplayProbeCommandInputV1,
): ProbeStoreCommandResultV1 | undefined {
  const input = ProbeCommandReceiptV1.pick({
    scope_key: true,
    idempotency_key: true,
    request_sha256: true,
  }).parse(rawInput);
  const existing = db
    .prepare(`
      SELECT request_sha256, result_json
      FROM probe_command_receipts
      WHERE scope_key = ? AND idempotency_key = ?
    `)
    .get(input.scope_key, input.idempotency_key) as ReceiptRow | undefined;
  if (existing === undefined) return undefined;
  if (existing.request_sha256 !== input.request_sha256) {
    throw new ProbeStoreConflictError(
      "idempotency_conflict",
      "idempotency key was already used for a different request",
    );
  }
  return { replayed: true, result_json: existing.result_json };
}

function insertReceipt(
  db: Database.Database,
  receipt: z.infer<typeof ProbeCommandReceiptV1>,
): void {
  db.prepare(`
    INSERT INTO probe_command_receipts (
      scope_key, idempotency_key, request_sha256, result_json, created_at_ms
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    receipt.scope_key,
    receipt.idempotency_key,
    receipt.request_sha256,
    receipt.result_json,
    receipt.created_at_ms,
  );
}

function insertEvent(
  db: Database.Database,
  session: string,
  event: z.infer<typeof ProbeStoredEventV1>,
): void {
  db.prepare(`
    INSERT INTO probe_events (
      event_id, session_id, revision, type, idempotency_key,
      event_json, occurred_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.event_id,
    session,
    event.revision,
    event.type,
    event.idempotency_key,
    event.event_json,
    event.occurred_at_ms,
  );
}

function upsertItems(
  db: Database.Database,
  session: string,
  items: readonly z.infer<typeof ProbeStoredItemV1>[],
): void {
  const statement = db.prepare(`
    INSERT INTO probe_items (
      session_id, item_id, question_id, state, current_quadrant,
      severity, updated_at_ms, item_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, item_id) DO UPDATE SET
      question_id = excluded.question_id,
      state = excluded.state,
      current_quadrant = excluded.current_quadrant,
      severity = excluded.severity,
      updated_at_ms = excluded.updated_at_ms,
      item_json = excluded.item_json
  `);
  for (const item of items) {
    statement.run(
      session,
      item.item_id,
      item.question_id,
      item.state,
      item.current_quadrant,
      item.severity,
      item.updated_at_ms,
      item.item_json,
    );
  }
}

export function createProbeSession(
  db: Database.Database,
  rawInput: CreateProbeSessionInputV1,
): ProbeStoreCommandResultV1 {
  const input = CreateProbeSessionInputV1.parse(rawInput);
  const transaction = db.transaction(() => {
    const replay = replayReceipt(db, input.receipt);
    if (replay !== undefined) return replay;
    const existing = db
      .prepare("SELECT 1 FROM probe_sessions WHERE session_id = ?")
      .get(input.session.session_id);
    if (existing !== undefined) {
      throw new ProbeStoreConflictError(
        "session_exists",
        `session ${input.session.session_id} already exists`,
      );
    }
    db.prepare(`
      INSERT INTO probe_sessions (
        session_id, repo_id, state, revision, snapshot_json,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.session.session_id,
      input.session.repo_id,
      input.session.state,
      input.session.revision,
      input.session.snapshot_json,
      input.session.created_at_ms,
      input.session.updated_at_ms,
    );
    upsertItems(db, input.session.session_id, input.items);
    insertEvent(db, input.session.session_id, input.event);
    insertReceipt(db, input.receipt);
    return { replayed: false, result_json: input.receipt.result_json };
  });
  return transaction.immediate();
}

export function mutateProbeSession(
  db: Database.Database,
  rawInput: MutateProbeSessionInputV1,
): ProbeStoreCommandResultV1 {
  const input = MutateProbeSessionInputV1.parse(rawInput);
  const transaction = db.transaction(() => {
    const replay = replayReceipt(db, input.receipt);
    if (replay !== undefined) return replay;
    const current = db
      .prepare("SELECT revision FROM probe_sessions WHERE session_id = ?")
      .get(input.session_id) as { revision: number } | undefined;
    if (current?.revision !== input.expected_revision) {
      throw new ProbeStoreConflictError(
        "revision_conflict",
        current === undefined
          ? `session ${input.session_id} does not exist`
          : `expected revision ${input.expected_revision}, found ${current.revision}`,
        current?.revision,
      );
    }

    insertEvent(db, input.session_id, input.event);
    upsertItems(db, input.session_id, input.items);
    const updated = db.prepare(`
      UPDATE probe_sessions
      SET state = ?, revision = ?, snapshot_json = ?, updated_at_ms = ?
      WHERE session_id = ? AND revision = ?
    `).run(
      input.session.state,
      input.session.revision,
      input.session.snapshot_json,
      input.session.updated_at_ms,
      input.session_id,
      input.expected_revision,
    );
    if (updated.changes !== 1) {
      throw new ProbeStoreConflictError(
        "revision_conflict",
        "session revision changed during mutation",
      );
    }
    insertReceipt(db, input.receipt);
    return { replayed: false, result_json: input.receipt.result_json };
  });
  return transaction.immediate();
}

export function recordProbeArtifact(
  db: Database.Database,
  rawInput: RecordProbeArtifactInputV1,
): ProbeStoreCommandResultV1 {
  const input = RecordProbeArtifactInputV1.parse(rawInput);
  const commandReceipt = ProbeCommandReceiptV1.parse({
    scope_key: `session:${input.session_id}`,
    idempotency_key: input.idempotency_key,
    request_sha256: input.request_sha256,
    result_json: input.result_json,
    created_at_ms: input.rendered_at_ms,
  });
  const transaction = db.transaction(() => {
    const replay = replayReceipt(db, commandReceipt);
    if (replay !== undefined) return replay;
    const current = db
      .prepare("SELECT revision FROM probe_sessions WHERE session_id = ?")
      .get(input.session_id) as { revision: number } | undefined;
    if (current?.revision !== input.exported_revision) {
      throw new ProbeStoreConflictError(
        "revision_conflict",
        current === undefined
          ? `session ${input.session_id} does not exist`
          : `expected revision ${input.exported_revision}, found ${current.revision}`,
        current?.revision,
      );
    }
    db.prepare(`
      INSERT INTO probe_artifacts (
        receipt_id, session_id, exported_revision, idempotency_key,
        actor_kind, actor_id, manifest_json, rendered_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.receipt_id,
      input.session_id,
      input.exported_revision,
      input.idempotency_key,
      input.actor.type,
      input.actor.id,
      input.manifest_json,
      input.rendered_at_ms,
    );
    insertReceipt(db, commandReceipt);
    return { replayed: false, result_json: input.result_json };
  });
  return transaction.immediate();
}

export function getProbeSession(
  db: Database.Database,
  id: string,
): ProbeSessionRowV1 | undefined {
  const parsedId = sessionId.parse(id);
  return db
    .prepare("SELECT * FROM probe_sessions WHERE session_id = ?")
    .get(parsedId) as ProbeSessionRowV1 | undefined;
}

export function listProbeSessionsByRepo(
  db: Database.Database,
  repoId: string,
): ProbeSessionRowV1[] {
  const parsedRepoId = z.string().trim().min(1).max(256).parse(repoId);
  return db
    .prepare(`
      SELECT * FROM probe_sessions
      WHERE repo_id = ?
      ORDER BY updated_at_ms DESC, session_id
    `)
    .all(parsedRepoId) as ProbeSessionRowV1[];
}

export function findActiveProbeSessionsByTaskRef(
  db: Database.Database,
  repoId: string,
  taskRef: string,
): ProbeSessionRowV1[] {
  const parsedRepoId = z.string().trim().min(1).max(256).parse(repoId);
  const parsedTaskRef = z.string().trim().min(1).max(512).parse(taskRef);
  return db
    .prepare(`
      SELECT * FROM probe_sessions
      WHERE repo_id = ?
        AND state = 'active'
        AND json_extract(snapshot_json, '$.task_ref') = ?
      ORDER BY updated_at_ms DESC, session_id
    `)
    .all(parsedRepoId, parsedTaskRef) as ProbeSessionRowV1[];
}

export function listProbeItems(
  db: Database.Database,
  id: string,
): ProbeItemRowV1[] {
  const parsedId = sessionId.parse(id);
  return db
    .prepare(`
      SELECT * FROM probe_items
      WHERE session_id = ?
      ORDER BY item_id
    `)
    .all(parsedId) as ProbeItemRowV1[];
}

export function listProbeEvents(
  db: Database.Database,
  id: string,
): ProbeEventRowV1[] {
  const parsedId = sessionId.parse(id);
  return db
    .prepare(`
      SELECT * FROM probe_events
      WHERE session_id = ?
      ORDER BY revision, event_id
    `)
    .all(parsedId) as ProbeEventRowV1[];
}
