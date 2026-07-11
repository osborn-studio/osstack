import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@osstack/core";
import { appendEvent, finalizeRun, insertRun, insertTask } from "./store.js";

// R1.1 compat test: the state repositories moved to @osstack/core, but the old
// "./store.js" import path must keep working via the re-export shim. This proves
// a full round-trip through the shim; the exhaustive matrix lives in
// packages/core/src/state/run-store.test.ts.

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "osstack-store-shim-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("store compat shim (re-exports @osstack/core)", () => {
  it("round-trips insertTask + insertRun + appendEvent + finalizeRun via ./store.js", () => {
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
      finalizeRun(db, path, "r1", "completed", 102.5);

      const task = db.prepare("SELECT status FROM tasks WHERE task_id = ?").get("t1") as { status: string };
      expect(task.status).toBe("done");
      const run = db.prepare("SELECT outcome, duration_ms FROM runs WHERE run_id = ?").get("r1") as
        { outcome: string; duration_ms: number };
      expect(run.outcome).toBe("completed");
      expect(run.duration_ms).toBeCloseTo(2500, 6);
      const ev = db.prepare("SELECT type FROM events WHERE run_id = ?").get("r1") as { type: string };
      expect(ev.type).toBe("run.started");
    } finally { db.close(); }
  });
});
