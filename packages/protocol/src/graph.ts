import { createHash } from "node:crypto";
import { z } from "zod";

/** Decoded JSON limits; transport MUST also cap raw bytes before JSON.parse. */
export const GRAPH_JSON_LIMITS = Object.freeze({ maxBytes: 65_536, maxDepth: 16, maxValues: 4_096, maxStringLength: 16_384 });

function isBoundedJson(value: unknown): boolean {
  let values = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): boolean {
    if (++values > GRAPH_JSON_LIMITS.maxValues || depth > GRAPH_JSON_LIMITS.maxDepth) return false;
    if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
      bytes += Buffer.byteLength(JSON.stringify(item));
    } else if (typeof item === "string") {
      if (item.length > GRAPH_JSON_LIMITS.maxStringLength) return false;
      bytes += Buffer.byteLength(JSON.stringify(item));
    } else if (typeof item === "object") {
      if (ancestors.has(item)) return false;
      const array = Array.isArray(item);
      const proto = Object.getPrototypeOf(item);
      if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return false;
      const keys = Reflect.ownKeys(item);
      if (keys.length > GRAPH_JSON_LIMITS.maxValues) return false;
      if (array && (item.length > GRAPH_JSON_LIMITS.maxValues || keys.length !== item.length + 1)) return false;
      ancestors.add(item);
      bytes += 2;
      let index = 0;
      for (const key of keys) {
        if (array && key === "length") continue;
        if (typeof key !== "string" || key.length > 256 || ["__proto__", "constructor", "prototype"].includes(key)) return false;
        if (array && key !== String(index++)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) return false;
        bytes += (array ? 0 : Buffer.byteLength(JSON.stringify(key)) + 1) + 1;
        if (bytes > GRAPH_JSON_LIMITS.maxBytes || !visit(descriptor.value, depth + 1)) return false;
      }
      ancestors.delete(item);
    } else return false;
    return bytes <= GRAPH_JSON_LIMITS.maxBytes;
  }
  // IPC must supply decoded JSON, never executable objects. Accessors are not read.
  // A hostile in-process Proxy is not a supported transport input.
  try { return visit(value, 0); } catch { return false; }
}

function wire<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value, ctx) => {
    if (!isBoundedJson(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected bounded JSON-only graph data" });
      return z.NEVER;
    }
    return value;
  }, schema);
}

export type GraphJsonValue = null | boolean | number | string | GraphJsonValue[] | { [key: string]: GraphJsonValue };
const JsonValue: z.ZodType<GraphJsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string().max(GRAPH_JSON_LIMITS.maxStringLength),
  z.array(JsonValue).max(GRAPH_JSON_LIMITS.maxValues), z.record(z.string().max(256).regex(/^(?!__proto__$|constructor$|prototype$)/), JsonValue),
]));
export const GraphJsonValue = wire(JsonValue);

