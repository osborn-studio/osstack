// Trusted administrative recovery only. This port is never a worker JSON API.
import { createHash } from "node:crypto";
import { readApply } from "./graph-apply.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { GraphJsonValue, GraphResult, validateWorkerActionResponse } from "@osstack/protocol";
import { preflightDiskSpace } from "./db.js";
import { GraphRunStore, GraphRunStorageError, graphRunFenceSchema, type GraphRun, type GraphRunFence, type GraphStoppedWorkerEvidence } from "./graph-runs.js";
import type { GraphAction, GraphActionOutcome } from "./graph-actions.js";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in persisted recovery references.
const ref = z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f-\x9f]+$/).refine((s) => s.trim() === s);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const stopped = z.object({ kind: z.literal("stopped"), graphRunId: ref, generation: count.min(1), owner: ref, confirmedAt: count, evidenceRef: ref }).strict();
// No-child is a distinct trusted host receipt. Registration denials/duplicate
// launch claims are not proof that an existing generation never spawned.
const notStarted = stopped.extend({ kind: z.literal("not_started") });
const noChildEvent = stopped.extend({ kind: z.literal("spawn_failed"), phase: z.enum(["registration", "spawn"]), error: z.string() });
const proofSchema = z.object({ snapshotDigest: digest, verifiedAt: count,
  worker: z.union([stopped, notStarted, z.object({ kind: z.literal("preworker"), evidenceRef: ref }).strict()]),
  effectWorker: stopped.optional(), executorEvidenceRef: ref, workspaceEvidenceRef: ref }).strict();
const verdictSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("applied"), evidenceRef: ref, actualTokens: count.nullable(), result: GraphResult }).strict(),
  z.object({ outcome: z.literal("not_applied"), evidenceRef: ref, actualTokens: count.nullable(), error: GraphJsonValue }).strict(),
  z.object({ outcome: z.literal("unknown"), evidenceRef: ref, observedTokens: count }).strict(),
]);
const decisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("effect"), receiptId: ref, verdict: verdictSchema }).strict(),
  z.object({ kind: z.literal("project"), receiptId: ref, status: z.enum(["cancel_pending", "cancelled", "waiting_input", "running"]) }).strict(),
  z.object({ kind: z.literal("takeover"), receiptId: ref, owner: ref, leaseExpiresAt: count }).strict(),
]);
export type GraphRecoveryProof = z.infer<typeof proofSchema>;
export type GraphRecoveryVerdict = z.infer<typeof verdictSchema>;
export type GraphRecoveryDecision = z.infer<typeof decisionSchema>;
export interface GraphRecoverySnapshot { fence: GraphRunFence; run: GraphRun; action: GraphAction | null; digest: string; interruptId: string }
export interface GraphExecutorInventory {
  snapshot: GraphRecoverySnapshot;
  /** Every claimed generation, including generations with no actions or launch. */
  workers: Array<{ generation: number; owner: string; acquiredAt: number; expiresAt: number }>;
  entries: Array<{ action: GraphAction; owner: string; admission: { generation: number; owner: string; heldAt: number; releasedAt: number | null } | null }>;
  /** Includes missing admission rows, even for settled legacy actions. */
  requiredEffectKeys: string[];
  digest: string;
}
export interface GraphRecoveryRecord { snapshot: GraphRecoverySnapshot; proof: GraphRecoveryProof; decision: GraphRecoveryDecision; committedAt: number }
export interface GraphRecoveryResult { run: GraphRun; action: GraphAction | null; record: GraphRecoveryRecord; changed: boolean }
/** Must independently authenticate supervisor/executor/workspace evidence AND the
 * exact decision/result/evidence/receipt. A string,
 * boolean, object or Promise is never authorization. Invoked inside BEGIN IMMEDIATE. */
