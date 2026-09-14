// Host-only administrative recovery. No worker RPC, scheduler or automatic retry.
import type Database from "better-sqlite3";
import { z } from "zod";
import { GraphJsonValue } from "@osstack/protocol";
import type { GraphRunFence, GraphProgramIdentity } from "@osstack/core";
import { GraphRecoveryStore, type GraphRecoverySnapshot, type GraphRecoveryProof,
  type GraphRecoveryVerdict, type GraphRecoveryDecision, type GraphRecoveryResult } from "@osstack/core/graph-recovery";

export interface GraphReconcilerRegistration {
  binding: { scope: GraphRunFence["scope"]; graphRunId: string; generation: number; owner: string | null; identity: GraphProgramIdentity };
  authorize: (snapshot: GraphRecoverySnapshot) => void;
  /** Calls the actual supervisor. Its return alone is not evidence. */
  stopWorker: (snapshot: GraphRecoverySnapshot) => Promise<unknown>;
  verifyWorker: (snapshot: GraphRecoverySnapshot, stopResult: unknown) => Promise<GraphRecoveryProof["worker"]>;
  /** Must independently stop all executors and export/quarantine the workspace. */
  verifyQuiescence: (snapshot: GraphRecoverySnapshot, worker: GraphRecoveryProof["worker"]) => Promise<Pick<GraphRecoveryProof,
    "executorEvidenceRef" | "workspaceEvidenceRef" | "effectWorker">>;
  verifyOutcome: (snapshot: GraphRecoverySnapshot) => Promise<GraphRecoveryVerdict>;
  /** Synchronous final check: permission and physical evidence remain valid. */
  recheck: (snapshot: GraphRecoverySnapshot, proof: GraphRecoveryProof, decision: GraphRecoveryDecision) => void;
  /** Idempotent exact-admission release. Call reverify inside the release guard. */
  release: (result: GraphRecoveryResult, reverify: () => Promise<void>) => Promise<void>;
}
export type GraphReconciliationRequest = { fence: GraphRunFence; receiptId: string } & (
  | { kind: "effect"; effectKey: string }
  | { kind: "project"; status: "cancel_pending" | "cancelled" | "waiting_input" | "running" }
  | { kind: "takeover"; owner: string; leaseExpiresAt: number });
export interface GraphReconciliationResult {
  exit: "applied" | "not_applied" | "unknown" | "projected" | "takeover" | "release_pending";
  result: GraphRecoveryResult;
  releaseError?: string;
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in persisted recovery references.
const ref = z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f-\x9f]+$/).refine((s) => s.trim() === s);
const requestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("effect"), fence: z.unknown(), receiptId: ref, effectKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal("project"), fence: z.unknown(), receiptId: ref, status: z.enum(["cancel_pending", "cancelled", "waiting_input", "running"]) }).strict(),
  z.object({ kind: z.literal("takeover"), fence: z.unknown(), receiptId: ref, owner: ref, leaseExpiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
]);
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const r = v as Record<string, unknown>;
  return `{${Object.keys(r).sort().map((k) => `${JSON.stringify(k)}:${canonical(r[k])}`).join(",")}}`;
}
const fail = (code: string): never => { throw new Error(code); };
const authority = (value: unknown) => {
  if (value === undefined) return;
  // Reject async grants while observing a rejected Promise so it cannot escape.
  void Promise.resolve(value).catch(() => undefined);
  fail("INVALID_RECOVERY_AUTHORITY");
};