const Version = z.literal(1);
// No trimming/coercion: business identities must not silently collapse.
// biome-ignore lint/suspicious/noControlCharactersInRegex: Wire IDs must reject ASCII control characters.
const Id = z.string().min(1).max(256).regex(/^[^\s\u0000-\u001f\u007f-\u009f](?:[^\u0000-\u001f\u007f-\u009f]*[^\s\u0000-\u001f\u007f-\u009f])?$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Epoch = z.number().int().min(0).max(2);
const Refs = z.array(Id).min(1).max(128);
const Scope = z.object({ schemaVersion: Version, tenantId: Id, principalId: Id, workspaceId: Id }).strict();
/** Claimed/recorded identity only; parsing does not authenticate it. */
export const GraphScope = wire(Scope);
export type GraphScope = z.infer<typeof GraphScope>;

const budgetShape = {
  maxEpochs: z.number().int().min(1).max(3),
  maxBranchAttempts: z.number().int().min(1).max(32),
  maxConcurrentReaders: z.number().int().min(1).max(64),
  maxConcurrentWritersPerRepo: z.literal(1),
  maxActionStarts: z.number().int().min(1).max(100_000),
  deadlineSeconds: z.number().int().min(1).max(604_800),
  tokenReservationLimit: z.number().int().min(0).max(1_000_000_000),
};
export const GraphBudget = wire(z.object({ schemaVersion: Version, ...budgetShape }).strict());
export type GraphBudget = z.infer<typeof GraphBudget>;
const Spec = z.object({
  schemaVersion: Version,
  template: z.literal("code-delivery-v1"),
  input: z.object({ taskRef: Id, repositoryRef: Id, baseRevision: Commit, acceptanceRef: Id }).strict(),
  limits: z.object(budgetShape).strict(),
  publication: z.literal("artifact_only"),
}).strict();
/** Declarative template only. Registry/topology/feasibility validation belongs to G18. */
export const GraphSpec = wire(Spec);
export type GraphSpec = z.infer<typeof GraphSpec>;
export const GraphSpecV1 = GraphSpec;
export type GraphSpecV1 = GraphSpec;

export const GraphRunState = z.enum(["queued", "running", "ready", "failed", "cancelled", "waiting_input", "cancel_pending", "reconciliation_required"]);
export type GraphRunState = z.infer<typeof GraphRunState>;
export const GraphNodeState = z.enum(["pending", "running", "succeeded", "failed", "skipped", "cancelled", "waiting_input"]);
export type GraphNodeState = z.infer<typeof GraphNodeState>;
export const GraphActionState = z.enum(["intent", "running", "confirmed", "failed", "unknown", "cancel_pending", "reconciliation_required", "cancelled"]);
export type GraphActionState = z.infer<typeof GraphActionState>;
export const GraphErrorCode = z.enum([
  "SPEC_INVALID", "INPUT_CONTRACT_INVALID", "OUTPUT_CONTRACT_INVALID", "JOIN_REVISION_MISMATCH",
  "POLICY_DENIED", "GRANT_EXPIRED", "BUDGET_EXHAUSTED", "ACTION_OUTCOME_UNKNOWN", "STALE_GENERATION",
  "CANCEL_UNCONFIRMED", "CHECKPOINT_INCOMPATIBLE", "UNAUTHENTICATED", "SCOPE_MISMATCH", "RUN_MISMATCH",
  "IDEMPOTENCY_CONFLICT", "REVISION_CONFLICT", "INTERNAL_ERROR", "SPEC_MISMATCH", "EPOCH_MISMATCH", "RESPONSE_MISMATCH",
  "EXECUTOR_UNSUPPORTED", "GRAPH_ADMISSION_DISABLED",
  "GRAPH_DISTRIBUTION_UNSUPPORTED", "GRAPH_NODE_VERSION_UNSUPPORTED",
]);
export type GraphErrorCode = z.infer<typeof GraphErrorCode>;
const errorShape = {
  schemaVersion: Version, message: z.string().min(1).max(4096),
  nodeId: Id.optional(), epoch: Epoch.optional(), actionId: Id.optional(),
};
// A union preserves these conditional instructions in generated JSON Schema.
const ErrorObject = z.union([
  z.object({ ...errorShape, code: z.enum(["OUTPUT_CONTRACT_INVALID", "INTERNAL_ERROR"]), retryable: z.literal(true), nextAction: z.literal("retry") }).strict(),
  z.object({ ...errorShape, code: z.enum(["ACTION_OUTCOME_UNKNOWN", "CANCEL_UNCONFIRMED"]), retryable: z.literal(false), nextAction: z.literal("reconcile") }).strict(),
  z.object({ ...errorShape, code: GraphErrorCode.exclude(["ACTION_OUTCOME_UNKNOWN", "CANCEL_UNCONFIRMED"]), retryable: z.literal(false), nextAction: z.enum(["fix_input", "reauthorize", "reconcile", "refresh", "stop"]) }).strict(),
]);
export const GraphError = wire(ErrorObject);
export type GraphError = z.infer<typeof GraphError>;

const evidenceShape = { candidateRevision: Commit, evidenceRefs: Refs, evidenceDigest: Digest };
const Result = z.discriminatedUnion("kind", [
  z.object({ schemaVersion: Version, kind: z.literal("implementation_complete"), workspaceLeaseRef: Id, receiptRef: Id }).strict(),
  z.object({ schemaVersion: Version, kind: z.literal("candidate_ready"), candidateRevision: Commit, artifactRefs: Refs, artifactDigest: Digest }).strict(),
  z.object({ schemaVersion: Version, kind: z.literal("review"), ...evidenceShape, verdict: z.enum(["accept", "changes_requested"]) }).strict(),
  z.object({ schemaVersion: Version, kind: z.literal("tests"), ...evidenceShape, passed: z.boolean() }).strict(),
  z.object({ schemaVersion: Version, kind: z.literal("ready"), ...evidenceShape, artifactRefs: Refs, publication: z.literal("artifact_only") }).strict(),
  z.object({ schemaVersion: Version, kind: z.literal("workspace"), workspaceLeaseRef: Id, receiptRef: Id }).strict(),
]);
/** References/digests are claims until the daemon validates stored evidence (G16/G19). */
export const GraphResult = wire(Result);
export type GraphResult = z.infer<typeof GraphResult>;

const Metadata = z.object({
  trace: z.object({ traceId: Id, spanId: Id.optional() }).strict().optional(),
  requestedAt: z.string().datetime({ offset: true }).optional(),
}).strict();
const requestShape = { schemaVersion: Version, scope: Scope, idempotencyKey: Id, metadata: Metadata.optional() };
const Start = z.object({
  ...requestShape, kind: z.literal("start"), spec: Spec, inputArtifactRef: Id,
  source: z.object({ product: z.enum(["osstack", "osbot", "ostag"]), requestId: Id, parentRunId: Id.optional() }).strict(),
}).strict();
const Resume = z.object({
  ...requestShape, kind: z.literal("resume"), graphRunId: Id, expectedRevision: Count, interruptId: Id,
  // Data is never authority, including strings/objects that say "approved".
  input: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("data"), value: JsonValue }).strict(),
    z.object({ kind: z.literal("reconciliation"), outcome: z.enum(["applied", "not_applied", "unknown"]), evidenceRefs: Refs }).strict(),
  ]),
}).strict();
const Cancel = z.object({ ...requestShape, kind: z.literal("cancel"), graphRunId: Id, expectedRevision: Count }).strict();
export const StartGraphRequest = wire(Start);
export type StartGraphRequest = z.infer<typeof StartGraphRequest>;
export const ResumeGraphRequest = wire(Resume);
export type ResumeGraphRequest = z.infer<typeof ResumeGraphRequest>;
export const CancelGraphRequest = wire(Cancel);
export type CancelGraphRequest = z.infer<typeof CancelGraphRequest>;
export const GraphRequest = wire(z.discriminatedUnion("kind", [Start, Resume, Cancel]));
export type GraphRequest = z.infer<typeof GraphRequest>;

