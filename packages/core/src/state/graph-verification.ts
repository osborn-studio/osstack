import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { GraphJsonValue, GraphResult, freezeWorkerData, workerCanonical } from '@osstack/protocol';
import type { GraphAction, GraphActionBudget } from './graph-actions.js';
import { readGraphActionState } from './graph-actions.js';
import { fencedGraphTransaction } from './graph-storage.js';
import type { GraphRun, GraphRunFence } from './graph-runs.js';
export interface GraphVerificationSnapshot {
  run: GraphRun; actions: GraphAction[]; budget: GraphActionBudget;
  pendingAdmissions: number; unresolvedActions: number; digest: string;
}
export interface GraphVerificationRecord {
  receiptRef: string; graphRunId: string; epoch: number; candidateRevision: string;
  generation: number; owner: string; bundle: GraphJsonValue; createdAt: number;
}
const hash = (value: unknown) => createHash('sha256').update(workerCanonical(value)).digest('hex');
function fence(run: GraphRun, now: number): GraphRunFence {
  return { scope: run.scope, graphRunId: run.graphRunId, identity: run.identity, expectedGeneration: run.generation,
    expectedOwner: run.leaseOwner, expectedRevision: run.revision, now };
}
/** A durable immutable evidence publication, not an epoch scheduler or node FSM.
 * The trusted host verifier must bind the bundle to current ledger attempts and
 * independent artifact/executor evidence. No worker JSON port calls this store. */
export class GraphVerificationStore {
  constructor(private readonly db: Database.Database,
    private readonly verify: (snapshot: GraphVerificationSnapshot, bundle: GraphJsonValue) => void) {}
  private capture(run: GraphRun): GraphVerificationSnapshot {
    const state = readGraphActionState(this.db, run.graphRunId);
    const admissions = this.db.prepare('SELECT effect_key,released_at FROM graph_action_admissions WHERE graph_run_id=? ORDER BY effect_key').all(run.graphRunId) as Array<{ effect_key: string; released_at: number | null }>;
    const body = { run, ...state, pendingAdmissions: admissions.filter(a => a.released_at === null).length,
      unresolvedActions: state.actions.filter(a => ['intent','running','unknown','cancel_pending'].includes(a.state)).length };
    return freezeWorkerData({ ...body, digest: hash({ body, admissions }) });
  }
  snapshot(input: GraphRunFence): GraphVerificationSnapshot {
    return fencedGraphTransaction(this.db, input, run => ({ changed: false, value: this.capture(run) })).value;
  }
  commit(snapshotValue: GraphVerificationSnapshot, bundleValue: unknown, now: number): { record: GraphVerificationRecord; created: boolean; run: GraphRun } {
    const snapshot = freezeWorkerData(structuredClone(snapshotValue)); const bundle = freezeWorkerData(GraphJsonValue.parse(bundleValue));
    const result = fencedGraphTransaction(this.db, fence(snapshot.run, now), run => {
      const current = this.capture(run);
      if (current.digest !== snapshot.digest || workerCanonical(current) !== workerCanonical(snapshot)) throw Error('VERIFICATION_SNAPSHOT_CHANGED');
      if (current.unresolvedActions) throw Error('UNRESOLVED_ACTION');
      if (current.pendingAdmissions) throw Error('ADMISSION_RELEASE_PENDING');
      if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw Error('INVALID_JOIN');
      const object = bundle as Record<string, GraphJsonValue>; const binding = object.binding;
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw Error('INVALID_JOIN_BINDING');
      const b = binding as Record<string, GraphJsonValue>;
      const candidate = GraphResult.parse({ schemaVersion: 1, kind: 'candidate_ready', candidateRevision: b.candidateRevision, artifactDigest: b.artifactDigest, artifactRefs: ['join-validation'] });
      if (candidate.kind !== 'candidate_ready' || object.schemaVersion !== 1 || object.status !== 'complete'
        || b.graphRunId !== run.graphRunId || workerCanonical(b.scope) !== workerCanonical(run.scope) || b.specHash !== run.identity.specHash
        || !Number.isSafeInteger(b.epoch) || (b.epoch as number) < 0 || (b.epoch as number) >= (run.spec?.limits.maxEpochs ?? 0)
        || b.acceptanceRef !== run.spec?.input.acceptanceRef || typeof object.evidenceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(object.evidenceDigest)) throw Error('INVALID_JOIN_BINDING');
      if (typeof this.verify !== 'function') throw Error('trusted verifier required');
      const verified: unknown = this.verify(current, bundle);
      if (verified !== undefined) { void Promise.resolve(verified).catch(() => {}); throw Error('join verifier must be synchronous'); }
      const receiptRef = `graph-join:${hash(binding)}`;
      const saved = this.db.prepare('SELECT bundle_json,generation,owner,created_at,receipt_ref FROM graph_verification_joins WHERE graph_run_id=? AND epoch=? AND candidate_revision=?')
        .get(run.graphRunId, b.epoch, candidate.candidateRevision) as { bundle_json: string; generation: number; owner: string; created_at: number; receipt_ref: string } | undefined;
      if (saved && (saved.bundle_json !== workerCanonical(bundle) || saved.receipt_ref !== receiptRef)) throw Error('JOIN_PUBLICATION_CONFLICT');
      if (!saved) this.db.prepare('INSERT INTO graph_verification_joins(receipt_ref,graph_run_id,epoch,candidate_revision,generation,owner,bundle_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(receiptRef, run.graphRunId, b.epoch, candidate.candidateRevision, run.generation, run.leaseOwner, workerCanonical(bundle), now);
      const record: GraphVerificationRecord = { receiptRef, graphRunId: run.graphRunId, epoch: b.epoch as number, candidateRevision: candidate.candidateRevision,
        generation: saved?.generation ?? run.generation, owner: saved?.owner ?? run.leaseOwner!, bundle, createdAt: saved?.created_at ?? now };
      return { changed: !saved, value: { record, created: !saved } };
    });
    return freezeWorkerData({ ...result.value, run: result.run });
  }
}
