// Storage contracts only. Status is a projection of checkpoint/broker evidence,
// never an independent scheduler or node FSM. No engine code is imported here.
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { GraphJsonValue, GraphScope, GraphRunState, GraphRequest, StartGraphRequest, computeGraphInputDigest } from "@osstack/protocol";
import { preflightDiskSpace } from "./db.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls in persisted identity strings.
const text = z.string().min(1).max(256).refine((s) => s.trim() === s && !/[\u0000-\u001f\u007f-\u009f]/.test(s));
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const programSchema = z.object({
  executionModel: z.literal("langgraph-functional-v1"), durability: z.literal("sync"),
  engineVersion: text, checkpointVersion: text, templateVersion: text,
  registryVersion: text, compilerVersion: text, schemaVersion: text, compiledProgramDigest: digest,
}).strict();
const identitySchema = programSchema.extend({ specHash: digest, inputDigest: digest });
export type GraphProgramVersion = z.infer<typeof programSchema>;
export type GraphProgramIdentity = z.infer<typeof identitySchema>;
const stoppedSchema = z.object({
  graphRunId: text, generation: counter.min(1), owner: text, confirmedAt: counter, evidenceRef: text,
}).strict();
/** A trusted supervisor's durable exit receipt, NOT a worker claim or an abort result.
 * Caller must verify the receipt and independently reconcile/stop external actions
 * and isolate old workspaces before takeover. This store cannot inspect processes. */
export type GraphStoppedWorkerEvidence = z.infer<typeof stoppedSchema>;
export const graphRunFenceSchema = z.object({
  scope: GraphScope, graphRunId: text, expectedGeneration: counter, expectedRevision: counter,
  expectedOwner: text.nullable(), identity: identitySchema, now: counter,
}).strict();
export type GraphRunFence = z.infer<typeof graphRunFenceSchema>;
export interface GraphLeaseAcquisition extends GraphRunFence {
  owner: string;
  leaseExpiresAt: number;
  stoppedWorker?: GraphStoppedWorkerEvidence;
}
export interface GraphLeaseRenewal extends GraphRunFence { leaseExpiresAt: number }
export interface GraphRunProjection extends GraphRunFence { status: GraphRunState }
const acquireSchema = graphRunFenceSchema.extend({ owner: text, leaseExpiresAt: counter, stoppedWorker: stoppedSchema.optional() });
const renewSchema = graphRunFenceSchema.extend({ leaseExpiresAt: counter });
const projectSchema = graphRunFenceSchema.extend({ status: GraphRunState });

export interface GraphRun {
  graphRunId: string;
  scope: GraphScope;
  source: StartGraphRequest["source"];
  inputArtifactRef: string;
  template: StartGraphRequest["spec"]["template"];
  identity: GraphProgramIdentity;
  /** Original immutable start spec; null for pre-migration-26 runs. */
  spec: StartGraphRequest["spec"] | null;
  status: GraphRunState;
  generation: number;
  revision: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  leaseAcquiredAt: number | null;
  createdAt: number;
  updatedAt: number;
}
export type GraphRunStorageErrorCode = "RUN_NOT_FOUND" | "IDEMPOTENCY_CONFLICT" | "PROGRAM_IDENTITY_MISMATCH"
  | "STALE_GENERATION" | "REVISION_CONFLICT" | "OWNER_MISMATCH" | "LEASE_EXPIRED" | "STOPPED_WORKER_REQUIRED"
  | "STOPPED_WORKER_MISMATCH" | "TERMINAL_RUN" | "UNRESOLVED_ACTION" | "CANCEL_PENDING" | "ADMISSION_RELEASE_PENDING" | "INVALID_TIME" | "COUNTER_EXHAUSTED";
