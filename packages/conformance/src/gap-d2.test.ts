import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@osstack/core";

// R0.5 conformance #4 — Gap D2 CLOSED.
//
// ADR-001 (docs/decisions/ADR-001-shared-control-kernel.md) §D2 recorded a known
// kernel boundary debt: the run/task/event *read* repositories lived in
// packages/cli/src/store.ts (plus raw SELECTs in daemon.ts/dashboard.ts/bin.ts),
// NOT in @osstack/core — so an external consumer could not read run/event state
// from the kernel without the product-private CLI.
//
// R1.1 relocated the state repositories into packages/core/src/state/run-store.ts.
// Per the MUST-FLIP banner that previously lived here, this test is now a POSITIVE
// round-trip: an external consumer inserts a run + events via core writers and
// reads them back via getRun / listEventsForRun through the public @osstack/core
// surface — using ONLY the kernel package, never the product-private CLI. This
// closes Gap D2. (The import-boundary test enforces the no-CLI-coupling rule; the
// forbidden CLI specifier is deliberately kept out of this file.)

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "osstack-gap-d2-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("Gap D2 (ADR-001 §D2) — kernel CAN read run/event state (closed by R1.1)", () => {
  it("exports the R1.1 state readers from @osstack/core's public surface", () => {
    const exportedNames = Object.keys(core);
    for (const reader of ["getRun", "listEventsForRun", "countEvents"]) {
      expect(exportedNames).toContain(reader);
      expect(typeof (core as Record<string, unknown>)[reader]).toBe("function");
    }
  });

  it("round-trips a run + events through @osstack/core without the product CLI", () => {
    const path = join(tmp, "state.db");
    const db = core.openDb({ path });
    try {
      core.insertTask(db, path, { task_id: "t1", title: "conformance", created_at: 100 });
      core.insertRun(db, path, {
        run_id: "r1", task_id: "t1", session_id: "s1",
        agent_id: "claude-code", capability_id: "claude-code.code.write",
        phase: "code", started_at: 100,
      });
      core.appendEvent(db, path, {
        event_id: "r1:0", seq: 0, run_id: "r1", session_id: "s1",
        created_at: 100, terminal: false, type: "run.started", payload: { status: "running" },
      });
      core.appendEvent(db, path, {
        event_id: "r1:1", seq: 1, run_id: "r1", session_id: "s1",
        created_at: 101, terminal: true, type: "done", payload: { status: "completed", last_seq: 1 },
      });
      core.finalizeRun(db, path, "r1", "completed", 102);

      const run = core.getRun(db, "r1");
      expect(run).toEqual({ run_id: "r1", session_id: "s1", phase: "code" });

      const events = core.listEventsForRun(db, "r1");
      expect(events.map((e) => e.seq)).toEqual([0, 1]);
      expect(events[1]?.terminal).toBe(1);
      expect(core.countEvents(db)).toBe(2);
    } finally {
      db.close();
    }
  });
});
