import { graphChecksPassed } from './graph-check-suite.js';
import type Database from 'better-sqlite3';
import type { GraphAction, GraphRunFence } from '@osstack/core';
import { GraphVerificationStore, type GraphVerificationSnapshot, type GraphVerificationRecord } from '@osstack/core/graph-verification';
import type { GraphArtifactStore } from '@osstack/core/graph-artifacts';
import { GraphError, GraphResult, freezeWorkerData } from '@osstack/protocol';
import { joinVerificationBranches, type VerificationJoin } from '@osstack/graph/join';
import { routeVerification, type VerificationRoutingState, type VerificationRoute } from '@osstack/graph/route';
import { parseVerificationBinding, verificationCanonical, type VerificationBinding, type VerificationBranch } from '@osstack/graph/nodes/branch';
import { loadGraphVerificationEvidence } from './graph-verification-store.js';
type Kind = 'review' | 'tests';
export interface GraphVerificationJoinOptions {
  binding: VerificationBinding; evidenceRoot: string; artifacts: GraphArtifactStore;
  slots: Record<Kind, { nodeId: string; effectSlot: string }>;
  nextCost: VerificationRoutingState['nextCost'];
  authorize: () => void;
}
export interface GraphVerificationDecision {
  joined: VerificationJoin; route: VerificationRoute; snapshot: GraphVerificationSnapshot;
  publication?: { record: GraphVerificationRecord; created: boolean };
}
/** Host-only, latest-ledger recomputation. Worker task RETURNs are deliberately
 * not an input. A route is a recommendation, never an execution/retry grant.
 * The caller must stop/drain the old worker before recovery and use a new fence. */