const actionIdentityShape = { scope: Scope, graphRunId: Id, specHash: Digest, epoch: Epoch, nodeId: Id, effectSlot: Id };
const Effect = z.object({ schemaVersion: Version, ...actionIdentityShape, logicalAttempt: Count.min(1) }).strict();
/** Ledger-issued identity. Derive spec/epoch/node/slot from trusted run/registry state,
 * and logicalAttempt from ledger; never blindly copy worker claims. Generation is fencing only. */
export const GraphEffectIdentity = wire(Effect);
export type GraphEffectIdentity = z.infer<typeof GraphEffectIdentity>;
const WorkerRequest = z.object({
  schemaVersion: Version, kind: z.literal("worker_action"), requestId: Id, generation: Count.min(1),
  ...actionIdentityShape,
  // Worker asks to register-or-return a slot. It cannot allocate logicalAttempt.
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("implement"), inputArtifactRef: Id, workspaceLeaseRef: Id }).strict(),
    z.object({ kind: z.literal("repair"), inputArtifactRef: Id, workspaceLeaseRef: Id, candidateRevision: Commit, feedbackRef: Id }).strict(),
    z.object({ kind: z.literal("freeze"), workspaceLeaseRef: Id, receiptRef: Id }).strict(),
    z.object({ kind: z.literal("review"), candidateRevision: Commit, acceptanceRef: Id, workspaceLeaseRef: Id }).strict(),
    z.object({ kind: z.literal("tests"), candidateRevision: Commit, commandSpecRef: Id, workspaceLeaseRef: Id }).strict(),
    z.object({ kind: z.literal("workspace_create"), repositoryRef: Id, baseRevision: Commit }).strict(),
    z.object({ kind: z.literal("workspace_release"), workspaceLeaseRef: Id }).strict(),
  ]),
  metadata: Metadata.optional(),
}).strict();
export const WorkerActionRequest = wire(WorkerRequest);
export type WorkerActionRequest = z.infer<typeof WorkerActionRequest>;
const WorkerResponse = z.object({
  schemaVersion: Version, kind: z.literal("worker_action_response"), requestId: Id, generation: Count.min(1), effect: Effect,
  outcome: z.discriminatedUnion("state", [
    z.object({ state: z.literal("confirmed"), result: Result }).strict(),
    z.object({ state: z.literal("intent") }).strict(),
    z.object({ state: z.literal("running"), executionRef: Id }).strict(),
    z.object({ state: z.literal("failed"), error: z.union([ErrorObject.options[0], ErrorObject.options[2]]) }).strict(),
    z.object({ state: z.literal("unknown"), error: ErrorObject, reconciliationRef: Id }).strict(),
    z.object({ state: z.literal("cancel_pending"), error: ErrorObject, executionRef: Id }).strict(),
    z.object({ state: z.literal("reconciliation_required"), error: ErrorObject, reconciliationRef: Id }).strict(),
    z.object({ state: z.literal("cancelled"), receiptRef: Id }).strict(),
  ]),
  metadata: Metadata.optional(),
}).strict();
export const WorkerActionResponse = wire(z.discriminatedUnion("kind", [
  WorkerResponse,
  // No scope, generation or effect is asserted when authentication/admission fails.
  z.object({ schemaVersion: Version, kind: z.literal("worker_action_rejected"), requestId: Id, error: ErrorObject }).strict(),
]).superRefine((response, ctx) => {
  if (response.kind !== "worker_action_response") return;
  const outcome = response.outcome;
  if ("error" in outcome) {
    if ((outcome.error.nodeId !== undefined && outcome.error.nodeId !== response.effect.nodeId) ||
        (outcome.error.epoch !== undefined && outcome.error.epoch !== response.effect.epoch)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome", "error"], message: "Error location must match effect" });
    }
    const expectedCodes = outcome.state === "cancel_pending" ? ["CANCEL_UNCONFIRMED"]
      : outcome.state === "unknown" || outcome.state === "reconciliation_required" ? ["ACTION_OUTCOME_UNKNOWN", "CANCEL_UNCONFIRMED"] : undefined;
    if (expectedCodes && !expectedCodes.includes(outcome.error.code)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome", "error", "code"], message: "Error code must describe uncertain execution" });
    }
  }
  if ((outcome.state === "unknown" || outcome.state === "cancel_pending" || outcome.state === "reconciliation_required") &&
      outcome.error.retryable) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome", "error"], message: "Uncertain execution cannot be retried" });
  }
}));
export type WorkerActionResponse = z.infer<typeof WorkerActionResponse>;

