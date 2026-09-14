import { describe, expect, it } from "vitest";
import { GraphError, GraphScope, WorkerActionResponse, parseInboundGraphRequest, parseInboundWorkerActionRequest, validateGraphMutation, validateWorkerActionResponse } from "./graph.js";
const scope = { schemaVersion: 1 as const, tenantId: "tenant", principalId: "owner", workspaceId: "workspace" };
const specHash = "a".repeat(64);
const worker = { schemaVersion: 1, kind: "worker_action", requestId: "request", scope, graphRunId: "run", generation: 1, specHash, epoch: 0, nodeId: "implement", effectSlot: "invoke", action: { kind: "implement", inputArtifactRef: "input", workspaceLeaseRef: "lease" } };
const resolve = () => ({ schemaVersion: 1 as const, scope, worker: { graphRunId: "run", generation: 1, specHash, epoch: 0 } });
const control = () => ({ schemaVersion: 1 as const, scope });
const resume = { schemaVersion: 1, kind: "resume", scope, graphRunId: "run", expectedRevision: 4, interruptId: "interrupt", idempotencyKey: "key", input: { kind: "data", value: null } };
const effect = { schemaVersion: 1, scope, graphRunId: "run", specHash, epoch: 0, nodeId: "implement", effectSlot: "invoke", logicalAttempt: 1 };
const result = { schemaVersion: 1, kind: "implementation_complete", workspaceLeaseRef: "lease", receiptRef: "receipt" };
const response = { schemaVersion: 1, kind: "worker_action_response", requestId: "request", generation: 1, effect, outcome: { state: "confirmed", result } };
const unknownError = { schemaVersion: 1, code: "ACTION_OUTCOME_UNKNOWN", message: "Unknown", retryable: false, nextAction: "reconcile" };

describe("adversarial graph boundary regressions", () => {
  it.each(["ACTION_OUTCOME_UNKNOWN", "CANCEL_UNCONFIRMED"])("never labels unresolved %s as a definite failure", (code) => {
    expect(WorkerActionResponse.safeParse({ ...response, outcome: { state: "failed", error: { ...unknownError, code } } }).success).toBe(false);
  });
  it("rejects DEL and C1 controls in identities at every position", () => {
    for (const character of ["\u007f", "\u0085", "\u009b", "\u009f"]) {
      for (const tenantId of [`${character}a`, `a${character}b`, `a${character}`]) {
        expect(GraphScope.safeParse({ ...scope, tenantId }).success).toBe(false);
      }
    }
  });
  it("denies worker identities every control-plane mutation even within their run", () => {
    expect(() => parseInboundGraphRequest(resume, resolve)).toThrow(/UNAUTHENTICATED/);
    expect(parseInboundGraphRequest(resume, control)).toEqual(resume);
  });
  it("checks trusted spec and epoch independently of wire claims", () => {
    expect(parseInboundWorkerActionRequest(worker, resolve)).toEqual(worker);
    expect(() => parseInboundWorkerActionRequest({ ...worker, specHash: "b".repeat(64) }, resolve)).toThrow(/SPEC_MISMATCH/);
    expect(() => parseInboundWorkerActionRequest({ ...worker, epoch: 1 }, resolve)).toThrow(/EPOCH_MISMATCH/);
  });
  it.each([
    { ...unknownError, nextAction: "retry" },
    { ...unknownError, code: "INTERNAL_ERROR", retryable: true, nextAction: "stop" },
    { ...unknownError, code: "CANCEL_UNCONFIRMED", nextAction: "fix_input" },
  ])("rejects contradictory standalone error instructions %#", (error) => {
    expect(GraphError.safeParse(error).success).toBe(false);
  });
  it("binds response error location to its effect", () => {
    const uncertain = { ...response, outcome: { state: "unknown", error: { ...unknownError, nodeId: "other", epoch: 1 }, reconciliationRef: "reconcile" } };
    expect(WorkerActionResponse.safeParse(uncertain).success).toBe(false);
    expect(WorkerActionResponse.safeParse({ ...uncertain, outcome: { ...uncertain.outcome, error: { ...unknownError, code: "POLICY_DENIED", nextAction: "stop" } } }).success).toBe(false);
  });
  it("binds revision decisions to the scoped run snapshot", () => {
    const run = { scope, graphRunId: "run", currentRevision: 4 };
    expect(validateGraphMutation(resume, { run })).toBe("apply");
    expect(() => validateGraphMutation(resume, { run: { ...run, graphRunId: "other" } })).toThrow(/RUN_MISMATCH/);
    expect(() => validateGraphMutation(resume, { run: { ...run, scope: { ...scope, workspaceId: "other" } } })).toThrow(/SCOPE_MISMATCH/);
    expect(() => validateGraphMutation(resume, { currentRevision: 4 })).toThrow();
  });
  it("pairs identity and confirmed result kind against the actual request", () => {
    expect(validateWorkerActionResponse(worker, response)).toEqual(response);
    for (const change of [{ requestId: "other" }, { generation: 2 }, { effect: { ...effect, effectSlot: "other" } }, { effect: { ...effect, epoch: 1 } }, { effect: { ...effect, scope: { ...scope, tenantId: "other" } } }, { outcome: { state: "confirmed", result: { schemaVersion: 1, kind: "workspace", workspaceLeaseRef: "lease", receiptRef: "receipt" } } }]) {
      expect(() => validateWorkerActionResponse(worker, { ...response, ...change })).toThrow();
    }
  });
  it("returns stable boundary errors for malformed request data", () => {
    expect(() => parseInboundGraphRequest({ ...resume, extra: 1 }, control)).toThrow(/INPUT_CONTRACT_INVALID/);
    expect(() => parseInboundWorkerActionRequest({ ...worker, action: { kind: "exec", command: "echo x" } }, resolve)).toThrow(/INPUT_CONTRACT_INVALID/);
  });
});
