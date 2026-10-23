// Run/task/event state repositories (R1.1 — relocated from packages/cli/src/store.ts
// per ADR-001 §D2). This module owns the run/task/event persistence for the
// kernel: the four daemon-hot-loop writers and the reader functions consolidated
// from the CLI's raw-SQL sites. An external consumer can now read run/event/proof
// state through @osstack/core without the product-private CLI.
//
// Ownership relocation ONLY (ADR-001 §D2, owner-set): identical SQL semantics,
// no schema change, no new DB design, no business-logic refactoring. The SQL and
// result mapping below are extracted verbatim from their prior CLI locations.

import type Database from "better-sqlite3";
import { withWrite } from "./db.js";

/**
 * Structural input for {@link appendEvent}. Defined locally (not imported from
 * @osstack/hermes-adapter) to avoid a dependency cycle: hermes-adapter depends
 * on core, so core must not import it. `HermesEvent` is structurally assignable
 * to this shape, so CLI call sites pass their `HermesEvent` values unchanged.
 */
export interface StoredEventInput {
  event_id: string;
  seq: number;
  run_id: string;
  session_id: string;
  created_at: number;
  terminal: boolean;
  type: string;
  payload: unknown;
}

/** Row shape returned by {@link listEventsForRun} (superset of columns). */
export interface StoredEventRow {
  event_id: string;
  run_id: string;
  session_id: string;
  seq: number;
  type: string;
  created_at: number;
  terminal: number;
  payload_json: string;
}

/** Row shape returned by {@link getRun}. */
export interface RunIdentityRow {
  run_id: string;
  session_id: string;
  phase: string;
}

// ──────────────────────────────────────────────────────────────────────
// Writers (moved verbatim from cli/src/store.ts)
// ──────────────────────────────────────────────────────────────────────

export function insertTask(
  db: Database.Database,
  path: string,
  row: {
    task_id: string;
    title: string;
    description?: string;
    hermes_session_id?: string | null;
    created_at: number;
  },
): void {
  withWrite(db, path, (d) => {
    d.prepare(
      "INSERT INTO tasks(task_id, title, description, hermes_session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      row.task_id,
      row.title,
      row.description ?? "",
      row.hermes_session_id ?? null,
      "running",
      row.created_at,
      row.created_at,
    );
  });
}

export function insertRun(
  db: Database.Database,
  path: string,
  row: {
    run_id: string;
    task_id: string;
    session_id: string;
    agent_id: string;
    capability_id: string;
    phase: string;
    started_at: number;
    hermes_session_id?: string | null;
  },
): void {
  withWrite(db, path, (d) => {
    d.prepare(
      "INSERT INTO runs(run_id, task_id, session_id, agent_id, capability_id, phase, started_at, hermes_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      row.run_id,
      row.task_id,
      row.session_id,
      row.agent_id,
      row.capability_id,
      row.phase,
      row.started_at,
      row.hermes_session_id ?? null,
    );
  });
}

export function appendEvent(
  db: Database.Database,
  path: string,
  ev: StoredEventInput,
): void {
  withWrite(db, path, (d) => {
    d.prepare(
      "INSERT INTO events(event_id, run_id, session_id, seq, type, created_at, terminal, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      ev.event_id,
      ev.run_id,
      ev.session_id,
      ev.seq,
      ev.type,
      ev.created_at,
      ev.terminal ? 1 : 0,
      JSON.stringify(ev.payload),
    );

    // Approval / clarify events double-write to their own tables so they
    // survive a daemon restart (Hermes RFC durability requirement) and
    // can be queried via approval.list / clarify.list without scanning
    // the event log.
    if (ev.type === "approval.requested") {
      const p = ev.payload as { approval_id?: string; action_summary?: string; risk?: string };
      if (typeof p.approval_id === "string") {
        d.prepare(
          "INSERT OR IGNORE INTO approvals(approval_id, run_id, status, action_summary, risk, requested_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(p.approval_id, ev.run_id, "pending", p.action_summary ?? "", p.risk ?? "medium", ev.created_at);
      }
    } else if (ev.type === "approval.resolved") {
      const p = ev.payload as { approval_id?: string; choice?: string; status?: string };
      if (typeof p.approval_id === "string") {
        d.prepare(
          "UPDATE approvals SET status = ?, resolved_at = ?, choice = ? WHERE approval_id = ?",
        ).run(p.status === "rejected" ? "rejected" : p.status === "timed_out" ? "timed_out" : "accepted",
              ev.created_at, p.choice ?? null, p.approval_id);
      }
    } else if (ev.type === "clarify.requested") {
      const p = ev.payload as { clarify_id?: string; question?: string };
      if (typeof p.clarify_id === "string") {
        d.prepare(
          "INSERT OR IGNORE INTO clarifies(clarify_id, run_id, status, question, requested_at) VALUES (?, ?, ?, ?, ?)",
        ).run(p.clarify_id, ev.run_id, "pending", p.question ?? "", ev.created_at);
      }
    } else if (ev.type === "clarify.resolved") {
      const p = ev.payload as { clarify_id?: string; answer?: string; status?: string };
      if (typeof p.clarify_id === "string") {
        d.prepare(
          "UPDATE clarifies SET status = ?, resolved_at = ?, answer = ? WHERE clarify_id = ?",
        ).run(p.status === "timed_out" ? "timed_out" : p.status === "abandoned" ? "abandoned" : "answered",
              ev.created_at, p.answer ?? null, p.clarify_id);
      }
    }
  });
}

export function finalizeRun(
  db: Database.Database,
  path: string,
  run_id: string,
  outcome: "completed" | "failed" | "cancelled" | "expired",
  completed_at: number,
): void {
  // SQLite UPDATE expressions read pre-UPDATE column values, so we must
  // compute duration in JS using the read-back started_at — not refer to
  // `completed_at` inside the same UPDATE (it would be NULL on first set).
  withWrite(db, path, (d) => {
    const row = d.prepare("SELECT started_at FROM runs WHERE run_id = ?").get(run_id) as
      | { started_at: number }
      | undefined;
    const duration_ms = row ? (completed_at - row.started_at) * 1000 : null;
    d.prepare(
      "UPDATE runs SET outcome = ?, completed_at = ?, duration_ms = ? WHERE run_id = ?",
    ).run(outcome, completed_at, duration_ms, run_id);
    d.prepare(
      "UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = (SELECT task_id FROM runs WHERE run_id = ?)",
    ).run(
      outcome === "completed" ? "done" : outcome,
      completed_at,
      run_id,
    );
  });
}

// ──────────────────────────────────────────────────────────────────────
// Readers (consolidated verbatim from the CLI raw-SQL sites)
// ──────────────────────────────────────────────────────────────────────

/** Count runs started at or after `since` (unix seconds). From daemon.ts. */
export function countRunsSince(db: Database.Database, since: number): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM runs WHERE started_at >= ?").get(since) as { c: number }).c;
}