const TransportContext = wire(z.object({
  schemaVersion: Version, scope: Scope,
  worker: z.object({ graphRunId: Id, generation: Count.min(1), specHash: Digest, epoch: Epoch }).strict().optional(),
}).strict());
/** Trusted integration input, deliberately not part of the wire/schema manifest. */
export type AuthenticatedGraphTransportContext = z.infer<typeof TransportContext>;
/**
 * Trusted daemon code must resolve an authenticated connection and its current
 * lease independently of the request/checkpoint. This is an integration seam,
 * NOT authentication implemented by this package. Never derive this callback's
 * result from worker scope, caller flags or a cast. G10/G12 own real verification,
 * authorization, revocation and atomic fencing. Resolve async registry/lease data
 * before calling this synchronous boundary, in the protected admission section. Remote identities fail closed
 * until that integration can verify them; there is no local-owner fallback.
 */
export type ResolveAuthenticatedGraphTransport = () => AuthenticatedGraphTransportContext | null;

export class GraphContractError extends Error {
  constructor(public readonly code: GraphErrorCode) {
    super(code);
    this.name = "GraphContractError";
  }
}

function authenticate(resolve: ResolveAuthenticatedGraphTransport): AuthenticatedGraphTransportContext {
  if (typeof resolve !== "function") throw new GraphContractError("UNAUTHENTICATED");
  try {
    const result = TransportContext.safeParse(resolve());
    if (result.success) return result.data;
  } catch { /* Fail closed on unavailable/failed authentication. */ }
  throw new GraphContractError("UNAUTHENTICATED");
}