export class GraphRunStorageError extends Error {
  constructor(public readonly code: GraphRunStorageErrorCode) { super(code); this.name = "GraphRunStorageError"; }
}
const fail = (code: GraphRunStorageErrorCode): never => { throw new GraphRunStorageError(code); };
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
}
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  // Bound the decoded object before recursive schema processing, including accessors.
  return schema.parse(GraphJsonValue.parse(value));
}
function increment(value: number): number {
  if (value === Number.MAX_SAFE_INTEGER) fail("COUNTER_EXHAUSTED");
  return value + 1;
}
interface RunRow {
  graph_run_id: string; scope_json: string; source_json: string; input_artifact_ref: string; template: GraphRun["template"];
  spec_json: string | null; identity_json: string; status: GraphRunState; generation: number; revision: number;
  lease_owner: string | null; lease_expires_at: number | null; lease_acquired_at: number | null; created_at: number; updated_at: number;
}
function decode(row: RunRow): GraphRun {
  return { graphRunId: row.graph_run_id, scope: JSON.parse(row.scope_json) as GraphScope,
    source: JSON.parse(row.source_json) as StartGraphRequest["source"], inputArtifactRef: row.input_artifact_ref,
    spec: row.spec_json === null ? null : JSON.parse(row.spec_json) as StartGraphRequest["spec"],
    template: row.template, identity: JSON.parse(row.identity_json) as GraphProgramIdentity,
    status: row.status, generation: row.generation, revision: row.revision, leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at, leaseAcquiredAt: row.lease_acquired_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** Daemon-owned synchronous store. Caller authenticates scope/owner, authorizes every
 * operation, verifies compiler/artifact identity and supplies trusted epoch-ms time.
 * Never expose this API directly to worker/request JSON. A matching lease is fencing,
 * not authorization. G13 must bind checks and checkpoint writes in the SAME transaction. */
export class GraphRunStore {
  constructor(private readonly db: Database.Database) {}

  private write<T>(fn: () => T): T {
    preflightDiskSpace(this.db.name);
    // Acquire write reservation BEFORE reading: independent connections cannot both
    // admit the same key or update from the same revision (also avoids WAL upgrades).
    return this.db.transaction(fn).immediate();
  }

  get(scopeValue: GraphScope, graphRunId: string): GraphRun | null {
    const scope = GraphScope.parse(scopeValue);
    text.parse(graphRunId);
    const row = this.db.prepare("SELECT * FROM graph_runs WHERE scope_json = ? AND graph_run_id = ?")
      .get(canonical(scope), graphRunId) as RunRow | undefined;
    return row ? decode(row) : null;
  }

  /** Fresh server-generated run ID; one canonical business request per full scope/key.
   * Metadata is excluded using the protocol digest. Compiler versions/digest are
   * supplied by trusted compilation; start request/spec digests are computed here. */
  create(requestValue: StartGraphRequest, versionValue: GraphProgramVersion, nowValue: number): GraphRun {
    const request = StartGraphRequest.parse(requestValue);
    const version = parse(programSchema, versionValue);
    const now = counter.parse(nowValue);
    const inputDigest = computeGraphInputDigest(request);
    const identity: GraphProgramIdentity = { ...version, inputDigest,
      specHash: createHash("sha256").update(`osstack.graph.spec.v1\n${canonical(request.spec)}`).digest("hex") };
    const scopeJson = canonical(request.scope);
    return this.write(() => {
      const prior = this.db.prepare("SELECT graph_run_id, input_digest FROM graph_requests WHERE scope_json = ? AND idempotency_key = ?")
        .get(scopeJson, request.idempotencyKey) as { graph_run_id: string; input_digest: string } | undefined;
      if (prior) {
        if (prior.input_digest !== inputDigest) fail("IDEMPOTENCY_CONFLICT");
        const run = this.get(request.scope, prior.graph_run_id)!;
        if (canonical(run.identity) !== canonical(identity)) fail("PROGRAM_IDENTITY_MISMATCH");
        return run;
      }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO graph_runs (graph_run_id, scope_json, source_json, input_artifact_ref,
        template, identity_json, spec_json, status, generation, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, ?, ?)`)
        .run(id, scopeJson, canonical(request.source), request.inputArtifactRef, request.spec.template, canonical(identity), canonical(request.spec), now, now);
      this.db.prepare(`INSERT INTO graph_requests (scope_json, idempotency_key, graph_run_id, input_digest, kind, created_at)
        VALUES (?, ?, ?, ?, 'start', ?)`).run(scopeJson, request.idempotencyKey, id, inputDigest, now);
      return this.get(request.scope, id)!;
    });
  }

  private checked(input: GraphRunFence, requireLive: boolean): GraphRun {
    return checkGraphRunFence(this.get(input.scope, input.graphRunId), input, requireLive);
  }

  acquireLease(value: GraphLeaseAcquisition): GraphRun {
    const input = parse(acquireSchema, value);
    return this.write(() => {
      const run = this.checked(input, false);
      if (input.leaseExpiresAt <= input.now) fail("INVALID_TIME");
      if (run.generation > 0) {
        const stopped = input.stoppedWorker ?? fail("STOPPED_WORKER_REQUIRED");
        if (stopped.graphRunId !== run.graphRunId || stopped.generation !== run.generation || stopped.owner !== run.leaseOwner
          || stopped.confirmedAt < run.updatedAt || stopped.confirmedAt > input.now) fail("STOPPED_WORKER_MISMATCH");
      } else if (input.stoppedWorker) fail("STOPPED_WORKER_MISMATCH");
      if (this.db.prepare("SELECT 1 FROM graph_action_admissions WHERE graph_run_id=? AND released_at IS NULL LIMIT 1").get(run.graphRunId)) fail("ADMISSION_RELEASE_PENDING");
      const generation = increment(run.generation);
      this.db.prepare(`UPDATE graph_runs SET generation = ?, revision = ?, lease_owner = ?, lease_expires_at = ?,
        lease_acquired_at = ?, updated_at = ? WHERE graph_run_id = ? AND generation = ? AND revision = ?`)
        .run(generation, increment(run.revision), input.owner, input.leaseExpiresAt, input.now, input.now, run.graphRunId, run.generation, run.revision);
      this.db.prepare(`INSERT INTO graph_worker_leases (graph_run_id, generation, owner, acquired_at, expires_at, stopped_worker_json)
        VALUES (?, ?, ?, ?, ?, ?)`).run(run.graphRunId, generation, input.owner, input.now, input.leaseExpiresAt,
          input.stoppedWorker ? JSON.stringify(input.stoppedWorker) : null);
      return this.get(input.scope, run.graphRunId)!;
    });
  }

  renewLease(value: GraphLeaseRenewal): GraphRun {
    const input = parse(renewSchema, value);
    return this.write(() => {
      const run = this.checked(input, true);
      if (input.leaseExpiresAt <= input.now || input.leaseExpiresAt < run.leaseExpiresAt!) fail("INVALID_TIME");
      this.db.prepare(`UPDATE graph_runs SET lease_expires_at = ?, revision = ?, updated_at = ?
        WHERE graph_run_id = ? AND generation = ? AND revision = ?`)
        .run(input.leaseExpiresAt, increment(run.revision), input.now, run.graphRunId, run.generation, run.revision);
      this.db.prepare("UPDATE graph_worker_leases SET expires_at = ? WHERE graph_run_id = ? AND generation = ?")
        .run(input.leaseExpiresAt, run.graphRunId, run.generation);
      return this.get(input.scope, run.graphRunId)!;
    });
  }

  /** Store an already-authorized resume/cancel decision and its projection together.
   * Caller verifies interrupt/resume data, cancellation/exit evidence and policy;
   * this method neither resumes a worker nor sends cancellation. All request kinds
   * share one scope/key namespace. Replay returns the current run without mutation. */
  projectRequest(requestValue: Exclude<GraphRequest, StartGraphRequest>, value: GraphRunProjection): GraphRun {
    const request = GraphRequest.parse(requestValue);
    const input = parse(projectSchema, value);
    if (request.kind === "start") throw new Error("Expected resume or cancel request");
    if (canonical(request.scope) !== canonical(input.scope) || request.graphRunId !== input.graphRunId) fail("RUN_NOT_FOUND");
    const inputDigest = computeGraphInputDigest(request);
    const scopeJson = canonical(input.scope);
    return this.write(() => {
      const run = this.get(input.scope, input.graphRunId) ?? fail("RUN_NOT_FOUND");
      // Authenticate/fence before a cache hit, but do not reject a replay just
      // because its original revision has advanced or the run is now terminal.
      if (canonical(run.identity) !== canonical(input.identity)) fail("PROGRAM_IDENTITY_MISMATCH");
      if (run.generation !== input.expectedGeneration) fail("STALE_GENERATION");
      if (run.leaseOwner !== input.expectedOwner) fail("OWNER_MISMATCH");
      const prior = this.db.prepare("SELECT graph_run_id, input_digest FROM graph_requests WHERE scope_json = ? AND idempotency_key = ?")
        .get(scopeJson, request.idempotencyKey) as { graph_run_id: string; input_digest: string } | undefined;
      if (prior) {
        if (prior.graph_run_id !== run.graphRunId || prior.input_digest !== inputDigest) fail("IDEMPOTENCY_CONFLICT");
        return run;
      }
      if (request.expectedRevision !== input.expectedRevision) fail("REVISION_CONFLICT");
      const projected = this.projectInTransaction(input);
      this.db.prepare(`INSERT INTO graph_requests (scope_json, idempotency_key, graph_run_id, input_digest, kind, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(scopeJson, request.idempotencyKey, run.graphRunId, inputDigest, request.kind, input.now);
      return projected;
    });
  }

  /** Caller derives status from authoritative execution evidence. There is no
   * transition map here; only irreversible terminal sealing and transactional CAS. */
  project(value: GraphRunProjection): GraphRun {
    const input = parse(projectSchema, value);
    return this.write(() => this.projectInTransaction(input));
  }

  private projectInTransaction(input: GraphRunProjection): GraphRun {
    const run = this.checked(input, true);
    // Cancellation intent is irreversible even before external exit is confirmed.
    if (run.status === "cancel_pending" && !["cancel_pending", "cancelled"].includes(input.status)) fail("CANCEL_PENDING");
    // Never seal away the authority required to reconcile unfinished effects.
    if (["ready", "failed", "cancelled"].includes(input.status)
      && this.db.prepare("SELECT 1 FROM graph_actions WHERE graph_run_id = ? AND state IN ('intent','running','unknown','cancel_pending') LIMIT 1")
        .get(run.graphRunId)) fail("UNRESOLVED_ACTION");
    if (["ready", "failed", "cancelled"].includes(input.status)
      && this.db.prepare("SELECT 1 FROM graph_action_admissions WHERE graph_run_id=? AND released_at IS NULL LIMIT 1").get(run.graphRunId)) fail("ADMISSION_RELEASE_PENDING");
    this.db.prepare(`UPDATE graph_runs SET status = ?, revision = ?, updated_at = ?
      WHERE graph_run_id = ? AND generation = ? AND revision = ?`)
      .run(input.status, increment(run.revision), input.now, run.graphRunId, run.generation, run.revision);
    return this.get(input.scope, run.graphRunId)!;
  }
}

/** Internal shared storage check; call only while holding the SQLite write transaction. */
export function checkGraphRunFence(value: GraphRun | null, input: GraphRunFence, requireLive: boolean): GraphRun {
  const run = value ?? fail("RUN_NOT_FOUND");
  if (canonical(run.identity) !== canonical(input.identity)) fail("PROGRAM_IDENTITY_MISMATCH");
  if (run.generation !== input.expectedGeneration) fail("STALE_GENERATION");
  if (run.revision !== input.expectedRevision) fail("REVISION_CONFLICT");
  if (run.leaseOwner !== input.expectedOwner) fail("OWNER_MISMATCH");
  if (["ready", "failed", "cancelled"].includes(run.status)) fail("TERMINAL_RUN");
  if (input.now < run.updatedAt) fail("INVALID_TIME");
  if (requireLive && (run.generation === 0 || run.leaseExpiresAt === null || run.leaseExpiresAt <= input.now)) fail("LEASE_EXPIRED");
  increment(run.revision);
  return run;
}
