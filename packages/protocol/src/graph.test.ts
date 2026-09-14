import { describe, expect, it } from "vitest";
import {
  GraphSpec, GraphScope, GraphBudget, GraphError, GraphRunState, GraphNodeState,
  GraphActionState, GraphResult, WorkerActionRequest, WorkerActionResponse,
  StartGraphRequest, ResumeGraphRequest, GraphJsonValue, GraphEffectIdentity,
  computeGraphInputDigest, computeGraphEffectKey, parseInboundWorkerActionRequest,
  parseInboundGraphRequest, validateGraphMutation, validateWorkerTransportRetry,
} from "./graph.js";

const scope = { schemaVersion: 1 as const, tenantId: "local", principalId: "owner", workspaceId: "workspace" };
const limits = {
  maxEpochs: 3, maxBranchAttempts: 2, maxConcurrentReaders: 2,
  maxConcurrentWritersPerRepo: 1, maxActionStarts: 64, deadlineSeconds: 3600,
  tokenReservationLimit: 100000,
};
const spec = {
  schemaVersion: 1, template: "code-delivery-v1",
  input: { taskRef: "task", repositoryRef: "repo", baseRevision: "a".repeat(40), acceptanceRef: "acceptance" },
  limits, publication: "artifact_only",
};
const start = {
  schemaVersion: 1, kind: "start", scope, spec, inputArtifactRef: "input", idempotencyKey: "submit-1",
  source: { product: "osstack", requestId: "source-1" },
};
const resume = {
  schemaVersion: 1, kind: "resume", scope, graphRunId: "run", expectedRevision: 4,
  interruptId: "interrupt", idempotencyKey: "resume-1",
  input: { kind: "data", value: { time: 123, trace: { id: "business" }, values: [1, 2] } },
};
const effect = {
  schemaVersion: 1, scope, graphRunId: "run", specHash: "b".repeat(64), epoch: 0,
  nodeId: "implement", logicalAttempt: 1, effectSlot: "invocation",
};
const worker = {
  schemaVersion: 1, kind: "worker_action", requestId: "transport-1", scope,
  graphRunId: "run", generation: 1, specHash: "b".repeat(64), epoch: 0,
  nodeId: "implement", effectSlot: "invocation",
  action: { kind: "implement", inputArtifactRef: "input", workspaceLeaseRef: "lease" },
};
// This callback stands in for trusted daemon connection/lease resolution, not wire data.
const authenticated = () => ({ schemaVersion: 1 as const, scope, worker: { graphRunId: "run", generation: 1, specHash: "b".repeat(64), epoch: 0 } });
const digest = (value: unknown) => computeGraphInputDigest(value);

