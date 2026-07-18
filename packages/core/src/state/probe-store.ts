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

export const ProbeRepoPortfolioSummaryV1 = z
  .object({
    repo_id: z.string().trim().min(1).max(256),
    session_count: z.number().int().nonnegative(),
    in_progress_session_count: z.number().int().nonnegative(),
    completed_session_count: z.number().int().nonnegative(),
    open_by_severity: z
      .object({
        high: z.number().int().nonnegative(),
        medium: z.number().int().nonnegative(),
        low: z.number().int().nonnegative(),
      })
      .strict(),
    oldest_open_age_days: z.number().int().nonnegative().nullable(),
    deferred_due: z.number().int().nonnegative(),
    waived_active: z.number().int().nonnegative(),
    waived_expired: z.number().int().nonnegative(),
    required_total: z.number().int().nonnegative(),
    required_disposed: z.number().int().nonnegative(),
    completion_percent: z.number().min(0).max(100).finite(),
  })
  .strict();
export type ProbeRepoPortfolioSummaryV1 = z.infer<
  typeof ProbeRepoPortfolioSummaryV1
>;

export const ProbePortfolioSummaryV1 = z
  .object({
    schema_version: z.literal("1"),
    as_of_ms: epochMilliseconds,
    repos: z.array(ProbeRepoPortfolioSummaryV1),
  })
  .strict();
export type ProbePortfolioSummaryV1 = z.infer<
  typeof ProbePortfolioSummaryV1
>;

export const QueryProbePortfolioSummaryInputV1 = z
  .object({
    as_of_ms: epochMilliseconds.optional(),
    repo_ids: z
      .array(z.string().trim().min(1).max(256))
      .max(10_000)
      .optional(),
    max_deferred_age_days: z.number().int().positive().max(3_650).optional(),
    max_waiver_age_days: z.number().int().positive().max(3_650).optional(),
  })
  .strict();
export type QueryProbePortfolioSummaryInputV1 = z.infer<
  typeof QueryProbePortfolioSummaryInputV1
>;

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

const probePortfolioSessionJson = z
  .object({
    unselected_required_question_ids: z.array(z.string()).optional(),
  })
  .passthrough();

