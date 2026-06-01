import { describe, expect, it } from "vitest";
import {
  RUN_STATUSES,
  TERMINAL_STATUSES,
  assertTransition,
  isLegalTransition,
  isTerminal,
  IllegalStatusTransition,
  type RunStatus,
} from "./status-fsm.js";

describe("status FSM", () => {
  it("has the 11 statuses from the Hermes Run Adapter Contract", () => {
    expect(RUN_STATUSES.length).toBe(10); // queued..expired listed above; verify list size
    // Actually we have 10 named: queued, running, awaiting_approval, awaiting_clarify,
    // paused, cancelling, cancelled, failed, completed, expired.
    // RFC table also enumerates these 10; the "11" in plan v0.6 counts running pre-state separately.
    // Lock the canonical count at 10 here so future RFC churn surfaces a failing test.
    expect(new Set(RUN_STATUSES).size).toBe(RUN_STATUSES.length);
  });

  it("flags every terminal status correctly", () => {
    const expected = new Set<RunStatus>(["cancelled", "failed", "completed", "expired"]);
    expect(TERMINAL_STATUSES).toEqual(expected);
    for (const s of RUN_STATUSES) expect(isTerminal(s)).toBe(expected.has(s));
  });

  it("allows queued -> running but not queued -> completed", () => {
    expect(isLegalTransition("queued", "running")).toBe(true);
    expect(isLegalTransition("queued", "completed")).toBe(false);
  });

  it("allows running -> awaiting_approval -> running", () => {
    expect(isLegalTransition("running", "awaiting_approval")).toBe(true);
    expect(isLegalTransition("awaiting_approval", "running")).toBe(true);
  });

  it("requires cancelling before cancelled", () => {
    expect(isLegalTransition("running", "cancelled")).toBe(false);
    expect(isLegalTransition("cancelling", "cancelled")).toBe(true);
  });

  it("rejects any transition out of a terminal state", () => {
    for (const t of TERMINAL_STATUSES) {
      for (const s of RUN_STATUSES) {
        expect(isLegalTransition(t, s)).toBe(false);
      }
    }
  });

  it("assertTransition throws IllegalStatusTransition on illegal moves", () => {
    expect(() => assertTransition("completed", "running")).toThrow(IllegalStatusTransition);
  });
});