describe("graph v1 contracts", () => {
  it("accepts the architecture's fixed artifact-only spec and versioned requests", () => {
    expect(GraphSpec.parse(spec)).toEqual(spec);
    expect(StartGraphRequest.parse(start)).toEqual(start);
    expect(ResumeGraphRequest.parse(resume)).toEqual(resume);
    expect(WorkerActionRequest.parse(worker)).toEqual(worker);
    expect(GraphScope.parse(scope)).toEqual(scope);
  });

  it.each([
    { ...spec, schemaVersion: 2 }, { ...spec, template: "eval(js)" },
    { ...spec, publication: "merge" }, { ...spec, nodes: [] },
    { ...spec, input: { ...spec.input, script: "process.exit()" } },
    { ...spec, limits: { ...limits, extra: 1 } },
    { ...spec, input: { ...spec.input, taskRef: " " } },
  ])("rejects unsupported or unknown spec fields %#", (value) => {
    expect(GraphSpec.safeParse(value).success).toBe(false);
  });

  it.each([
    ["maxEpochs", 4], ["maxEpochs", 0], ["maxBranchAttempts", 0],
    ["maxBranchAttempts", 1.5], ["maxConcurrentReaders", Infinity],
    ["maxConcurrentWritersPerRepo", 2], ["maxActionStarts", Number.MAX_SAFE_INTEGER + 1],
    ["deadlineSeconds", NaN], ["deadlineSeconds", -1], ["tokenReservationLimit", Infinity],
  ])("bounds budget %s=%s", (key, value) => {
    expect(GraphBudget.safeParse({ schemaVersion: 1, ...limits, [key]: value }).success).toBe(false);
  });

  it.each([
    { ...worker, authenticated: true }, { ...worker, logicalAttempt: 2 },
    { ...worker, checkpoint: { grant: true } }, { ...worker, generation: -1 },
    { ...worker, scope: { ...scope, authenticated: true } },
    { ...worker, action: { ...worker.action, command: "rm -rf /" } },
    { ...worker, metadata: { trace: { traceId: "x", principalId: "owner" } } },
    { ...worker, metadata: { requestedAt: "today" } },
  ])("rejects hostile worker envelope %#", (value) => {
    expect(WorkerActionRequest.safeParse(value).success).toBe(false);
  });

  it("distinguishes implementation completion, candidate freeze and code verdict", () => {
    expect(GraphResult.parse({ schemaVersion: 1, kind: "implementation_complete", workspaceLeaseRef: "lease", receiptRef: "receipt" }).kind).toBe("implementation_complete");
    expect(GraphResult.safeParse({ schemaVersion: 1, kind: "candidate_ready", workspaceLeaseRef: "lease" }).success).toBe(false);
    const report = { schemaVersion: 1, kind: "tests", candidateRevision: "a".repeat(40), passed: false, evidenceRefs: ["report"], evidenceDigest: "b".repeat(64) };
    expect(GraphResult.parse(report)).toEqual(report);
    const response = { schemaVersion: 1, kind: "worker_action_response", requestId: "transport-1", generation: 1, effect, outcome: { state: "confirmed", result: report } };
    expect(WorkerActionResponse.parse(response)).toEqual(response);
    expect(WorkerActionResponse.safeParse({ ...response, outcome: { state: "unknown", result: report } }).success).toBe(false);
    expect(WorkerActionResponse.safeParse({ ...response, effect: { ...effect, generation: 1 } }).success).toBe(false);
    expect(GraphResult.safeParse({ ...report, grant: true }).success).toBe(false);
  });

  it("has explicit states and structured non-retryable unknown outcomes", () => {
    expect(GraphRunState.parse("reconciliation_required")).toBe("reconciliation_required");
    expect(GraphNodeState.parse("skipped")).toBe("skipped");
    expect(GraphActionState.parse("unknown")).toBe("unknown");
    const error = { schemaVersion: 1, code: "ACTION_OUTCOME_UNKNOWN", message: "Reconcile execution", retryable: false, nextAction: "reconcile", nodeId: "implement", epoch: 0, actionId: "action" };
    expect(GraphError.parse(error)).toEqual(error);
    expect(GraphError.safeParse({ ...error, retryable: true }).success).toBe(false);
    expect(GraphError.safeParse({ ...error, extra: 1 }).success).toBe(false);
    expect(GraphError.safeParse({ ...error, nextAction: "retry" }).success).toBe(false);
  });

  it("can reject an unauthenticated action without inventing a ledger effect", () => {
    const response = {
      schemaVersion: 1, kind: "worker_action_rejected", requestId: "transport-1",
      error: { schemaVersion: 1, code: "UNAUTHENTICATED", message: "No verified connection", retryable: false, nextAction: "reauthorize" },
    };
    expect(WorkerActionResponse.parse(response)).toEqual(response);
    expect(WorkerActionResponse.safeParse({ ...response, effect }).success).toBe(false);
  });

  it("does not present an uncertain response as automatically retryable", () => {
    const response = {
      schemaVersion: 1, kind: "worker_action_response", requestId: "transport-1", generation: 1, effect,
      outcome: { state: "unknown", reconciliationRef: "reconcile", error: { schemaVersion: 1, code: "INTERNAL_ERROR", message: "Lost process", retryable: true, nextAction: "retry" } },
    };
    expect(WorkerActionResponse.safeParse(response).success).toBe(false);
  });
});