function canonical(value: GraphJsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
}
function sameScope(left: GraphScope, right: GraphScope): void {
  if (canonical(left) !== canonical(right)) throw new GraphContractError("SCOPE_MISMATCH");
}

function parseContract<T extends z.ZodTypeAny>(schema: T, value: unknown, code: GraphErrorCode = "INPUT_CONTRACT_INVALID"): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GraphContractError(code === "INPUT_CONTRACT_INVALID" && parsed.error.issues.some((issue) => issue.path[0] === "spec") ? "SPEC_INVALID" : code);
  return parsed.data;
}

/** Control-plane mutations require a principal connection, never a worker lease. */
export function parseInboundGraphRequest(value: unknown, resolve: ResolveAuthenticatedGraphTransport): GraphRequest {
  const context = authenticate(resolve);
  if (context.worker) throw new GraphContractError("UNAUTHENTICATED");
  const request = parseContract(GraphRequest, value);
  sameScope(request.scope, context.scope);
  return request;
}

export function parseInboundWorkerActionRequest(value: unknown, resolve: ResolveAuthenticatedGraphTransport): WorkerActionRequest {
  const context = authenticate(resolve);
  if (!context.worker) throw new GraphContractError("UNAUTHENTICATED");
  const request = parseContract(WorkerActionRequest, value);
  sameScope(request.scope, context.scope);
  if (request.graphRunId !== context.worker.graphRunId) throw new GraphContractError("RUN_MISMATCH");
  if (request.generation !== context.worker.generation) throw new GraphContractError("STALE_GENERATION");
  if (request.specHash !== context.worker.specHash) throw new GraphContractError("SPEC_MISMATCH");
  if (request.epoch !== context.worker.epoch) throw new GraphContractError("EPOCH_MISMATCH");
  return request;
}

/** Pair data received on an authenticated daemon channel. This does not verify artifact truth. */
export function validateWorkerActionResponse(requestValue: unknown, responseValue: unknown): WorkerActionResponse {
  const request = parseContract(WorkerActionRequest, requestValue);
  const response = parseContract(WorkerActionResponse, responseValue, "OUTPUT_CONTRACT_INVALID");
  const mismatch = (): never => { throw new GraphContractError("RESPONSE_MISMATCH"); };
  if (response.requestId !== request.requestId) mismatch();
  if (response.kind === "worker_action_rejected") return response;
  if (response.generation !== request.generation) mismatch();
  sameScope(request.scope, response.effect.scope);
  for (const key of ["graphRunId", "specHash", "epoch", "nodeId", "effectSlot"] as const) {
    if (request[key] !== response.effect[key]) mismatch();
  }
  if (response.outcome.state === "confirmed") {
    const kinds: Record<WorkerActionRequest["action"]["kind"], GraphResult["kind"]> = {
      implement: "implementation_complete", repair: "implementation_complete", freeze: "candidate_ready",
      review: "review", tests: "tests", workspace_create: "workspace", workspace_release: "workspace",
    };
    const result = response.outcome.result;
    if (result.kind !== kinds[request.action.kind]) mismatch();
    if ("candidateRevision" in request.action && "candidateRevision" in result && request.action.candidateRevision !== result.candidateRevision) mismatch();
    if ("workspaceLeaseRef" in request.action && "workspaceLeaseRef" in result && request.action.workspaceLeaseRef !== result.workspaceLeaseRef) mismatch();
  }
  return response;
}

