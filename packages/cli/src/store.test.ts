import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@osstack/core";
import { appendEvent, finalizeRun, insertRun, insertTask } from "./store.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "osstack-store-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("store", () => {
  it("inserts a task + run and appends events", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      insertTask(db, path, { task_id: "t1", title: "hello", created_at: 100 });
      insertRun(db, path, {
        run_id: "r1", task_id: "t1", session_id: "s1",
        agent_id: "claude-code", capability_id: "claude-code.code.write",
        phase: "code", started_at: 100,
      });
      appendEvent(db, path, {
        event_id: "r1:0", seq: 0, run_id: "r1", session_id: "s1",
        created_at: 100, terminal: false, type: "run.started",
        payload: { status: "running", controls: {
          cancel: true, approval_pending: false, clarify_pending: false, queue: false, goal: false,
        } },
      });
      const row = db.prepare("SELECT task_id, status FROM tasks").get() as { task_id: string; status: string };
      expect(row.task_id).toBe("t1");
      expect(row.status).toBe("running");

      const ev = db.prepare("SELECT seq, type, terminal FROM events WHERE run_id = ?").get("r1") as
        | { seq: number; type: string; terminal: number }
        | undefined;
      expect(ev?.seq).toBe(0);
      expect(ev?.type).toBe("run.started");
      expect(ev?.terminal).toBe(0);
    } finally { db.close(); }
  });

  it("finalizeRun sets duration_ms correctly (regression for SQLite same-statement-read bug)", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      insertTask(db, path, { task_id: "t1", title: "hello", created_at: 100.0 });
      insertRun(db, path, {
        run_id: "r1", task_id: "t1", session_id: "s1",
        agent_id: "claude-code", capability_id: "x", phase: "code", started_at: 100.0,
      });
      finalizeRun(db, path, "r1", "completed", 102.5);
      const row = db.prepare("SELECT outcome, completed_at, duration_ms FROM runs WHERE run_id = ?").get("r1") as
        | { outcome: string; completed_at: number; duration_ms: number }
        | undefined;
      expect(row?.outcome).toBe("completed");
      expect(row?.completed_at).toBeCloseTo(102.5, 6);
      // 2.5s = 2500ms
      expect(row?.duration_ms).toBeCloseTo(2500, 6);
      const task = db.prepare("SELECT status FROM tasks WHERE task_id = ?").get("t1") as { status: string };
      expect(task.status).toBe("done");
    } finally { db.close(); }
  });

  it("finalizeRun maps failed/cancelled outcomes to task.status", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      insertTask(db, path, { task_id: "t1", title: "x", created_at: 0 });
      insertRun(db, path, {
        run_id: "r1", task_id: "t1", session_id: "s1",
        agent_id: "claude-code", capability_id: "x", phase: "code", started_at: 0,
      });
      finalizeRun(db, path, "r1", "cancelled", 5);
      const task = db.prepare("SELECT status FROM tasks").get() as { status: string };
      expect(task.status).toBe("cancelled");
    } finally { db.close(); }
  });
});