describe("bounded JSON-only values", () => {
  it.each([undefined, NaN, Infinity, 1n, Symbol("x"), () => 1, new Date(), new Map(), /x/, new Uint8Array(1), new (class SDK { value = 1; })(), { x: undefined }, [undefined], new Array(2), { x: "x".repeat(65537) }])("rejects non-wire value %#", (value) => {
    expect(GraphJsonValue.safeParse(value).success).toBe(false);
    expect(ResumeGraphRequest.safeParse({ ...resume, input: { kind: "data", value } }).success).toBe(false);
  });

  it("rejects cycles, depth, count and byte overflow before recursive parsing", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let deep: unknown = null;
    for (let i = 0; i < 40; i++) deep = { child: deep };
    for (const value of [cycle, deep, Array(5000).fill(0), Array(20).fill("界".repeat(2000))]) {
      expect(GraphJsonValue.safeParse(value).success).toBe(false);
    }
  });

  it("rejects getters and hidden/symbol/pollution properties without invoking getters", () => {
    let invoked = false;
    const accessor = Object.defineProperty({}, "x", { enumerable: true, get() { invoked = true; return 1; } });
    for (const value of [accessor, Object.defineProperty({}, "x", { value: 1 }), { [Symbol("x")]: 1 }, JSON.parse('{"__proto__":{"x":1}}')]) {
      expect(GraphJsonValue.safeParse(value).success).toBe(false);
    }
    expect(invoked).toBe(false);
    expect(GraphSpec.safeParse(Object.assign(Object.create({}), spec)).success).toBe(false);
    expect(GraphJsonValue.parse({ nested: [null, true, 1.5, "text"] })).toEqual({ nested: [null, true, 1.5, "text"] });
  });
});

describe("authenticated transport boundary", () => {
  it("requires trusted resolver code, never an authenticated flag in data", () => {
    for (const resolver of [undefined, null, { authenticated: true, ...authenticated() }, () => null, () => ({ ...authenticated(), authenticated: true })]) {
      expect(() => parseInboundWorkerActionRequest(worker, resolver as never)).toThrow(/UNAUTHENTICATED/);
    }
    expect(parseInboundWorkerActionRequest(worker, authenticated)).toEqual(worker);
    expect(parseInboundGraphRequest(start, () => ({ schemaVersion: 1, scope }))).toEqual(start);
  });

  it.each(["tenantId", "workspaceId", "principalId"])("rejects mismatched %s", (key) => {
    expect(() => parseInboundWorkerActionRequest({ ...worker, scope: { ...scope, [key]: "other" } }, authenticated)).toThrow(/SCOPE_MISMATCH/);
    expect(() => parseInboundGraphRequest({ ...start, scope: { ...scope, [key]: "other" } }, () => ({ schemaVersion: 1, scope }))).toThrow(/SCOPE_MISMATCH/);
  });

  it("rejects run/generation mismatch and missing worker binding", () => {
    expect(() => parseInboundWorkerActionRequest({ ...worker, graphRunId: "other" }, authenticated)).toThrow(/RUN_MISMATCH/);
    expect(() => parseInboundWorkerActionRequest({ ...worker, generation: 2 }, authenticated)).toThrow(/STALE_GENERATION/);
    expect(() => parseInboundWorkerActionRequest(worker, () => ({ schemaVersion: 1, scope }))).toThrow(/UNAUTHENTICATED/);
    expect(() => parseInboundGraphRequest({ ...resume, graphRunId: "other" }, authenticated)).toThrow(/UNAUTHENTICATED/);
  });
});