/** Total run count. From daemon.ts. */
export function countRuns(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM runs").get() as { c: number }).c;
}

/** Total event count. From daemon.ts / dashboard.ts. */
export function countEvents(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
}

/** Count tasks in the 'pending' status. From dashboard.ts. */
export function countPendingTasks(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status = 'pending'").get() as
    | { c: number }
    | undefined)?.c ?? 0;
}

/** Run identity columns for a single run. From bin.ts. */
export function getRun(db: Database.Database, runId: string): RunIdentityRow | undefined {
  return db.prepare("SELECT run_id, session_id, phase FROM runs WHERE run_id = ?").get(runId) as
    | RunIdentityRow
    | undefined;
}

/**
 * Events for a run, ordered by seq ascending. From daemon.ts (snapshot replay)
 * and bin.ts (persisted loop evidence). `afterSeq` defaults to -1 so a caller
 * that wants every event (bin.ts) gets `seq > -1` — behavior-identical to the
 * unfiltered `WHERE run_id = ?` query, since seq is always ≥ 0. The returned
 * superset includes `terminal`; call sites that ignore it are unaffected.
 */
export function listEventsForRun(
  db: Database.Database,
  runId: string,
  opts: { afterSeq?: number } = {},
): StoredEventRow[] {
  const afterSeq = opts.afterSeq ?? -1;
  return db.prepare(
    "SELECT event_id, run_id, session_id, seq, type, created_at, terminal, payload_json FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC",
  ).all(runId, afterSeq) as StoredEventRow[];
}

/** Bounded local/default-tenant reader. Oversized payloads never enter JS. */
export interface BoundedRunEvent extends Omit<StoredEventRow, "payload_json"> {
  payload_json: string | null;
  payload_bytes: number;
}
export function readRunEventPage(db: Database.Database, input: {
  taskId: string;
  runId: string;
  afterSeq: number;
  limit: number;
  throughSeq?: number;
}): {
  events: BoundedRunEvent[];
  nextAfter: number;
  highWatermark: number;
  availableHighWatermark: number;
  hasMore: boolean;
  sequenceGap: boolean;
} {
  if (!input.taskId || !input.runId || !Number.isSafeInteger(input.afterSeq) || input.afterSeq < -1
    || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200
    || (input.throughSeq !== undefined && (!Number.isSafeInteger(input.throughSeq) || input.throughSeq < input.afterSeq)))
    throw new Error("invalid_event_page");
  const read = () => {
    const source = db.prepare(`SELECT 1 FROM runs r JOIN tasks t ON t.task_id=r.task_id
      WHERE r.run_id=? AND r.task_id=? AND r.tenant_id IS NULL AND t.tenant_id IS NULL`).get(input.runId, input.taskId);
    if (!source) throw new Error("run_source_not_found");
    const max = (db.prepare("SELECT COALESCE(MAX(seq),-1) seq FROM events WHERE run_id=?").get(input.runId) as { seq: number }).seq;
    const first = db.prepare("SELECT seq FROM events WHERE run_id=? ORDER BY seq LIMIT 1").get(input.runId) as { seq: number } | undefined;
    if (!Number.isSafeInteger(max) || max < -1 || (first && (!Number.isSafeInteger(first.seq) || first.seq < 0)))
      throw new Error("invalid_event_sequence");
    const high = input.throughSeq ?? max;
    const rows = db.prepare(`SELECT substr(event_id,1,4097) event_id,run_id,substr(session_id,1,4097) session_id,
      seq,substr(type,1,257) type,created_at,terminal,length(CAST(payload_json AS BLOB)) payload_bytes,
      CASE WHEN length(CAST(payload_json AS BLOB))<=65536 THEN payload_json ELSE NULL END payload_json
      FROM events WHERE run_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?`)
      .all(input.runId, input.afterSeq, high, input.limit + 1) as BoundedRunEvent[];
    const events = rows.slice(0, input.limit);
    let previous = input.afterSeq;
    let gap = max < input.afterSeq || max < high;
    for (const event of events) {
      if (!Number.isSafeInteger(event.seq) || event.seq !== previous + 1) gap = true;
      previous = event.seq;
    }
    return { events, nextAfter: events.at(-1)?.seq ?? input.afterSeq, highWatermark: high,
      availableHighWatermark: max, hasMore: rows.length > input.limit, sequenceGap: gap };
  };
  return db.inTransaction ? read() : db.transaction(read)();
}