const probePortfolioItemJson = z
  .object({
    required: z.boolean(),
    created_at_ms: epochMilliseconds,
    deferral: z
      .object({
        deferred_at_ms: epochMilliseconds,
        review_after_ms: epochMilliseconds.optional(),
      })
      .passthrough()
      .optional(),
    waiver: z
      .object({
        approved_at_ms: epochMilliseconds,
        expires_at_ms: epochMilliseconds.optional(),
      })
      .passthrough()
      .optional(),
    invalidation: z
      .object({
        actor: z.object({ type: z.enum(["human", "agent"]) }).passthrough(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

interface ProbePortfolioSessionRow {
  session_id: string;
  repo_id: string;
  state: ProbeSessionRowV1["state"];
  snapshot_json: string;
}

interface MutableProbeRepoPortfolioSummary {
  repo_id: string;
  session_count: number;
  in_progress_session_count: number;
  completed_session_count: number;
  open_by_severity: { high: number; medium: number; low: number };
  oldest_open_at_ms: number | null;
  deferred_due: number;
  waived_active: number;
  waived_expired: number;
  required_total: number;
  required_disposed: number;
}

function parseStoredJson<T>(
  json: string,
  schema: z.ZodType<T>,
  context: string,
): T {
  try {
    return schema.parse(JSON.parse(json) as unknown);
  } catch (error) {
    throw new Error(
      `invalid ${context}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Read-only portfolio projection for daily/supervisor consumers. Historical
 * sessions are counted, while readiness obligations and completion are scoped
 * to active/paused sessions so completed history cannot inflate current work.
 */
export function queryProbePortfolioSummary(
  db: Database.Database,
  rawInput: QueryProbePortfolioSummaryInputV1 = {},
): ProbePortfolioSummaryV1 {
  const input = QueryProbePortfolioSummaryInputV1.parse(rawInput);
  const asOf = input.as_of_ms ?? Date.now();
  const repoIds = input.repo_ids === undefined
    ? undefined
    : [...new Set(input.repo_ids)];
  if (repoIds?.length === 0) {
    return ProbePortfolioSummaryV1.parse({
      schema_version: "1",
      as_of_ms: asOf,
      repos: [],
    });
  }
  const deferredAgeMs = (input.max_deferred_age_days ?? 14) * 86_400_000;
  const waiverAgeMs = (input.max_waiver_age_days ?? 30) * 86_400_000;
  const sessionRepoClause = repoIds === undefined
    ? ""
    : `WHERE repo_id IN (${repoIds.map(() => "?").join(", ")})`;
  const sessions = db.prepare(`
    SELECT session_id, repo_id, state, snapshot_json
    FROM probe_sessions
    ${sessionRepoClause}
    ORDER BY repo_id, created_at_ms, session_id
  `).all(...(repoIds ?? [])) as ProbePortfolioSessionRow[];
  const inProgressSessions = new Map<string, string>();
  const summaries = new Map<string, MutableProbeRepoPortfolioSummary>();

  for (const session of sessions) {
    const summary = summaries.get(session.repo_id) ?? {
      repo_id: session.repo_id,
      session_count: 0,
      in_progress_session_count: 0,
      completed_session_count: 0,
      open_by_severity: { high: 0, medium: 0, low: 0 },
      oldest_open_at_ms: null,
      deferred_due: 0,
      waived_active: 0,
      waived_expired: 0,
      required_total: 0,
      required_disposed: 0,
    };
    summary.session_count += 1;
    if (session.state === "completed") summary.completed_session_count += 1;
    if (session.state === "active" || session.state === "paused") {
      summary.in_progress_session_count += 1;
      inProgressSessions.set(session.session_id, session.repo_id);
      const snapshot = parseStoredJson(
        session.snapshot_json,
        probePortfolioSessionJson,
        `probe session ${session.session_id} snapshot`,
      );
      summary.required_total +=
        snapshot.unselected_required_question_ids?.length ?? 0;
    }
    summaries.set(session.repo_id, summary);
  }

  const itemRepoClause = repoIds === undefined
    ? ""
    : `AND sessions.repo_id IN (${repoIds.map(() => "?").join(", ")})`;
  const items = db.prepare(`
    SELECT items.session_id, items.item_id, items.question_id, items.state,
           items.current_quadrant, items.severity, items.updated_at_ms,
           items.item_json
    FROM probe_items AS items
    JOIN probe_sessions AS sessions
      ON sessions.session_id = items.session_id
    WHERE sessions.state IN ('active', 'paused')
    ${itemRepoClause}
    ORDER BY items.session_id, items.item_id
  `).all(...(repoIds ?? [])) as ProbeItemRowV1[];
  for (const row of items) {
    const repoId = inProgressSessions.get(row.session_id);
    if (repoId === undefined) continue;
    const summary = summaries.get(repoId);
    if (summary === undefined) continue;
    const item = parseStoredJson(
      row.item_json,
      probePortfolioItemJson,
      `probe item ${row.item_id}`,
    );
    if (item.required) summary.required_total += 1;
    if (row.state === "open") {
      summary.open_by_severity[row.severity] += 1;
      summary.oldest_open_at_ms = summary.oldest_open_at_ms === null
        ? item.created_at_ms
        : Math.min(summary.oldest_open_at_ms, item.created_at_ms);
    } else if (row.state === "deferred") {
      if (item.deferral === undefined) {
        throw new Error(`invalid probe item ${row.item_id}: deferred item lacks deferral`);
      }
      const due =
        (item.deferral.review_after_ms !== undefined &&
          item.deferral.review_after_ms <= asOf) ||
        asOf - item.deferral.deferred_at_ms >= deferredAgeMs;
      if (due) summary.deferred_due += 1;
    } else if (row.state === "waived") {
      if (item.waiver === undefined) {
        throw new Error(`invalid probe item ${row.item_id}: waived item lacks waiver`);
      }
      const expired =
        (item.waiver.expires_at_ms !== undefined &&
          item.waiver.expires_at_ms <= asOf) ||
        asOf - item.waiver.approved_at_ms >= waiverAgeMs;
      if (expired) summary.waived_expired += 1;
      else {
        summary.waived_active += 1;
        if (item.required) summary.required_disposed += 1;
      }
    } else if (row.state === "resolved") {
      if (item.required) summary.required_disposed += 1;
    } else if (
      row.state === "invalidated" &&
      item.required &&
      item.invalidation?.actor.type === "human"
    ) {
      summary.required_disposed += 1;
    }
  }

  const repos = [...summaries.values()]
    .sort((left, right) => left.repo_id.localeCompare(right.repo_id))
    .map((summary) => ProbeRepoPortfolioSummaryV1.parse({
      repo_id: summary.repo_id,
      session_count: summary.session_count,
      in_progress_session_count: summary.in_progress_session_count,
      completed_session_count: summary.completed_session_count,
      open_by_severity: summary.open_by_severity,
      oldest_open_age_days: summary.oldest_open_at_ms === null
        ? null
        : Math.max(0, Math.floor((asOf - summary.oldest_open_at_ms) / 86_400_000)),
      deferred_due: summary.deferred_due,
      waived_active: summary.waived_active,
      waived_expired: summary.waived_expired,
      required_total: summary.required_total,
      required_disposed: summary.required_disposed,
      completion_percent: summary.required_total === 0
        ? 100
        : Math.round(
          (summary.required_disposed / summary.required_total) * 10_000,
        ) / 100,
    }));
  return ProbePortfolioSummaryV1.parse({
    schema_version: "1",
    as_of_ms: asOf,
    repos,
  });
}
