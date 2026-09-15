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

/** Immutable lifecycle permits, not node state. Only the host can authorize a
 * subsequent epoch from an attested, published negative quality join. */
export class GraphDeliveryEpochStore {
  constructor(private readonly db: Database.Database) {}
  activate(input: GraphRunFence, epoch: number, cost: { actions: number; tokens: number }, joinRef?: string): GraphRun {
    return fencedGraphTransaction(this.db, input, run => {
      if (!run.spec || run.status !== 'running') throw Error('RUN_NOT_RUNNING');
      const state = readGraphActionState(this.db, run.graphRunId);
      if (state.actions.some(a => ['intent','running','unknown','cancel_pending'].includes(a.state))) throw Error('UNRESOLVED_ACTION');
      if (this.db.prepare('SELECT 1 FROM graph_action_admissions WHERE graph_run_id=? AND released_at IS NULL').get(run.graphRunId)) throw Error('ADMISSION_RELEASE_PENDING');
      const row = this.db.prepare('SELECT max(epoch) AS epoch FROM graph_delivery_epochs WHERE graph_run_id=?').get(run.graphRunId) as { epoch: number | null };
      if (row.epoch === epoch) {
        const prior = this.db.prepare('SELECT join_ref FROM graph_delivery_epochs WHERE graph_run_id=? AND epoch=?').get(run.graphRunId, epoch) as { join_ref: string | null };
        if (prior.join_ref !== (joinRef ?? null)) throw Error('EPOCH_PERMIT_CONFLICT');
        return { changed: false, value: undefined };
      }
      if (epoch !== (row.epoch ?? -1) + 1 || epoch >= run.spec.limits.maxEpochs) throw Error('EPOCH_MISMATCH');
      if (epoch === 0 && (joinRef || state.actions.length)) throw Error('INITIAL_EPOCH_ALREADY_CONSUMED');
      if (epoch > 0) {
        const saved = this.db.prepare('SELECT bundle_json,epoch FROM graph_verification_joins WHERE graph_run_id=? AND receipt_ref=?').get(run.graphRunId, joinRef) as { bundle_json: string; epoch: number } | undefined;
        if (!saved || saved.epoch !== epoch - 1) throw Error('IMMUTABLE_JOIN_REQUIRED');
        const bundle = JSON.parse(saved.bundle_json);
        if (bundle.status !== 'complete' || bundle.branches.length !== 2 || !bundle.branches.every((b: { state: string }) => b.state === 'confirmed')
          || !bundle.branches.some((b: { result: { verdict?: string; passed?: boolean } }) => b.result.verdict === 'changes_requested' || b.result.passed === false)) throw Error('NEGATIVE_JOIN_REQUIRED');
        for (const branch of bundle.branches) {
          const latest = state.actions.filter(a => a.effect.epoch === epoch - 1 && a.effect.nodeId === branch.nodeId && a.effect.effectSlot === branch.effectSlot).sort((a,b) => b.effect.logicalAttempt - a.effect.logicalAttempt)[0];
          if (!latest || latest.effectKey !== branch.effectKey || latest.state !== 'confirmed' || latest.outcome?.state !== 'confirmed' || workerCanonical(latest.outcome.result) !== workerCanonical(branch.result)) throw Error('STALE_JOIN');
        }
      }
      if (!Number.isSafeInteger(cost.actions) || cost.actions < 1 || !Number.isSafeInteger(cost.tokens) || cost.tokens < 0) throw Error('INVALID_COMPILED_COST');
      const budget = state.budget;
      if (input.now - run.createdAt >= run.spec.limits.deadlineSeconds * 1000 || budget.accountingBlocked
        || budget.actionStarts + cost.actions > run.spec.limits.maxActionStarts
        || BigInt(budget.chargedTokens) + BigInt(budget.reservedTokens) + BigInt(cost.tokens) > BigInt(run.spec.limits.tokenReservationLimit)) throw Error('BUDGET_EXHAUSTED');
      this.db.prepare('INSERT INTO graph_delivery_epochs(graph_run_id,epoch,join_ref,generation,created_at) VALUES(?,?,?,?,?)').run(run.graphRunId, epoch, joinRef ?? null, run.generation, input.now);
      return { changed: true, value: undefined };
    }).run;
  }
}
