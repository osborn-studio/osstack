import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
import {
  appendEvent,
  countEvents,
  countPendingTasks,
  countRuns,
  countRunsSince,
  finalizeRun,
  getRun,
  insertRun,
  insertTask,
  listEventsForRun,
} from "./run-store.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "osstack-run-store-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("run-store writers (moved from cli/src/store.ts)", () => {
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

describe("run-store round-trip (write → read via core readers)", () => {
  it("insert + append + finalize, then read back via getRun / listEventsForRun / counts", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      insertTask(db, path, { task_id: "t1", title: "round trip", created_at: 100 });
      insertRun(db, path, {
        run_id: "r1", task_id: "t1", session_id: "s1",
        agent_id: "claude-code", capability_id: "claude-code.code.write",
        phase: "code", started_at: 100,
      });
      appendEvent(db, path, {
        event_id: "r1:0", seq: 0, run_id: "r1", session_id: "s1",
        created_at: 100, terminal: false, type: "run.started", payload: { status: "running" },
      });
      appendEvent(db, path, {
        event_id: "r1:1", seq: 1, run_id: "r1", session_id: "s1",
        created_at: 101, terminal: true, type: "done", payload: { status: "completed", last_seq: 1 },
      });
      finalizeRun(db, path, "r1", "completed", 102);

      const run = getRun(db, "r1");
      expect(run).toEqual({ run_id: "r1", session_id: "s1", phase: "code" });

      const events = listEventsForRun(db, "r1");
      expect(events.map((e) => e.seq)).toEqual([0, 1]);
      expect(events[0]?.type).toBe("run.started");
      expect(events[1]?.terminal).toBe(1);
      expect(events[0]?.terminal).toBe(0);

      // afterSeq filter excludes seq <= afterSeq.
      expect(listEventsForRun(db, "r1", { afterSeq: 0 }).map((e) => e.seq)).toEqual([1]);

      expect(countRuns(db)).toBe(1);
      expect(countEvents(db)).toBe(2);
      expect(countRunsSince(db, 100)).toBe(1);
      expect(countRunsSince(db, 101)).toBe(0);
    } finally { db.close(); }
  });

  it("getRun returns undefined for an unknown run_id", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      expect(getRun(db, "missing")).toBeUndefined();
    } finally { db.close(); }
  });

  it("countPendingTasks counts only 'pending' tasks", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      // insertTask writes status='running'; force one row to 'pending' directly.
      insertTask(db, path, { task_id: "t1", title: "a", created_at: 0 });
      insertTask(db, path, { task_id: "t2", title: "b", created_at: 0 });
      expect(countPendingTasks(db)).toBe(0);
      db.prepare("UPDATE tasks SET status = 'pending' WHERE task_id = 't1'").run();
      expect(countPendingTasks(db)).toBe(1);
    } finally { db.close(); }
  });
});

describe("run-store concurrency", () => {
  it("parallel appendEvent writers complete without corruption", async () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      insertTask(db, path, { task_id: "t1", title: "concurrent", created_at: 0 });
      insertRun(db, path, {
        run_id: "r1", task_id: "t1", session_id: "s1",
        agent_id: "claude-code", capability_id: "x", phase: "code", started_at: 0,
      });
      const N = 20;
      await Promise.all(
        Array.from({ length: N }, (_unused, i) =>
          Promise.resolve().then(() =>
            appendEvent(db, path, {
              event_id: `r1:${i}`, seq: i, run_id: "r1", session_id: "s1",
              created_at: i, terminal: false, type: "status", payload: { i },
            }),
          ),
        ),
      );
      expect(countEvents(db)).toBe(N);
      const events = listEventsForRun(db, "r1");
      expect(events.map((e) => e.seq)).toEqual(Array.from({ length: N }, (_u, i) => i));
    } finally { db.close(); }
  });
});

describe("run-store error paths (current verbatim behavior)", () => {
  it("finalizeRun on an unknown run_id is a no-op, not a throw", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      expect(() => finalizeRun(db, path, "nope", "completed", 5)).not.toThrow();
      expect(countRuns(db)).toBe(0);
    } finally { db.close(); }
  });
});