export type GraphRecoveryVerifier = (snapshot: GraphRecoverySnapshot, proof: GraphRecoveryProof, decision: GraphRecoveryDecision) => void;
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const r = v as Record<string, unknown>;
  return `{${Object.keys(r).sort().map((k) => `${JSON.stringify(k)}:${canonical(r[k])}`).join(",")}}`;
}
const fail = (code: string): never => { throw new Error(code); };
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
export const graphRecoveryInterruptId = (effectKey: string): string => `graph-recovery:${digest.parse(effectKey)}`;
function normalizeDecision(value: GraphRecoveryDecision): GraphRecoveryDecision {
  // Invalid usage never erases a verified physical result. Null retains capacity.
  const input = value.kind === "effect" && value.verdict.outcome !== "unknown"
    ? { ...value, verdict: { ...value.verdict, actualTokens: count.safeParse(value.verdict.actualTokens).success ? value.verdict.actualTokens : null } } : value;
  return decisionSchema.parse(GraphJsonValue.parse(input));
}

/** Host-owned physical admission bookkeeping, not a worker API. Record a hold
 * before invocation; record release only after the exact physical lease releases.
 * Recovery also records an obligation for legacy/acquire-crash actions. This is
 * bookkeeping, not proof of physical cleanup. Apply recovery uses the proof-checked
 * GraphRecoveryStore release paths; never release merely because a call ended. */
export class GraphAdmissionStore {
  constructor(private readonly db: Database.Database) {}
  hold(effectKey: string, now: number): void {
    digest.parse(effectKey); count.parse(now);
    const row = this.db.prepare("SELECT a.graph_run_id,a.generation,l.owner FROM graph_actions a JOIN graph_worker_leases l ON l.graph_run_id=a.graph_run_id AND l.generation=a.generation WHERE a.effect_key=?")
      .get(effectKey) as { graph_run_id: string; generation: number; owner: string } | undefined;
    if (!row) fail("ACTION_NOT_FOUND");
    this.db.prepare("INSERT INTO graph_action_admissions(effect_key,graph_run_id,generation,owner,held_at,released_at) VALUES(?,?,?,?,?,NULL) ON CONFLICT(effect_key) DO NOTHING")
      .run(effectKey, row!.graph_run_id, row!.generation, row!.owner, now);
  }
  released(effectKey: string, now: number): void {
    digest.parse(effectKey); count.parse(now);
    const row = this.db.prepare("SELECT held_at FROM graph_action_admissions WHERE effect_key=?").get(effectKey) as { held_at: number } | undefined;
    if (row && now < row.held_at) fail("INVALID_TIME");
    this.db.prepare("UPDATE graph_action_admissions SET released_at=? WHERE effect_key=? AND released_at IS NULL").run(now, effectKey);
  }
}