export class GraphReconciler {
  private readonly registrations = new Map<object, GraphReconcilerRegistration>();
  private readonly store: GraphRecoveryStore;
  private attestation: { connection: object; registration: GraphReconcilerRegistration; snapshot: GraphRecoverySnapshot; proof: GraphRecoveryProof; decision: GraphRecoveryDecision } | undefined;
  constructor(db: Database.Database, private readonly now: () => number = Date.now) {
    this.store = new GraphRecoveryStore(db, (snapshot, proof, decision) => {
      const attestation = this.attestation;
      if (!attestation || canonical(attestation.snapshot) !== canonical(snapshot) || canonical(attestation.proof) !== canonical(proof) || canonical(attestation.decision) !== canonical(decision)) fail("UNVERIFIED_RECOVERY_PROOF");
      this.check(attestation!.connection, attestation!.registration, snapshot);
      authority(attestation!.registration.recheck(structuredClone(snapshot), structuredClone(proof), structuredClone(decision)));
    });
  }
  register(connection: object, registration: GraphReconcilerRegistration): void {
    if (!connection || typeof connection !== "object" || this.registrations.has(connection)) fail("INVALID_RECOVERY_REGISTRATION");
    for (const name of ["authorize", "stopWorker", "verifyWorker", "verifyQuiescence", "verifyOutcome", "recheck", "release"] as const) {
      if (typeof registration[name] !== "function") fail("INVALID_RECOVERY_REGISTRATION");
    }
    this.registrations.set(connection, { ...registration, binding: structuredClone(registration.binding) });
  }
  unregister(connection: object): void { this.registrations.delete(connection); }
  private check(connection: object, registration: GraphReconcilerRegistration, snapshot: GraphRecoverySnapshot): void {
    if (this.registrations.get(connection) !== registration) fail("RECOVERY_REGISTRATION_REVOKED");
    const run = snapshot.run;
    if (canonical(registration.binding) !== canonical({ scope: run.scope, graphRunId: run.graphRunId, generation: run.generation,
      owner: run.leaseOwner, identity: run.identity })) fail("RECOVERY_BINDING_MISMATCH");
    authority(registration.authorize(structuredClone(snapshot)));
  }
  private async proof(connection: object, registration: GraphReconcilerRegistration, snapshot: GraphRecoverySnapshot): Promise<GraphRecoveryProof> {
    this.check(connection, registration, snapshot);
    const stop = await registration.stopWorker(structuredClone(snapshot));
    this.check(connection, registration, snapshot);
    const worker = structuredClone(await registration.verifyWorker(structuredClone(snapshot), stop));
    this.check(connection, registration, snapshot);
    const quiescence = structuredClone(await registration.verifyQuiescence(structuredClone(snapshot), structuredClone(worker)));
    this.check(connection, registration, snapshot);
    if (!quiescence || typeof quiescence !== "object" || Array.isArray(quiescence)
      || Object.keys(quiescence).some((key) => !["executorEvidenceRef", "workspaceEvidenceRef", "effectWorker"].includes(key))) fail("INVALID_QUIESCENCE_PROOF");
    const proof: GraphRecoveryProof = { ...quiescence, worker, snapshotDigest: snapshot.digest, verifiedAt: this.now() };
    return proof;
  }
  private verified<T>(connection: object, registration: GraphReconcilerRegistration, snapshot: GraphRecoverySnapshot, proof: GraphRecoveryProof, decision: GraphRecoveryDecision, fn: () => T): T {
    if (this.attestation) fail("NESTED_RECOVERY");
    this.attestation = { connection, registration, snapshot: structuredClone(snapshot), proof: structuredClone(proof), decision: structuredClone(decision) };
    try { return fn(); } finally { this.attestation = undefined; }
  }
  private async release(connection: object, registration: GraphReconcilerRegistration, result: GraphRecoveryResult): Promise<void> {
    const reverify = async (completed = false) => {
      const run = result.run;
      const snapshot = this.store.snapshot({ scope: run.scope, graphRunId: run.graphRunId, identity: run.identity,
        expectedGeneration: run.generation, expectedRevision: run.revision, expectedOwner: run.leaseOwner, now: this.now() }, result.action?.effectKey);
      const proof = await this.proof(connection, registration, snapshot);
      this.verified(connection, registration, snapshot, proof, result.record.decision, () => completed ? this.store.completeRelease(snapshot, result.record.decision.receiptId, proof, this.now()) : this.store.verifyRelease(snapshot, result.record.decision.receiptId, proof, this.now()));
    };
    await reverify();
    authority(await registration.release(structuredClone(result), () => reverify()));
    await reverify(true);
  }
  async reconcile(connection: object, value: GraphReconciliationRequest): Promise<GraphReconciliationResult> {
    // Parse/clone every request field before the first await. No worker-selected callback.
    const request = requestSchema.parse(GraphJsonValue.parse(value)) as GraphReconciliationRequest;
    const registration = this.registrations.get(connection) ?? fail("RECOVERY_REGISTRATION_REQUIRED");
    const snapshot = this.store.snapshot(request.fence, request.kind === "effect" ? request.effectKey : undefined);
    this.check(connection, registration, snapshot);
    const prior = this.store.history(request.fence).find((r) => r.decision.receiptId === request.receiptId);
    if (prior && prior.snapshot.action?.effectKey !== snapshot.action?.effectKey) fail("DECISION_CONFLICT");
    if (prior && prior.snapshot.run.generation !== snapshot.run.generation) {
      // A lost takeover ACK is a read of immutable history, never permission to
      // stop the replacement worker. Release of an old effect is a separate,
      // explicit operation; do not infer authority over a newer generation.
      if (request.kind === "takeover" && prior.decision.kind === "takeover") {
        if (request.owner !== prior.decision.owner || request.leaseExpiresAt !== prior.decision.leaseExpiresAt) fail("DECISION_CONFLICT");
        if (snapshot.run.generation === prior.snapshot.run.generation + 1 && snapshot.run.leaseOwner === prior.decision.owner) {
          return { exit: "takeover", result: { run: snapshot.run, action: snapshot.action, record: prior, changed: false } };
        }
      }
      fail("RECOVERY_GENERATION_CHANGED");
    }
    const proof = await this.proof(connection, registration, snapshot);
    let decision: GraphRecoveryDecision;
    if (request.kind === "effect") {
      const received = structuredClone(await registration.verifyOutcome(structuredClone(snapshot)));
      // Match storage normalization on replay: invalid usage means unknown usage,
      // while the physical outcome/result remains durable and immutable.
      const verdict = received && received.outcome !== "unknown" &&
        (typeof received.actualTokens !== "number" || !Number.isSafeInteger(received.actualTokens) || received.actualTokens < 0)
        ? { ...received, actualTokens: null } : received;
      this.check(connection, registration, snapshot);
      decision = { kind: "effect", receiptId: request.receiptId, verdict };
    } else if (request.kind === "project") decision = { kind: "project", receiptId: request.receiptId, status: request.status };
    else decision = { kind: "takeover", receiptId: request.receiptId, owner: request.owner, leaseExpiresAt: request.leaseExpiresAt };
    // Proof time includes outcome verification, but no snapshot revision is refreshed.
    proof.verifiedAt = this.now();
    let result: GraphRecoveryResult;
    if (prior) {
      if (canonical(prior.decision) !== canonical(decision)) fail("DECISION_CONFLICT");
      result = this.verified(connection, registration, snapshot, proof, decision, () => this.store.verifyDecision(snapshot, request.receiptId, proof, this.now()));
    } else result = this.verified(connection, registration, snapshot, proof, decision, () => this.store.commit(snapshot, decision, proof, this.now()));
    const exit = decision.kind === "effect" ? decision.verdict.outcome : decision.kind === "project" ? "projected" : "takeover";
    if (exit === "unknown" || decision.kind !== "effect") return { exit, result };
    // Decision is already durable. Release failure never rolls back physical truth.
    try { await this.release(connection, registration, result); }
    catch (error) { return { exit: "release_pending", result, releaseError: error instanceof Error ? error.message : "release failed" }; }
    return { exit, result };
  }
}