describe("run-store approval/clarify double-write", () => {
  it("approval.requested creates a pending approvals row", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      insertTask(db, path, { task_id: "t1", title: "approval", created_at: 0 });
      insertRun(db, path, {
        run_id: "r1", task_id: "t1", session_id: "s1",
        agent_id: "claude-code", capability_id: "x", phase: "code", started_at: 0,
      });
      appendEvent(db, path, {
        event_id: "r1:0", seq: 0, run_id: "r1", session_id: "s1",
        created_at: 10, terminal: false, type: "approval.requested",
        payload: { approval_id: "a1", action_summary: "delete files", risk: "high" },
      });
      const row = db.prepare("SELECT approval_id, run_id, status, action_summary, risk FROM approvals WHERE approval_id = ?")
        .get("a1") as { approval_id: string; run_id: string; status: string; action_summary: string; risk: string };
      expect(row).toEqual({
        approval_id: "a1", run_id: "r1", status: "pending", action_summary: "delete files", risk: "high",
      });
    } finally { db.close(); }
  });

  it("approval.resolved updates the approvals row status/choice", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      insertTask(db, path, { task_id: "t1", title: "approval", created_at: 0 });
      insertRun(db, path, {
        run_id: "r1", task_id: "t1", session_id: "s1",
        agent_id: "claude-code", capability_id: "x", phase: "code", started_at: 0,
      });
      appendEvent(db, path, {
        event_id: "r1:0", seq: 0, run_id: "r1", session_id: "s1",
        created_at: 10, terminal: false, type: "approval.requested",
        payload: { approval_id: "a1", action_summary: "delete files", risk: "high" },
      });
      appendEvent(db, path, {
        event_id: "r1:1", seq: 1, run_id: "r1", session_id: "s1",
        created_at: 11, terminal: false, type: "approval.resolved",
        payload: { approval_id: "a1", choice: "approve", status: "accepted" },
      });
      const row = db.prepare("SELECT status, choice FROM approvals WHERE approval_id = ?").get("a1") as
        { status: string; choice: string };
      expect(row.status).toBe("accepted");
      expect(row.choice).toBe("approve");
    } finally { db.close(); }
  });

  it("clarify.requested creates a pending clarifies row", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      insertTask(db, path, { task_id: "t1", title: "clarify", created_at: 0 });
      insertRun(db, path, {
        run_id: "r1", task_id: "t1", session_id: "s1",
        agent_id: "claude-code", capability_id: "x", phase: "code", started_at: 0,
      });
      appendEvent(db, path, {
        event_id: "r1:0", seq: 0, run_id: "r1", session_id: "s1",
        created_at: 10, terminal: false, type: "clarify.requested",
        payload: { clarify_id: "c1", question: "which branch?" },
      });
      const row = db.prepare("SELECT clarify_id, run_id, status, question FROM clarifies WHERE clarify_id = ?")
        .get("c1") as { clarify_id: string; run_id: string; status: string; question: string };
      expect(row).toEqual({ clarify_id: "c1", run_id: "r1", status: "pending", question: "which branch?" });
    } finally { db.close(); }
  });
});

it.each(["approval", "clarify"])("fences %s resolution by run and pending status, rolling back rejected events", (family) => {
  const path = join(tmp, "authority.db");
  const db = openDb({ path });
  try {
    insertTask(db, path, { task_id: "t", title: "authority", created_at: 1 });
    for (const run of ["a", "b"]) insertRun(db, path, { task_id: "t", run_id: run, session_id: run,
      agent_id: "hermes", capability_id: "code", phase: "execute", started_at: 1 });
    const emit = (run: string, seq: number, status?: string, answer = "yes") => appendEvent(db, path, {
      event_id: `${run}:${seq}`, run_id: run, session_id: run, seq, created_at: seq + 1, terminal: false,
      type: `${family}.${seq === 0 ? "requested" : "resolved"}`,
      payload: { [`${family}_id`]: "shared", action_summary: "publish", risk: "high", question: "Choose",
        ...(status === undefined ? {} : { status }), choice: answer, answer },
    });
    emit("a", 0);
    const status = family === "approval" ? "accepted" : "answered";
    expect(() => emit("b", 1, status)).toThrow(`${family}_resolution_conflict`);
    const table = family === "approval" ? "approvals" : "clarifies";
    expect(db.prepare(`SELECT run_id,status FROM ${table}`).get()).toEqual({ run_id: "a", status: "pending" });
    expect(db.prepare("SELECT COUNT(*) n FROM events WHERE run_id='b'").get()).toEqual({ n: 0 });
    expect(() => emit("a", 1)).toThrow(`invalid_${family}_resolution`);
    emit("a", 1, status);
    emit("a", 2, status); // Matching adapter echo preserves the original resolution timestamp.
    expect(() => emit("a", 3, "timed_out")).toThrow(`${family}_resolution_conflict`);
    expect(() => emit("a", 3, status, "different")).toThrow(`${family}_resolution_conflict`);
    expect(() => emit("b", 1, status)).toThrow(`${family}_resolution_conflict`);
    expect(db.prepare(`SELECT status,resolved_at FROM ${table}`).get()).toEqual({ status, resolved_at: 2 });
    expect(db.prepare("SELECT COUNT(*) n FROM events WHERE run_id='a'").get()).toEqual({ n: 3 });
  } finally { db.close(); }
});