export class GraphRecoveryStore {
  constructor(private readonly db: Database.Database, private readonly verifyProof: GraphRecoveryVerifier) {}
  /** Read the action, its admission and historical worker owner under one fence.
   * Expiry is permitted for administrative inspection; no recovery is authorized. */
  inspectAdmission(fence: GraphRunFence, effectKey: string) {
    const input = graphRunFenceSchema.parse(GraphJsonValue.parse(fence));
    return this.transaction(() => {
      const snapshot = this.capture(input, effectKey);
      const row = this.db.prepare(`SELECT a.graph_run_id,a.generation,a.owner,a.held_at,a.released_at,l.owner AS lease_owner
        FROM graph_action_admissions a LEFT JOIN graph_worker_leases l
        ON l.graph_run_id=a.graph_run_id AND l.generation=a.generation WHERE a.effect_key=?`)
        .get(effectKey) as { graph_run_id: string; generation: number; owner: string; held_at: number; released_at: number | null; lease_owner: string | null } | undefined;
      if (!row || row.graph_run_id !== snapshot.run.graphRunId || row.generation !== snapshot.action!.generation
        || row.owner !== row.lease_owner) fail("RECOVERY_ADMISSION_BINDING");
      return { snapshot, admission: { generation: row!.generation, owner: row!.owner, heldAt: row!.held_at, releasedAt: row!.released_at } };
    });
  }
  private inventory(fence: GraphRunFence, effectKey?: string): GraphExecutorInventory {
    const snapshot = this.capture(fence, effectKey);
    const workers = this.db.prepare(`SELECT generation,owner,acquired_at AS acquiredAt,expires_at AS expiresAt
      FROM graph_worker_leases WHERE graph_run_id=? ORDER BY generation`).all(snapshot.run.graphRunId) as GraphExecutorInventory['workers'];
    if (workers.length !== snapshot.run.generation || workers.some((worker, index) => worker.generation !== index + 1)
      || (workers.length > 0 && workers.at(-1)!.owner !== snapshot.run.leaseOwner)) fail('RECOVERY_WORKER_INVENTORY_BINDING');
    // Union catches malformed cross-run admissions as well as actions missing a hold.
    const keys = this.db.prepare(`SELECT effect_key FROM graph_actions WHERE graph_run_id=?
      UNION SELECT effect_key FROM graph_action_admissions WHERE graph_run_id=? ORDER BY effect_key`)
      .all(snapshot.run.graphRunId, snapshot.run.graphRunId) as { effect_key: string }[];
    const entries = keys.map(({ effect_key }) => {
      const action = this.action(snapshot.run, effect_key)!;
      const lease = this.db.prepare('SELECT owner FROM graph_worker_leases WHERE graph_run_id=? AND generation=?')
        .get(snapshot.run.graphRunId, action.generation) as { owner: string } | undefined;
      const row = this.db.prepare('SELECT graph_run_id,generation,owner,held_at,released_at FROM graph_action_admissions WHERE effect_key=?')
        .get(effect_key) as { graph_run_id: string; generation: number; owner: string; held_at: number; released_at: number | null } | undefined;
      if (!lease || (row && (row.graph_run_id !== snapshot.run.graphRunId || row.generation !== action.generation || row.owner !== lease.owner))) fail('RECOVERY_ADMISSION_BINDING');
      return { action, owner: lease!.owner, admission: row ? { generation: row.generation, owner: row.owner, heldAt: row.held_at, releasedAt: row.released_at } : null };
    });
    const requiredEffectKeys = entries.filter(entry => !entry.admission || entry.admission.releasedAt === null
      || !['confirmed', 'failed'].includes(entry.action.state)).map(entry => entry.action.effectKey);
    const body = { snapshot, workers, entries, requiredEffectKeys };
    return { ...body, digest: hash(body) };
  }
  /** Complete run inventory, including historical generations and missing holds.
   * This is an inspection, never proof of physical executor quiescence. */
  inspectExecutors(value: GraphRunFence, effectKey?: string): GraphExecutorInventory {
    const fence = graphRunFenceSchema.parse(GraphJsonValue.parse(value));
    return this.transaction(() => this.inventory(fence, effectKey));
  }
  /** Read-only final attestation guard inside the caller's G15 transaction.
   * Admission release does not advance run revision, so compare the entire inventory. */
  assertExecutorInventory(value: GraphExecutorInventory): void {
    if (!this.db.inTransaction) fail('RECOVERY_TRANSACTION_REQUIRED');
    const fence = graphRunFenceSchema.parse(GraphJsonValue.parse(value.snapshot.fence));
    if (this.inventory(fence, value.snapshot.action?.effectKey).digest !== digest.parse(value.digest)) fail('RECOVERY_INVENTORY_CHANGED');
  }
  private transaction<T>(fn: () => T): T {
    if (this.db.inTransaction) fail("Recovery requires its own BEGIN IMMEDIATE transaction");
    preflightDiskSpace(this.db.name);
    return this.db.transaction(fn).immediate();
  }
  private run(fence: GraphRunFence, replay = false): GraphRun {
    const run = new GraphRunStore(this.db).get(fence.scope, fence.graphRunId);
    const error = (code: ConstructorParameters<typeof GraphRunStorageError>[0]): never => { throw new GraphRunStorageError(code); };
    if (!run) return error("RUN_NOT_FOUND");
    if (canonical(run.identity) !== canonical(fence.identity)) error("PROGRAM_IDENTITY_MISMATCH");
    if (run.generation !== fence.expectedGeneration) error("STALE_GENERATION");
    if (run.leaseOwner !== fence.expectedOwner) error("OWNER_MISMATCH");
    if (!replay && run.revision !== fence.expectedRevision) error("REVISION_CONFLICT");
    if (!replay && fence.now < run.updatedAt) error("INVALID_TIME");
    return run;
  }
  private action(run: GraphRun, key: string | undefined): GraphAction | null {
    if (key === undefined) return null;
    digest.parse(key);
    const r = this.db.prepare("SELECT * FROM graph_actions WHERE graph_run_id = ? AND effect_key = ?").get(run.graphRunId, key) as Record<string, unknown> | undefined;
    if (!r) return fail("ACTION_NOT_FOUND");
    const json = (name: string) => r[name] === null ? null : JSON.parse(r[name] as string);
    return { effectKey: key, effect: json("effect_json"), action: json("action_json"), businessDigest: r.business_digest as string,
      generation: r.generation as number, reservationTokens: r.reservation_tokens as number, state: r.state as GraphAction["state"],
      executionRef: r.execution_ref as string | null, outcome: json("outcome_json"), uncertainty: json("uncertainty_json"),
      actualTokens: r.actual_tokens as number | null, observedTokens: r.observed_tokens as number, accountingBlocked: r.accounting_blocked === 1,
      retrySafe: r.retry_safe === 1, createdAt: r.created_at as number, updatedAt: r.updated_at as number };
  }
  private capture(fence: GraphRunFence, effectKey?: string): GraphRecoverySnapshot {
    const run = this.run(fence); const action = this.action(run, effectKey);
    const interruptId = effectKey ? graphRecoveryInterruptId(effectKey) : `graph-recovery-run:${run.graphRunId}`;
    const body = { fence, run, action, interruptId };
    return { ...body, digest: hash(body) };
  }
  /** Read-only admin snapshot can inspect terminal state for release replay. */
  snapshot(value: GraphRunFence, effectKey?: string): GraphRecoverySnapshot {
    const fence = graphRunFenceSchema.parse(GraphJsonValue.parse(value));
    return this.transaction(() => this.capture(fence, effectKey));
  }
  private record(run: GraphRun, receiptId: string): GraphRecoveryRecord | null {
    ref.parse(receiptId);
    const row = this.db.prepare("SELECT * FROM graph_recovery_decisions WHERE graph_run_id = ? AND receipt_id = ?")
      .get(run.graphRunId, receiptId) as { snapshot_json: string; proof_json: string; decision_json: string; committed_at: number } | undefined;
    return row ? { snapshot: JSON.parse(row.snapshot_json), proof: JSON.parse(row.proof_json), decision: JSON.parse(row.decision_json), committedAt: row.committed_at } : null;
  }
  history(value: GraphRunFence, effectKey?: string): GraphRecoveryRecord[] {
    const fence = graphRunFenceSchema.parse(GraphJsonValue.parse(value));
    return this.transaction(() => {
      const run = this.run(fence); if (effectKey) this.action(run, effectKey);
      const rows = this.db.prepare(`SELECT receipt_id FROM graph_recovery_decisions WHERE graph_run_id = ?${effectKey ? " AND effect_key = ?" : ""} ORDER BY committed_at, rowid`)
        .all(...(effectKey ? [run.graphRunId, effectKey] : [run.graphRunId])) as { receipt_id: string }[];
      return rows.map((row) => this.record(run, row.receipt_id)!);
    });
  }
  private proof(snapshot: GraphRecoverySnapshot, value: GraphRecoveryProof, now: number, decision: GraphRecoveryDecision): GraphRecoveryProof {
    const proof = proofSchema.parse(GraphJsonValue.parse(value));
    if (proof.snapshotDigest !== snapshot.digest || proof.verifiedAt < snapshot.fence.now || proof.verifiedAt > now) fail("PROOF_SNAPSHOT_MISMATCH");
    const run = snapshot.run;
    if (run.generation === 0) { if (proof.worker.kind !== "preworker" || proof.effectWorker) fail("WORKER_PROOF_MISMATCH"); }
    else {
      const w = proof.worker;
      if (w.kind === "preworker" || w.graphRunId !== run.graphRunId || w.generation !== run.generation || w.owner !== run.leaseOwner
        || w.confirmedAt < run.leaseAcquiredAt! || w.confirmedAt > proof.verifiedAt) fail("WORKER_PROOF_MISMATCH");
      if (w.kind === "not_started" && (this.db.prepare("SELECT 1 FROM graph_actions WHERE graph_run_id = ? AND generation = ? LIMIT 1").get(run.graphRunId, run.generation)
        || this.db.prepare("SELECT 1 FROM graph_checkpoint_requests WHERE graph_run_id = ? AND generation = ? LIMIT 1").get(run.graphRunId, run.generation))) fail("WORKER_PROOF_MISMATCH");
      if (w.kind === "not_started") {
        const launch = this.db.prepare("SELECT owner,identity_json,launched_at FROM graph_worker_launches WHERE graph_run_id=? AND generation=?")
          .get(run.graphRunId, run.generation) as { owner: string; identity_json: string; launched_at: number } | undefined;
        if (!launch) fail("WORKER_PROOF_MISMATCH");
        if (launch) {
          const events = this.db.prepare("SELECT kind,event_json FROM graph_worker_process_events WHERE graph_run_id=? AND generation=?")
            .all(run.graphRunId, run.generation) as { kind: string; event_json: string }[];
          // Consuming a generation is not evidence that no child ever existed.
          if (launch.owner !== w.owner || launch.identity_json !== canonical(run.identity) || launch.launched_at > w.confirmedAt
            || events.length !== 1 || events[0]!.kind !== "spawn_failed") fail("WORKER_PROOF_MISMATCH");
          let event: z.infer<typeof noChildEvent>;
          try { event = noChildEvent.parse(JSON.parse(events[0]!.event_json)); }
          catch { return fail("WORKER_PROOF_MISMATCH"); }
          if (event.graphRunId !== w.graphRunId || event.generation !== w.generation || event.owner !== w.owner
            || event.evidenceRef !== w.evidenceRef || event.confirmedAt !== w.confirmedAt) fail("WORKER_PROOF_MISMATCH");
        }
      }
      if (snapshot.action && snapshot.action.generation !== run.generation) {
        const old = proof.effectWorker;
        const lease = this.db.prepare("SELECT owner, acquired_at FROM graph_worker_leases WHERE graph_run_id = ? AND generation = ?")
          .get(run.graphRunId, snapshot.action.generation) as { owner: string; acquired_at: number } | undefined;
        if (!old || !lease || old.graphRunId !== run.graphRunId || old.generation !== snapshot.action.generation || old.owner !== lease.owner
          || old.confirmedAt < lease.acquired_at || old.confirmedAt > proof.verifiedAt) fail("EFFECT_WORKER_PROOF_MISMATCH");
      } else if (proof.effectWorker) fail("EFFECT_WORKER_PROOF_MISMATCH");
    }
    const authorization: unknown = this.verifyProof(structuredClone(snapshot), structuredClone(proof), structuredClone(decision));
    if (authorization !== undefined) {
      void Promise.resolve(authorization).catch(() => undefined);
      fail("INVALID_PROOF_AUTHORITY");
    }
    return proof;
  }
  private unchanged(snapshot: GraphRecoverySnapshot, now: number): GraphRun {
    count.parse(now);
    const fresh = this.capture(snapshot.fence, snapshot.action?.effectKey);
    if (canonical(fresh) !== canonical(snapshot)) fail("PROOF_SNAPSHOT_MISMATCH");
    if (now < fresh.run.updatedAt || now < snapshot.fence.now) fail("INVALID_TIME");
    return fresh.run;
  }
  /** Revalidate fresh authority for release retries without altering immutable decisions. */
  verifyDecision(snapshot: GraphRecoverySnapshot, receiptId: string, proof: GraphRecoveryProof, now: number): GraphRecoveryResult {
    return this.transaction(() => {
      const run = this.unchanged(snapshot, now);
      const record = this.record(run, receiptId) ?? fail("DECISION_NOT_FOUND");
      this.proof(snapshot, proof, now, record.decision);
      if (record.snapshot.action?.effectKey !== snapshot.action?.effectKey) fail("DECISION_CONFLICT");
      return { run, action: snapshot.action, record, changed: false };
    });
  }
  verifyRelease(snapshot: GraphRecoverySnapshot, receiptId: string, proof: GraphRecoveryProof, now: number): GraphRecoveryResult {
    const result = this.verifyDecision(snapshot, receiptId, proof, now);
    if (result.record.decision.kind === "effect" && result.record.decision.verdict.outcome === "unknown") fail("UNRESOLVED_ACTION");
    return result;
  }
  /** Called only after the trusted release callback completed. A lost DB ACK
   * leaves a held obligation, so takeover/terminal projection remain blocked. */
  completeRelease(snapshot: GraphRecoverySnapshot, receiptId: string, proof: GraphRecoveryProof, now: number): GraphRecoveryResult {
    return this.transaction(() => {
      const run = this.unchanged(snapshot, now);
      const record = this.record(run, receiptId) ?? fail("DECISION_NOT_FOUND");
      if (!snapshot.action || record.snapshot.action?.effectKey !== snapshot.action.effectKey || record.decision.kind !== "effect"
        || record.decision.verdict.outcome === "unknown") fail("UNRESOLVED_ACTION");
      this.proof(snapshot, proof, now, record.decision);
      new GraphAdmissionStore(this.db).released(snapshot.action!.effectKey, now);
      return { run, action: snapshot.action, record, changed: false };
    });
  }
  /** Quarantine release is physical-resource cleanup only. It never clears
   * uncertainty, releases token reservations, permits retries or seals the run.
   * Host must verify before physical cleanup and attest again after cleanup. */
  verifyQuarantineRelease(snapshot: GraphRecoverySnapshot, receiptId: string, proof: GraphRecoveryProof, now: number): GraphRecoveryResult {
    return this.quarantineRelease(snapshot, receiptId, proof, now, false);
  }
  completeQuarantineRelease(snapshot: GraphRecoverySnapshot, receiptId: string, proof: GraphRecoveryProof, now: number): GraphRecoveryResult {
    return this.quarantineRelease(snapshot, receiptId, proof, now, true);
  }
  private quarantineRelease(snapshot: GraphRecoverySnapshot, receiptId: string, proof: GraphRecoveryProof, now: number, complete: boolean): GraphRecoveryResult {
    return this.transaction(() => {
      const run = this.unchanged(snapshot, now);
      const record = this.record(run, receiptId) ?? fail("DECISION_NOT_FOUND");
      const action = snapshot.action;
      if (!action || record.snapshot.action?.effectKey !== action.effectKey || record.decision.kind !== "effect"
        || record.decision.verdict.outcome !== "unknown" || !["unknown", "cancel_pending"].includes(action.state)
        || readApply(this.db, action.effectKey)?.resolution?.kind !== "quarantined") fail("QUARANTINE_RELEASE_UNSUPPORTED");
      this.proof(snapshot, proof, now, record.decision);
      if (complete) new GraphAdmissionStore(this.db).released(action!.effectKey, now);
      return { run, action, record, changed: false };
    });
  }

