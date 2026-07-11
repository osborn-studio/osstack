import * as protocol from "@osstack/protocol";
import { describe, expect, it } from "vitest";
import { protocol as coreProtocol } from "../index.js";
import type { StoredEventRow } from "./run-store.js";
import {
  type ApprovalRequestRow,
  type RunSummaryRow,
  approvalRowToRequest,
  runRowToRunSummary,
  storedEventToEnvelope,
} from "./protocol-mappers.js";

// A valid stored events row (terminal stored 0/1, payload serialized).
function eventRow(overrides: Partial<StoredEventRow> = {}): StoredEventRow {
  return {
    event_id: "run_1:0",
    run_id: "run_1",
    session_id: "sess_1",
    seq: 0,
    type: "token.delta",
    created_at: 1_700_000_000,
    terminal: 0,
    payload_json: JSON.stringify({ text: "hi" }),
    ...overrides,
  };
}

function runRow(overrides: Partial<RunSummaryRow> = {}): RunSummaryRow {
  return {
    run_id: "run_1",
    task_id: "task_1",
    agent_id: "claude-code",
    outcome: "completed",
    started_at: 1_700_000_000,
    completed_at: 1_700_000_012,
    duration_ms: 12_000,
    ...overrides,
  };
}

function approvalRow(overrides: Partial<ApprovalRequestRow> = {}): ApprovalRequestRow {
  return {
    approval_id: "appr_1",
    run_id: "run_1",
    action_summary: "delete the staging bucket",
    risk: "high",
    requested_at: 1_700_000_000,
    ...overrides,
  };
}

describe("namespaced protocol re-export", () => {
  it("exposes PROTOCOL_VERSION via `import { protocol } from @osstack/core`", () => {
    expect(coreProtocol.PROTOCOL_VERSION).toBe("1.0");
  });
});

describe("storedEventToEnvelope", () => {
  it("maps a valid row and passes the strict EventEnvelope schema", () => {
    const env = storedEventToEnvelope(eventRow());
    expect(() => protocol.EventEnvelope.parse(env)).not.toThrow();
    expect(env).toEqual({
      event_id: "run_1:0",
      seq: 0,
      run_id: "run_1",
      session_id: "sess_1",
      created_at: 1_700_000_000,
      terminal: false,
      type: "token.delta",
      payload: { text: "hi" },
    });
  });

  it("maps terminal 1 -> true and 0 -> false", () => {
    expect(storedEventToEnvelope(eventRow({ terminal: 1 })).terminal).toBe(true);
    expect(storedEventToEnvelope(eventRow({ terminal: 0 })).terminal).toBe(false);
  });

  it("parses an empty-object payload", () => {
    const env = storedEventToEnvelope(eventRow({ payload_json: "{}" }));
    expect(env.payload).toEqual({});
    expect(() => protocol.EventEnvelope.parse(env)).not.toThrow();
  });

  it("ESCALATES (throws) on unparseable payload_json", () => {
    expect(() => storedEventToEnvelope(eventRow({ payload_json: "{not json" }))).toThrow(
      /not valid JSON/,
    );
  });

  it("ESCALATES (throws) on payload_json that is valid JSON but not an object", () => {
    expect(() => storedEventToEnvelope(eventRow({ payload_json: "[1,2,3]" }))).toThrow(/array/);
    expect(() => storedEventToEnvelope(eventRow({ payload_json: '"scalar"' }))).toThrow(/string/);
    expect(() => storedEventToEnvelope(eventRow({ payload_json: "null" }))).toThrow(/null/);
  });
});

describe("runRowToRunSummary", () => {
  it("maps a finalized row and passes the strict RunSummary schema", () => {
    const summary = runRowToRunSummary(runRow());
    expect(summary).toBeDefined();
    expect(() => protocol.RunSummary.parse(summary)).not.toThrow();
    expect(summary).toEqual({
      run_id: "run_1",
      task_id: "task_1",
      agent_id: "claude-code",
      outcome: "completed",
      started_at: "2023-11-14T22:13:20.000Z",
      completed_at: "2023-11-14T22:13:32.000Z",
      duration_ms: 12_000,
    });
  });

  it("converts epoch seconds to ISO datetime correctly", () => {
    const summary = runRowToRunSummary(runRow({ started_at: 0, completed_at: 0 }));
    expect(summary?.started_at).toBe("1970-01-01T00:00:00.000Z");
  });

  it("returns undefined for a non-finalized (NULL outcome) row", () => {
    expect(runRowToRunSummary(runRow({ outcome: null }))).toBeUndefined();
  });

  it("maps expired -> failed (codebase treats expired as a failure)", () => {
    const summary = runRowToRunSummary(runRow({ outcome: "expired" }));
    expect(summary?.outcome).toBe("failed");
    expect(() => protocol.RunSummary.parse(summary)).not.toThrow();
  });

  it("passes through failed and cancelled outcomes unchanged", () => {
    expect(runRowToRunSummary(runRow({ outcome: "failed" }))?.outcome).toBe("failed");
    expect(runRowToRunSummary(runRow({ outcome: "cancelled" }))?.outcome).toBe("cancelled");
  });

  it("omits completed_at and duration_ms when null (still strict-valid)", () => {
    const summary = runRowToRunSummary(runRow({ completed_at: null, duration_ms: null }));
    expect(summary).toBeDefined();
    expect(summary).not.toHaveProperty("completed_at");
    expect(summary).not.toHaveProperty("duration_ms");
    expect(() => protocol.RunSummary.parse(summary)).not.toThrow();
  });

  it("rounds float duration and clamps negative duration to 0", () => {
    expect(runRowToRunSummary(runRow({ duration_ms: 12_000.4 }))?.duration_ms).toBe(12_000);
    expect(runRowToRunSummary(runRow({ duration_ms: -5 }))?.duration_ms).toBe(0);
  });
});

describe("approvalRowToRequest", () => {
  it("maps a row and passes the strict ApprovalRequest schema", () => {
    const req = approvalRowToRequest(approvalRow());
    expect(() => protocol.ApprovalRequest.parse(req)).not.toThrow();
    expect(req).toEqual({
      approval_id: "appr_1",
      run_id: "run_1",
      action: "delete the staging bucket",
      risk: "high",
      requested_at: "2023-11-14T22:13:20.000Z",
    });
  });

  it("passes each risk band through", () => {
    for (const risk of ["low", "medium", "high"] as const) {
      const req = approvalRowToRequest(approvalRow({ risk }));
      expect(req.risk).toBe(risk);
      expect(() => protocol.ApprovalRequest.parse(req)).not.toThrow();
    }
  });
});
