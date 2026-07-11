import { describe, expect, it } from "vitest";
import * as core from "@osstack/core";

// R0.5 conformance #4 — Gap D2 documentation test.
//
// ADR-001 (docs/decisions/ADR-001-shared-control-kernel.md) §D2 records a known
// kernel boundary debt: the run/task/event *read* repositories still live in
// packages/cli/src/store.ts (plus raw SELECTs in daemon.ts/dashboard.ts/bin.ts),
// NOT in @osstack/core. Therefore an external consumer CANNOT read run/event
// state from the kernel today — proven here by asserting these reader functions
// are absent from @osstack/core's public surface.
//
// >>> MUST FLIP WHEN R1.1 LANDS <<<
// R1.1 relocates the state repositories into
// packages/core/src/state/run-store.ts, adding public getRun / listRecentRuns /
// listEventsForRun exports. When that PR lands, this NEGATIVE test MUST be
// rewritten as a POSITIVE round-trip read test (insert -> finalize -> read via
// core), per the architecture plan §3 (#4) and §4. Do not delete this file to
// make R1.1 green — convert it.

const R1_1_READERS = ["getRun", "listRecentRuns", "listEventsForRun"] as const;

describe("Gap D2 (ADR-001 §D2) — kernel cannot yet read run/event state", () => {
  it("does NOT export the R1.1 state readers from @osstack/core", () => {
    const exportedNames = Object.keys(core);
    for (const reader of R1_1_READERS) {
      expect(exportedNames).not.toContain(reader);
      // Belt-and-suspenders: also assert the value is not callable today.
      expect(typeof (core as Record<string, unknown>)[reader]).toBe("undefined");
    }
  });
});