function hash(domain: string, value: GraphJsonValue): string {
  return createHash("sha256").update(`${domain}\n${canonical(value)}`, "utf8").digest("hex");
}
/**
 * Digest v1 = SHA-256 of domain + LF + canonical strictly parsed business JSON.
 * Only root metadata (trace/requestedAt) and root idempotencyKey are omitted.
 * Kind, scope, source, expectedRevision and all nested data remain significant.
 * Object keys sort by JS UTF-16 order; arrays retain order; JSON number encoding.
 */
export function computeGraphInputDigest(value: unknown): string {
  const { metadata: _metadata, idempotencyKey: _key, ...business } = GraphRequest.parse(value);
  return hash("osstack.graph.input.v1", GraphJsonValue.parse(business));
}

export function computeGraphEffectKey(value: unknown): string {
  return hash("osstack.graph.effect.v1", GraphEffectIdentity.parse(value));
}

export const GraphIdempotencyRecord = wire(z.object({
  schemaVersion: Version, scope: Scope, idempotencyKey: Id, inputDigest: Digest,
}).strict());
export type GraphIdempotencyRecord = z.infer<typeof GraphIdempotencyRecord>;
const MutationContext = wire(z.object({ run: z.object({ scope: Scope, graphRunId: Id, currentRevision: Count }).strict().optional(), prior: GraphIdempotencyRecord.optional() }).strict());

/**
 * Pure decision over a trusted snapshot, NOT durable dedup/CAS or authorization.
 * After authentication/fencing, look up prior by full scope + key (all kinds).
 * Same key/digest replays even if revision has since advanced; changed digest
 * conflicts. A fresh resume/cancel must match currentRevision exactly. Start has
 * no revision. G08 must bind decision, unique key and mutation in one transaction.
 */
export function validateGraphMutation(value: unknown, snapshot: unknown): "apply" | "replay" {
  const request = parseContract(GraphRequest, value);
  const { prior, run } = parseContract(MutationContext, snapshot);
  if (request.kind === "start" && run) throw new GraphContractError("INPUT_CONTRACT_INVALID");
  if (request.kind !== "start" && run) {
    sameScope(request.scope, run.scope);
    if (request.graphRunId !== run.graphRunId) throw new GraphContractError("RUN_MISMATCH");
  }
  if (prior) {
    sameScope(prior.scope, request.scope);
    if (prior.idempotencyKey !== request.idempotencyKey || prior.inputDigest !== computeGraphInputDigest(request)) {
      throw new GraphContractError("IDEMPOTENCY_CONFLICT");
    }
    return "replay";
  }
  if (request.kind !== "start" && request.expectedRevision !== run?.currentRevision) throw new GraphContractError("REVISION_CONFLICT");
  return "apply";
}

/** Same-generation transport retransmission: keep requestId and every business field. */
export function validateWorkerTransportRetry(previous: unknown, retry: unknown): "replay" {
  const { metadata: _previousMetadata, ...first } = WorkerActionRequest.parse(previous);
  const { metadata: _retryMetadata, ...second } = WorkerActionRequest.parse(retry);
  if (canonical(first) !== canonical(second)) throw new GraphContractError("IDEMPOTENCY_CONFLICT");
  return "replay";
}

