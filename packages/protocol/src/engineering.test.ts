import { describe, expect, it } from "vitest";
import {
  EngineeringAdoptRequest, EngineeringObserveRequest, EngineeringDecideRequest,
  EngineeringDeferRequest, EngineeringCancelRequest, EngineeringEndObservationRequest,
  EngineeringReconcileRequest, EngineeringRpcRequests,
} from "./engineering.js";

const ref = {
  kind: "session_decision", scope_id: "scope", item_id: "item", item_revision: 2,
  session_id: "session", turn_id: "turn", decision_id: "decision", source_version: 3,
  content_hash: "a".repeat(64),
};
const decide = {
  mission_id: "mission", wait_id: "wait", if_revision: 4, decision_ref: ref,
  action_id: "action", answer: { kind: "choice", choice_id: "keep" }, interaction_token: "t".repeat(32),
};

describe("engineering adoption protocol", () => {
  it("only adopts an existing precise session at observed_turn level", () => {
    const value = { scope_id: "scope", task_id: "task", run_id: "run", session_id: "session", goal: "Observe this reply.", request_id: "request" };
    expect(EngineeringAdoptRequest.parse(value).completion_level).toBe("observed_turn");
    expect(EngineeringAdoptRequest.safeParse({ ...value, completion_level: "code_delivered" }).success).toBe(false);
    expect(EngineeringAdoptRequest.safeParse({ ...value, actor: "human" }).success).toBe(false);
    expect(EngineeringAdoptRequest.safeParse({ ...value, session_id: "" }).success).toBe(false);
  });
  it("keeps mission, item and session versions independent", () => {
    expect(EngineeringDecideRequest.parse(decide)).toEqual(decide);
    for (const key of ["item_revision", "source_version"] as const) {
      expect(EngineeringDecideRequest.safeParse({ ...decide, decision_ref: { ...ref, [key]: 0 } }).success).toBe(false);
    }
    expect(EngineeringDecideRequest.safeParse({ ...decide, if_revision: 0 }).success).toBe(false);
    expect(EngineeringDecideRequest.safeParse({ ...decide, decision_ref: { ...ref, content_hash: "wrong" } }).success).toBe(false);
  });
  it("does not accept authorization claims or ambiguous answer unions", () => {
    for (const answer of [
      { kind: "approval_token_ref", token: "grant" },
      { kind: "choice", choice_id: "keep", text: "continue" },
      { kind: "text", text: " " },
      { kind: "text", text: "x".repeat(16001) },
    ]) expect(EngineeringDecideRequest.safeParse({ ...decide, answer }).success).toBe(false);
    expect(EngineeringDecideRequest.parse({ ...decide, answer: { kind: "text", text: "  preserve raw input  " } }).answer).toEqual({ kind: "text", text: "  preserve raw input  " });
  });
  it("requires exact UTC deferral and immutable wait revision", () => {
    const value = { mission_id: "mission", wait_id: "wait", if_revision: 1, wait_revision: 2, request_id: "request", revisit_at: "2026-10-26T12:00:00.000Z", reason: "Need input." };
    expect(EngineeringDeferRequest.safeParse(value).success).toBe(true);
    expect(EngineeringDeferRequest.safeParse({ ...value, revisit_at: "2026-10-26T12:00:00+01:00" }).success).toBe(false);
    expect(EngineeringDeferRequest.safeParse({ ...value, wait_revision: undefined }).success).toBe(false);
  });
  it("bounds observation pagination and IDs", () => {
    expect(EngineeringObserveRequest.safeParse({ mission_id: "mission", cursor: 0, limit: 100 }).success).toBe(true);
    for (const limit of [0, 101, 1.5, Infinity]) expect(EngineeringObserveRequest.safeParse({ mission_id: "mission", limit }).success).toBe(false);
    expect(EngineeringObserveRequest.safeParse({ mission_id: "mission", cursor: -1 }).success).toBe(false);
    expect(EngineeringObserveRequest.safeParse({ mission_id: "x".repeat(513) }).success).toBe(false);
    expect(EngineeringObserveRequest.safeParse({ mission_id: "mis\0sion" }).success).toBe(false);
  });
  it("cancels and ends observation using CAS without granting actor authority", () => {
    for (const schema of [EngineeringCancelRequest, EngineeringEndObservationRequest]) {
      expect(schema.safeParse({ mission_id: "mission", if_revision: 1, request_id: "cancel" }).success).toBe(true);
      expect(schema.safeParse({ mission_id: "mission", if_revision: 1, request_id: "cancel", actor: "operator" }).success).toBe(false);
    }
  });
  it("separates receipt lookup from explicit observation disposal", () => {
    expect(EngineeringReconcileRequest.safeParse({ kind: "query_action", mission_id: "mission", action_id: "action" }).success).toBe(true);
    const value = { kind: "dispose_wait", mission_id: "mission", wait_id: "wait", if_revision: 1, wait_revision: 2, request_id: "request", observed_source_version: 3, observed_turn_id: "turn", observed_snapshot_digest: "b".repeat(64), disposition: "human_answered_out_of_band", reason: "Handled outside this observation." };
    expect(EngineeringReconcileRequest.safeParse(value).success).toBe(true);
    expect(EngineeringReconcileRequest.safeParse({ ...value, observed_snapshot_digest: undefined }).success).toBe(false);
    expect(EngineeringReconcileRequest.safeParse({ ...value, disposition: "applied" }).success).toBe(false);
    expect(EngineeringReconcileRequest.safeParse({ kind: "query_action", mission_id: "mission", action_id: "action", reason: "drop" }).success).toBe(false);
  });
  it("authenticates only a bounded bearer credential at the RPC boundary", () => {
    expect(Object.keys(EngineeringRpcRequests)).toHaveLength(7);
    const schema = EngineeringRpcRequests["engineering.decide"];
    expect(schema.safeParse({ ...decide, credential: "s".repeat(32) }).success).toBe(true);
    expect(schema.safeParse(decide).success).toBe(false);
    expect(schema.safeParse({ ...decide, credential: "short" }).success).toBe(false);
    expect(schema.safeParse({ ...decide, credential: "s".repeat(32), principal_id: "admin" }).success).toBe(false);
  });
});