export class GraphVerificationJoinService {
  private readonly options: Omit<GraphVerificationJoinOptions, 'artifacts' | 'authorize'>;
  private readonly authorize: () => void;
  private readonly verifyArtifact: GraphArtifactStore['verify'];
  constructor(private readonly db: Database.Database, options: GraphVerificationJoinOptions) {
    this.options = freezeWorkerData(structuredClone({ binding: parseVerificationBinding(options.binding), evidenceRoot: options.evidenceRoot,
      slots: options.slots, nextCost: options.nextCost }));
    this.authorize = options.authorize; this.verifyArtifact = options.artifacts.verify.bind(options.artifacts);
  }
  private check(): void {
    const value: unknown = this.authorize();
    if (value !== undefined) { void Promise.resolve(value).catch(() => {}); throw Error('authority must be synchronous'); }
  }
  async evaluate(fenceValue: GraphRunFence, now: () => number = Date.now): Promise<GraphVerificationDecision> {
    this.check(); const fence = freezeWorkerData(structuredClone(fenceValue));
    let attested: { digest: string; joined: VerificationJoin } | undefined;
    const store = new GraphVerificationStore(this.db, (snapshot, value) => {
      this.check();
      if (!attested || snapshot.digest !== attested.digest || verificationCanonical(value) !== verificationCanonical(attested.joined)) throw Error('JOIN_ATTESTATION_MISMATCH');
    });
    const snapshot = store.snapshot(fence); const { binding, slots } = this.options;
    if (binding.graphRunId !== snapshot.run.graphRunId || binding.specHash !== snapshot.run.identity.specHash
      || verificationCanonical(binding.scope) !== verificationCanonical(snapshot.run.scope) || !snapshot.run.spec
      || binding.acceptanceRef !== snapshot.run.spec.input.acceptanceRef || binding.epoch >= snapshot.run.spec.limits.maxEpochs) throw Error('JOIN_BINDING_MISMATCH');
    const manifest = await this.verifyArtifact(binding.artifactDigest); this.check();
    if (manifest.candidateRevision !== binding.candidateRevision || manifest.input.runId !== binding.graphRunId
      || verificationCanonical(manifest.input.scope) !== verificationCanonical(binding.scope)) throw Error('JOIN_ARTIFACT_MISMATCH');
    const latest = (kind: Kind): GraphAction | undefined => snapshot.actions.filter(a => a.effect.epoch === binding.epoch
      && a.effect.nodeId === slots[kind].nodeId && a.effect.effectSlot === slots[kind].effectSlot).sort((a,b) => b.effect.logicalAttempt - a.effect.logicalAttempt)[0];
    const selected = { review: latest('review'), tests: latest('tests') };
    const expected = { review: { ...slots.review, logicalAttempt: selected.review?.effect.logicalAttempt ?? 0 },
      tests: { ...slots.tests, logicalAttempt: selected.tests?.effect.logicalAttempt ?? 0 } };
    const branches: VerificationBranch[] = [];
    for (const kind of ['review','tests'] as const) {
      const action = selected[kind]; if (!action) continue;
      if (action.action.kind !== kind || !('candidateRevision' in action.action) || action.action.candidateRevision !== binding.candidateRevision
        || (action.action.kind === 'review' ? action.action.acceptanceRef : action.action.kind === 'tests' ? action.action.commandSpecRef : '') !== binding.acceptanceRef) throw Error('JOIN_ACTION_MISMATCH');
      const base = { schemaVersion: 1 as const, binding, kind, nodeId: action.effect.nodeId, effectSlot: action.effect.effectSlot,
        logicalAttempt: action.effect.logicalAttempt, effectKey: action.effectKey };
      if (action.state === 'confirmed' || action.state === 'failed') {
        const outcome = action.outcome; if (!outcome || outcome.state !== action.state) throw Error('JOIN_OUTCOME_MISMATCH');
        // Pre-admission/policy failures lack a verification receipt and cannot be
        // promoted to retryable structured review/code results.
        if (outcome.state === 'failed' && !outcome.evidenceRef.startsWith('graph-verification:')) {
          const parsed = GraphError.safeParse(outcome.error);
          const error = parsed.success && !parsed.data.retryable ? parsed.data : GraphError.parse({ schemaVersion: 1, code: 'POLICY_DENIED',
            message: 'Stopped action has no attested verification report; host must inspect admission/execution failure', retryable: false, nextAction: 'stop' });
          branches.push({ ...base, state: 'failed', error }); continue;
        }
        const envelope = await loadGraphVerificationEvidence(this.options.evidenceRoot, outcome.evidenceRef, binding, { effect: action.effect, effectKey: action.effectKey }); this.check();
        if (envelope.kind !== kind || envelope.nodeId !== action.effect.nodeId || envelope.effectSlot !== action.effect.effectSlot
          || envelope.workspaceLeaseRef !== action.action.workspaceLeaseRef) throw Error('JOIN_EVIDENCE_MISMATCH');
        if (outcome.state === 'confirmed') {
          if (envelope.verificationFailure) throw Error('JOIN_FAILED_EVIDENCE');
          const result = GraphResult.parse({ schemaVersion: 1, kind, candidateRevision: binding.candidateRevision,
            evidenceRefs: [outcome.evidenceRef], evidenceDigest: outcome.evidenceRef.slice('graph-verification:'.length),
            ...(kind === 'review' ? { verdict: envelope.report!.verdict } : { passed: graphChecksPassed(envelope) }) });
          if (verificationCanonical(outcome.result) !== verificationCanonical(result)) throw Error('JOIN_RESULT_MISMATCH');
          branches.push({ ...base, state: 'confirmed', result });
        } else {
          const failure = envelope.verificationFailure;
          // A cancelled settlement can retain a valid receipt yet have no G19
          // classification. Preserve the ledger failure instead of promoting the
          // receipt's code verdict, and leave host retry policy to G21.
          const error = failure ? GraphError.parse(outcome.error) : GraphError.parse({ schemaVersion: 1, code: 'INTERNAL_ERROR',
            message: 'Stopped invocation has no retryable verification classification', retryable: false, nextAction: 'stop' });
          if (failure && (error.code !== failure.code || error.message !== failure.message || error.retryable !== failure.retrySafe || outcome.retrySafe !== failure.retrySafe)) throw Error('JOIN_FAILURE_MISMATCH');
          branches.push({ ...base, state: 'failed', error });
        }
      } else {
        const cancelling = action.state === 'cancel_pending';
        branches.push({ ...base, state: cancelling ? 'cancel_pending' : 'unknown', error: { schemaVersion: 1, code: cancelling ? 'CANCEL_UNCONFIRMED' : 'ACTION_OUTCOME_UNKNOWN',
          message: 'Ledger execution requires reconciliation', retryable: false, nextAction: 'reconcile' } });
      }
    }
    // Reject races after asynchronous evidence reads without refreshing away the
    // premise that was verified. Admission releases may change without revision.
    this.check(); const time = now(); const current = store.snapshot({ ...fence, now: time });
    if (current.digest !== snapshot.digest) throw Error('VERIFICATION_SNAPSHOT_CHANGED');
    const joined = joinVerificationBranches({ binding, expected, branches }, branch => {
      if (!branches.some(original => verificationCanonical(branch) === verificationCanonical(original))) throw Error('JOIN_BRANCH_MISMATCH');
    });
    const spent = (kind: Kind) => selected[kind] ? 1 + snapshot.actions.filter(a => a.effect.epoch === binding.epoch
      && a.effect.nodeId === slots[kind].nodeId && a.effect.logicalAttempt > 1).length : 0;
    const route = routeVerification(joined, { binding, spec: snapshot.run.spec, runStatus: snapshot.run.status, runCreatedAt: snapshot.run.createdAt, now: time,
      ...snapshot.budget, pendingAdmissions: snapshot.pendingAdmissions, unresolvedActions: snapshot.unresolvedActions,
      branchAttemptsSpent: { review: spent('review'), tests: spent('tests') }, nextCost: this.options.nextCost });
    if (joined.status !== 'complete' || snapshot.unresolvedActions || snapshot.pendingAdmissions || snapshot.run.status !== 'running') return freezeWorkerData({ joined, route, snapshot });
    attested = { digest: snapshot.digest, joined };
    const committed = store.commit(snapshot, joined, time);
    return freezeWorkerData({ joined, route, snapshot: store.snapshot({ ...fence, expectedRevision: committed.run.revision, now: time }),
      publication: { record: committed.record, created: committed.created } });
  }
}