/** Read-only lookup. Scope is checked against the authenticated connection. */
export const GraphStatusRequest = wire(z.object({ schemaVersion: Version, scope: Scope, graphRunId: Id }).strict());
export type GraphStatusRequest = z.infer<typeof GraphStatusRequest>;

const DelegationFields = z.object({
  schemaVersion: Version, scope: Scope, graphRunId: Id, source: Start.shape.source,
  status: GraphRunState, revision: Count, generation: Count,
  inputDigest: Digest, specHash: Digest, createdAt: Count, updatedAt: Count,
  publication: z.literal("artifact_only"), phase: Id,
  budget: z.object({ limits: Spec.shape.limits, actionStarts: Count, reservedTokens: z.string().regex(/^(0|[1-9][0-9]{0,39})$/), chargedTokens: z.string().regex(/^(0|[1-9][0-9]{0,39})$/), accountingBlocked: z.boolean() }).strict(),
  candidate: z.object({ candidateRevision: Commit, artifactRefs: Refs, artifactDigest: Digest }).strict().optional(),
  evidenceRefs: z.array(Id).max(100), resultRef: Id.optional(),
  delivery: z.enum(["pending", "available", "delivery_unknown"]),
  interrupt: z.object({ interruptId: Id, inputDigest: Digest, kind: z.enum(["quality", "authorization"]) }).strict().optional(),
  authorization: z.object({ kind: z.literal("needs_authorization"), scope: Scope, requestRef: Id }).strict().optional(),
  error: ErrorObject.optional(),
 }).strict();
// Keep availability requirements in JSON Schema too, for non-TypeScript callers.
const DelegationStatus = z.discriminatedUnion("status", [
  DelegationFields.extend({ status: z.literal("ready"), delivery: z.literal("available"),
    candidate: DelegationFields.shape.candidate.unwrap(), resultRef: Id, evidenceRefs: Refs }),
  DelegationFields.extend({ status: z.enum(["cancel_pending", "reconciliation_required"]), delivery: z.literal("delivery_unknown") }),
  DelegationFields.extend({ status: GraphRunState.exclude(["ready", "cancel_pending", "reconciliation_required"]), delivery: z.enum(["pending", "delivery_unknown"]) }),
]).superRefine((value, ctx) => {
  if (value.interrupt && value.interrupt.inputDigest !== value.inputDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Interrupt must bind original input" });
  }
  if (value.authorization && canonical(value.authorization.scope) !== canonical(value.scope)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Authorization must return to original scope" });
  }
});
/** OSStack v1 delegation projection. References are verified by the serving host;
 * consumers must not turn an artifact-only result into merge/push authorization. */
export const GraphDelegationStatus = wire(DelegationStatus);
export type GraphDelegationStatus = z.infer<typeof GraphDelegationStatus>;
/** A lost mutation response is not a failed action. Retry the exact request/key. */
export const GraphDeliveryUnknown = wire(z.object({
  schemaVersion: Version, kind: z.literal("delivery_unknown"), scope: Scope,
  idempotencyKey: Id, inputDigest: Digest, graphRunId: Id.optional(),
  nextAction: z.literal("retry_same_request"),
}).strict());
export type GraphDeliveryUnknown = z.infer<typeof GraphDeliveryUnknown>;

/** Single generated registry document; context/callbacks never cross the wire. */
export const GraphProtocol = z.object({
  spec: GraphSpec, scope: GraphScope, budget: GraphBudget, error: GraphError,
  runState: GraphRunState, nodeState: GraphNodeState, actionState: GraphActionState,
  result: GraphResult, request: GraphRequest, effectIdentity: GraphEffectIdentity,
  workerActionRequest: WorkerActionRequest, workerActionResponse: WorkerActionResponse,
  idempotencyRecord: GraphIdempotencyRecord,
  statusRequest: GraphStatusRequest, delegationStatus: GraphDelegationStatus, deliveryUnknown: GraphDeliveryUnknown,
}).strict();
