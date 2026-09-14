import { createHash } from "node:crypto";
import { z } from "zod";

/** v1 wire limits, also enforced before Zod traverses untrusted object input. */
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
  z.array(JsonValue).max(GRAPH_JSON_LIMITS.maxValues), z.record(z.string().max(256), JsonValue),
]));
export const GraphJsonValue = wire(JsonValue);

const Version = z.literal(1);
// No trimming/coercion: business identities must not silently collapse.
// biome-ignore lint/suspicious/noControlCharactersInRegex: Wire IDs must reject ASCII control characters.
const Id = z.string().min(1).max(256).regex(/^[^\s\u0000-\u001f](?:[^\u0000-\u001f]*[^\s\u0000-\u001f])?$/);
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
  "IDEMPOTENCY_CONFLICT", "REVISION_CONFLICT", "INTERNAL_ERROR",
]);
export type GraphErrorCode = z.infer<typeof GraphErrorCode>;
const ErrorObject = z.object({
  schemaVersion: Version, code: GraphErrorCode, message: z.string().min(1).max(4096),
  retryable: z.boolean(), nextAction: z.enum(["fix_input", "reauthorize", "reconcile", "refresh", "retry", "stop"]),
  nodeId: Id.optional(), epoch: Epoch.optional(), actionId: Id.optional(),
}).strict().superRefine((error, ctx) => {
  if (error.retryable && !["OUTPUT_CONTRACT_INVALID", "INTERNAL_ERROR"].includes(error.code)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["retryable"], message: "Error cannot authorize automatic retry" });
  }
  if (["ACTION_OUTCOME_UNKNOWN", "CANCEL_UNCONFIRMED"].includes(error.code) && error.nextAction === "retry") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nextAction"], message: "Uncertain execution requires reconciliation" });
  }
});
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
/** Ledger-issued identity. Generation fences transport, never identifies an effect. */
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
    z.object({ state: z.literal("failed"), error: ErrorObject }).strict(),
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
  if ((outcome.state === "unknown" || outcome.state === "cancel_pending" || outcome.state === "reconciliation_required") &&
      (outcome.error.retryable || outcome.error.nextAction === "retry")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome", "error"], message: "Uncertain execution cannot be retried" });
  }
}));
export type WorkerActionResponse = z.infer<typeof WorkerActionResponse>;

const TransportContext = wire(z.object({
  schemaVersion: Version, scope: Scope,
  worker: z.object({ graphRunId: Id, generation: Count.min(1) }).strict().optional(),
}).strict());
/** Trusted integration input, deliberately not part of the wire/schema manifest. */
export type AuthenticatedGraphTransportContext = z.infer<typeof TransportContext>;
/**
 * Trusted daemon code must resolve an authenticated connection and its current
 * lease independently of the request/checkpoint. This is an integration seam,
 * NOT authentication implemented by this package. Never derive this callback's
 * result from worker scope, caller flags or a cast. G10/G12 own real verification,
 * authorization, revocation and atomic fencing. Remote identities fail closed
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

/** Schema parsing alone is not inbound authentication. Use this at the trusted boundary. */
export function parseInboundGraphRequest(value: unknown, resolve: ResolveAuthenticatedGraphTransport): GraphRequest {
  const context = authenticate(resolve);
  const request = GraphRequest.parse(value);
  sameScope(request.scope, context.scope);
  if (context.worker && request.kind !== "start" && request.graphRunId !== context.worker.graphRunId) {
    throw new GraphContractError("RUN_MISMATCH");
  }
  return request;
}

export function parseInboundWorkerActionRequest(value: unknown, resolve: ResolveAuthenticatedGraphTransport): WorkerActionRequest {
  const context = authenticate(resolve);
  if (!context.worker) throw new GraphContractError("UNAUTHENTICATED");
  const request = WorkerActionRequest.parse(value);
  sameScope(request.scope, context.scope);
  if (request.graphRunId !== context.worker.graphRunId) throw new GraphContractError("RUN_MISMATCH");
  if (request.generation !== context.worker.generation) throw new GraphContractError("STALE_GENERATION");
  return request;
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
const MutationContext = wire(z.object({ currentRevision: Count.optional(), prior: GraphIdempotencyRecord.optional() }).strict());

/**
 * Pure decision over a trusted snapshot, NOT durable dedup/CAS or authorization.
 * After authentication/fencing, look up prior by full scope + key (all kinds).
 * Same key/digest replays even if revision has since advanced; changed digest
 * conflicts. A fresh resume/cancel must match currentRevision exactly. Start has
 * no revision. G08 must bind decision, unique key and mutation in one transaction.
 */
export function validateGraphMutation(value: unknown, snapshot: unknown): "apply" | "replay" {
  const request = GraphRequest.parse(value);
  const { prior, currentRevision } = MutationContext.parse(snapshot);
  if (prior) {
    sameScope(prior.scope, request.scope);
    if (prior.idempotencyKey !== request.idempotencyKey || prior.inputDigest !== computeGraphInputDigest(request)) {
      throw new GraphContractError("IDEMPOTENCY_CONFLICT");
    }
    return "replay";
  }
  if (request.kind !== "start" && request.expectedRevision !== currentRevision) throw new GraphContractError("REVISION_CONFLICT");
  return "apply";
}

/** Same-generation transport retransmission: keep requestId and every business field. */
export function validateWorkerTransportRetry(previous: unknown, retry: unknown): "replay" {
  const { metadata: _previousMetadata, ...first } = WorkerActionRequest.parse(previous);
  const { metadata: _retryMetadata, ...second } = WorkerActionRequest.parse(retry);
  if (canonical(first) !== canonical(second)) throw new GraphContractError("IDEMPOTENCY_CONFLICT");
  return "replay";
}

/** Single generated registry document; context/callbacks never cross the wire. */
export const GraphProtocol = z.object({
  spec: GraphSpec, scope: GraphScope, budget: GraphBudget, error: GraphError,
  runState: GraphRunState, nodeState: GraphNodeState, actionState: GraphActionState,
  result: GraphResult, request: GraphRequest, effectIdentity: GraphEffectIdentity,
  workerActionRequest: WorkerActionRequest, workerActionResponse: WorkerActionResponse,
  idempotencyRecord: GraphIdempotencyRecord,
}).strict();
