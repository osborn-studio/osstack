// Daemon-side persistence helpers. Thin wrappers over @osstack/core/state so
// the daemon hot loop has compact, typed inserts.

import type Database from "better-sqlite3";
import { withWrite } from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";

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
  ev: HermesEvent,
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