describe("canonical identity and pure mutation decisions", () => {
  it("sorts object keys, keeps arrays and nested business time/trace significant", () => {
    expect(digest(resume)).toBe("a48ef5b6ecf2a2eedbc8d29831fed5750e2172adff2ed2d7ba2f07ad37509231");
    const reversed = { ...resume, input: { value: { values: [1, 2], trace: { id: "business" }, time: 123 }, kind: "data" } };
    expect(digest(resume)).toBe(digest(reversed));
    for (const value of [{ values: [2, 1], trace: { id: "business" }, time: 123 }, { values: [1, 2], trace: { id: "other" }, time: 123 }, { values: [1, 2], trace: { id: "business" }, time: 124 }]) {
      expect(digest({ ...resume, input: { kind: "data", value } })).not.toBe(digest(resume));
    }
  });

  it("excludes only declared envelope metadata and idempotency routing key", () => {
    expect(digest({ ...start, metadata: { trace: { traceId: "trace", spanId: "span" }, requestedAt: "2026-09-13T12:00:00Z" } })).toBe(digest(start));
    expect(digest({ ...start, idempotencyKey: "retry-key" })).toBe(digest(start));
    for (const value of [{ ...start, time: 1 }, { ...start, metadata: { business: 1 } }, { ...start, spec: { ...spec, trace: "business" } }, { ...start, source: { ...start.source, extra: 1 } }]) {
      expect(() => digest(value)).toThrow();
    }
    expect(digest({ ...start, inputArtifactRef: "changed" })).not.toBe(digest(start));
    expect(digest({ ...start, scope: { ...scope, tenantId: "other" } })).not.toBe(digest(start));
    expect(digest({ ...start, source: { ...start.source, requestId: "other" } })).not.toBe(digest(start));
  });

  it("binds effects to scope/run/spec/epoch/node/ledger attempt/slot, never generation", () => {
    expect(computeGraphEffectKey(effect)).toMatch(/^[a-f0-9]{64}$/);
    for (const changes of [{ scope: { ...scope, workspaceId: "other" } }, { graphRunId: "other" }, { specHash: "c".repeat(64) }, { epoch: 1 }, { nodeId: "repair" }, { logicalAttempt: 2 }, { effectSlot: "other" }]) {
      expect(computeGraphEffectKey({ ...effect, ...changes })).not.toBe(computeGraphEffectKey(effect));
    }
    expect(GraphEffectIdentity.safeParse({ ...effect, generation: 2 }).success).toBe(false);
    expect(() => computeGraphEffectKey({ ...effect, logicalAttempt: 0 })).toThrow();
  });

  it("replays the same key/input before revision CAS but conflicts on changed business input", () => {
    const prior = { schemaVersion: 1, scope, idempotencyKey: resume.idempotencyKey, inputDigest: digest(resume) };
    expect(validateGraphMutation(resume, { run: { scope, graphRunId: "run", currentRevision: 4 } })).toBe("apply");
    expect(validateGraphMutation(resume, { run: { scope, graphRunId: "run", currentRevision: 5 }, prior })).toBe("replay");
    expect(() => validateGraphMutation({ ...resume, input: { kind: "data", value: 2 } }, { run: { scope, graphRunId: "run", currentRevision: 5 }, prior })).toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(() => validateGraphMutation(resume, { run: { scope, graphRunId: "run", currentRevision: 5 } })).toThrow(/REVISION_CONFLICT/);
    expect(() => validateGraphMutation(resume, { run: { scope, graphRunId: "run", currentRevision: -1 } })).toThrow();
    expect(() => validateGraphMutation(resume, {})).toThrow(/REVISION_CONFLICT/);
    expect(() => validateGraphMutation(resume, { run: { scope, graphRunId: "run", currentRevision: 4 }, prior: { ...prior, scope: { ...scope, tenantId: "other" } } })).toThrow(/SCOPE_MISMATCH/);
    expect(() => validateGraphMutation({ ...resume, expectedRevision: 5 }, { run: { scope, graphRunId: "run", currentRevision: 5 }, prior })).toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(validateGraphMutation(start, {})).toBe("apply");
  });

  it("keeps worker transport retries identical except declared metadata", () => {
    expect(validateWorkerTransportRetry(worker, { ...worker, metadata: { trace: { traceId: "new" } } })).toBe("replay");
    for (const changes of [{ requestId: "new" }, { generation: 2 }, { action: { ...worker.action, inputArtifactRef: "other" } }]) {
      expect(() => validateWorkerTransportRetry(worker, { ...worker, ...changes })).toThrow(/IDEMPOTENCY_CONFLICT/);
    }
  });

  it("bounds fresh cancel revisions and never treats resume data as identity", () => {
    const cancel = { schemaVersion: 1, kind: "cancel", scope, graphRunId: "run", expectedRevision: 4, idempotencyKey: "cancel-1" };
    expect(validateGraphMutation(cancel, { run: { scope, graphRunId: "run", currentRevision: 4 } })).toBe("apply");
    expect(() => validateGraphMutation(cancel, { run: { scope, graphRunId: "run", currentRevision: 5 } })).toThrow(/REVISION_CONFLICT/);
    for (const expectedRevision of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateGraphMutation({ ...cancel, expectedRevision }, { run: { scope, graphRunId: "run", currentRevision: 4 } })).toThrow();
    }
    const claim = { ...resume, input: { kind: "data", value: { authenticated: true, grant: "approved" } } };
    expect(() => parseInboundGraphRequest(claim, () => null)).toThrow(/UNAUTHENTICATED/);
    expect(ResumeGraphRequest.safeParse({ ...resume, input: true }).success).toBe(false);
  });
});