  commit(snapshotValue: GraphRecoverySnapshot, decisionValue: GraphRecoveryDecision, proofValue: GraphRecoveryProof, now: number): GraphRecoveryResult {
    const snapshot = structuredClone(snapshotValue); graphRunFenceSchema.parse(GraphJsonValue.parse(snapshot.fence)); count.parse(now);
    const decision = normalizeDecision(decisionValue);
    return this.transaction(() => {
      const current = this.run(snapshot.fence, true);
      if (now < current.updatedAt || now < snapshot.fence.now) fail("INVALID_TIME");
      const previous = this.record(current, decision.receiptId);
      if (previous) {
        if (canonical(previous.snapshot) !== canonical(snapshot) || canonical(previous.proof) !== canonical(proofValue)
          || canonical(previous.decision) !== canonical(decision)) fail("DECISION_CONFLICT");
        this.proof(snapshot, proofValue, now, decision);
        return { run: current, action: this.action(current, snapshot.action?.effectKey), record: previous, changed: false };
      }
      const run = this.unchanged(snapshot, now);
      if (["ready", "failed", "cancelled"].includes(run.status)) fail("TERMINAL_RUN");
      if (run.revision === Number.MAX_SAFE_INTEGER) fail("COUNTER_EXHAUSTED");
      const proof = this.proof(snapshot, proofValue, now, decision);
      let status = run.status;
      if (decision.kind === "effect") {
        const action = snapshot.action ?? fail("ACTION_NOT_FOUND");
        this.settle(run, action, decision.verdict, now);
        if (decision.verdict.outcome !== "unknown") new GraphAdmissionStore(this.db).hold(action.effectKey, now);
      }
      else {
        if (snapshot.action) fail("RUN_SNAPSHOT_REQUIRED");
        const unresolved = this.db.prepare("SELECT 1 FROM graph_actions WHERE graph_run_id = ? AND state IN ('intent','running','unknown','cancel_pending') LIMIT 1").get(run.graphRunId);
        const held = this.db.prepare("SELECT 1 FROM graph_action_admissions WHERE graph_run_id=? AND released_at IS NULL LIMIT 1").get(run.graphRunId);
        if (decision.kind === "project") {
          if (["running", "waiting_input"].includes(decision.status) && (run.status === "cancel_pending"
            || this.db.prepare("SELECT 1 FROM graph_actions WHERE graph_run_id = ? AND state = 'cancel_pending'").get(run.graphRunId))) fail("CANCEL_PENDING");
          if (["running", "cancelled"].includes(decision.status) && unresolved) fail("UNRESOLVED_ACTION");
          if (["running", "cancelled"].includes(decision.status) && held) fail("ADMISSION_RELEASE_PENDING");
          status = decision.status;
        } else {
          if (run.status === "cancel_pending") fail("CANCEL_PENDING");
          if (unresolved) fail("UNRESOLVED_ACTION");
          if (held) fail("ADMISSION_RELEASE_PENDING");
          if (run.generation === Number.MAX_SAFE_INTEGER) fail("COUNTER_EXHAUSTED");
          if (decision.leaseExpiresAt <= now) fail("INVALID_TIME");
          const generation = run.generation + 1;
          const worker: GraphStoppedWorkerEvidence | null = proof.worker.kind === "stopped" ? { graphRunId: run.graphRunId,
            generation: run.generation, owner: run.leaseOwner!, confirmedAt: proof.worker.confirmedAt, evidenceRef: proof.worker.evidenceRef } : proof.worker.kind === "not_started" ? proof.worker : null;
          this.db.prepare("UPDATE graph_runs SET generation = ?, lease_owner = ?, lease_expires_at = ?, lease_acquired_at = ? WHERE graph_run_id = ?")
            .run(generation, decision.owner, decision.leaseExpiresAt, now, run.graphRunId);
          this.db.prepare("INSERT INTO graph_worker_leases (graph_run_id, generation, owner, acquired_at, expires_at, stopped_worker_json) VALUES (?, ?, ?, ?, ?, ?)")
            .run(run.graphRunId, generation, decision.owner, now, decision.leaseExpiresAt, worker ? canonical(worker) : null);
        }
      }
      this.db.prepare("INSERT INTO graph_recovery_decisions (graph_run_id, receipt_id, effect_key, interrupt_id, snapshot_json, proof_json, decision_json, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(run.graphRunId, decision.receiptId, snapshot.action?.effectKey ?? null, snapshot.interruptId, canonical(snapshot), canonical(proof), canonical(decision), now);
      this.db.prepare("UPDATE graph_runs SET status = ?, revision = ?, updated_at = ? WHERE graph_run_id = ?").run(status, run.revision + 1, now, run.graphRunId);
      const updated = new GraphRunStore(this.db).get(run.scope, run.graphRunId)!;
      return { run: updated, action: this.action(updated, snapshot.action?.effectKey), record: { snapshot, proof, decision, committedAt: now }, changed: true };
    });
  }
  private settle(run: GraphRun, action: GraphAction, verdict: GraphRecoveryVerdict, now: number): void {
    // Legacy stopped-worker proof cannot settle a provider request or prove a
    // multifile apply. Preserve reservations until profile-specific recovery exists.
    if (verdict.outcome !== "unknown" && this.db.prepare("SELECT 1 FROM graph_invocation_requests WHERE effect_key=?").get(action.effectKey)) {
      // An immutable applied receipt can justify release-only recovery of an
      // ALREADY confirmed fact. It cannot promote running/unknown or invent an
      // outcome; canonical comparison below must match the original settlement.
      if (verdict.outcome !== "applied" || action.state !== "confirmed" || action.outcome?.state !== "confirmed"
        || !this.db.prepare("SELECT 1 FROM graph_apply_resolutions WHERE effect_key=? AND kind='applied'").get(action.effectKey)) {
        fail("INVOCATION_RECOVERY_UNSUPPORTED");
      }
    }
    if (verdict.outcome === "unknown") {
      if (action.outcome) fail("OUTCOME_CONFLICT");
      const observed = Math.max(action.observedTokens, verdict.observedTokens);
      const state = run.status === "cancel_pending" || action.state === "cancel_pending" ? "cancel_pending" : "unknown";
      const apply = readApply(this.db, action.effectKey);
      if (apply && !apply.resolution) {
        // Expired/crashed apply is quarantined under the existing stopped-worker
        // proof, preserving its historical generation and immutable journal.
        this.db.prepare("INSERT INTO graph_apply_resolutions(effect_key,kind,resolution_json,created_at) VALUES(?,'quarantined',?,?)")
          .run(action.effectKey, canonical({ schemaVersion: 1, kind: "quarantined", proposalDigest: apply.intent.proposalDigest,
            journalDigest: apply.intent.journalDigest, evidenceRef: verdict.evidenceRef, observedTokens: observed,
            cancelled: state === "cancel_pending" }), now);
      }
      this.db.prepare("UPDATE graph_actions SET state = ?, uncertainty_json = ?, observed_tokens = ?, accounting_blocked = ?, updated_at = ? WHERE effect_key = ?")
        .run(state, canonical({ state, evidenceRef: verdict.evidenceRef, observedTokens: observed }), observed,
          Number(action.accountingBlocked || observed > action.reservationTokens), now, action.effectKey);
      return;
    }
    const actualTokens = verdict.actualTokens === null ? null : Math.max(action.observedTokens, verdict.actualTokens);
    const outcome: GraphActionOutcome = verdict.outcome === "applied"
      ? { state: "confirmed", evidenceRef: verdict.evidenceRef, actualTokens, result: verdict.result }
      : { state: "failed", evidenceRef: verdict.evidenceRef, actualTokens, error: verdict.error,
        retrySafe: run.status !== "cancel_pending" && action.state !== "cancel_pending" && actualTokens !== null && !action.accountingBlocked };
    if (outcome.state === "confirmed") {
      validateWorkerActionResponse({ schemaVersion: 1, kind: "worker_action", requestId: "recovery", generation: action.generation,
        scope: run.scope, graphRunId: run.graphRunId, specHash: run.identity.specHash, epoch: action.effect.epoch,
        nodeId: action.effect.nodeId, effectSlot: action.effect.effectSlot, action: action.action },
      { schemaVersion: 1, kind: "worker_action_response", requestId: "recovery", generation: action.generation,
        effect: action.effect, outcome: { state: "confirmed", result: outcome.result } });
    }
    if (action.outcome) { if (canonical(action.outcome) !== canonical(outcome)) fail("OUTCOME_CONFLICT"); return; }
    const blocked = action.accountingBlocked || actualTokens === null || actualTokens > action.reservationTokens;
    this.db.prepare("UPDATE graph_actions SET state = ?, outcome_json = ?, actual_tokens = ?, retry_safe = ?, accounting_blocked = ?, updated_at = ? WHERE effect_key = ?")
      .run(outcome.state, canonical(outcome), actualTokens, Number(outcome.state === "failed" && outcome.retrySafe), Number(blocked), now, action.effectKey);
  }
}
