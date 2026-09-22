import type Database from 'better-sqlite3';
import { GraphActionStore, GraphRunStore, type GraphAction, type GraphRun, type GraphRunFence } from '@osstack/core';
import type { GraphInvocationEvidenceStore, GraphInvocationEvidenceBinding } from '@osstack/core/graph-invocation-evidence';
import { freezeWorkerData, workerCanonical } from '@osstack/protocol';
import { changesetResponseDigest, createChangesetProposalClient, type ChangesetClientOptions, type ChangesetClientResult, type ChangesetRequestInput, type PreparedChangesetRequest } from '@osstack/agents/experimental/changeset-client';

type Terminal = Extract<ChangesetClientResult, { kind: 'terminal' }>;
export interface GraphChangesetHostOptions {
  client: ChangesetClientOptions;
  /** Trusted synchronous authority. Authenticate grant/profile, exact model and
   * endpoint, physical workspace lease, and token upper-bound evidence against
   * these exact prepared bytes. No worker boolean, heuristic, or async verifier.
   * Called before disclosure storage and again immediately before the DB gate. */
  verify: (request: PreparedChangesetRequest, context: { fence: GraphRunFence; action: GraphAction }) => unknown;
  now?: () => number;
}
export type GraphChangesetHostResult =
  | { kind: 'recorded'; requestRef: string; responseRef: string; terminalRef: string; result: Terminal; run: GraphRun }
  | { kind: 'deferred'; reason: 'authorization_or_storage' | 'not_authorized' | 'transport_uncertain' | 'response_persistence';
      requestRef: string | null; responseRef: string | null; terminalRef: string | null; reconciliationRequired: boolean };

/** Trusted host port, not an RPC or registered executor. Owns no filesystem
 * applier and never releases physical admission. Caller supplies an already
 * reserved action and held canonical admission. FULL WAL is mandatory; this
 * service never silently changes the shared daemon's durability settings. */
export class GraphChangesetInvocationHost {
  private readonly actions: GraphActionStore;
  private readonly runs: GraphRunStore;
  private readonly client: ReturnType<typeof createChangesetProposalClient>;
  private readonly verify: GraphChangesetHostOptions['verify'];
  private readonly now: () => number;
  constructor(private readonly db: Database.Database, private readonly evidence: GraphInvocationEvidenceStore, options: GraphChangesetHostOptions) {
    this.actions = new GraphActionStore(db); this.runs = new GraphRunStore(db);
    this.client = createChangesetProposalClient(options.client); this.verify = options.verify; this.now = options.now ?? Date.now;
  }
  private durable(): void {
    if (this.db.inTransaction || this.db.pragma('journal_mode', { simple: true }) !== 'wal'
      || ![2, 3].includes(Number(this.db.pragma('synchronous', { simple: true })))) throw Error('CHANGESET_DURABILITY_REQUIRED');
  }
  async invoke(input: ChangesetRequestInput, rawFence: GraphRunFence, executionRef: string, signal?: AbortSignal): Promise<GraphChangesetHostResult> {
    let requestRef: string | null = null; let responseRef: string | null = null; let terminalRef: string | null = null;
    let gateAttempted = false; let unresolvedBefore = false; let claimed = false; let result: ChangesetClientResult | undefined;
    const deferred = (reason: Extract<GraphChangesetHostResult, { kind: 'deferred' }>['reason'], reconciliationRequired: boolean): GraphChangesetHostResult =>
      ({ kind: 'deferred', reason, requestRef, responseRef, terminalRef, reconciliationRequired });
    const pinned = freezeWorkerData(structuredClone(rawFence));
    let prepared: PreparedChangesetRequest;
    try {
      this.durable(); prepared = this.client.prepare(input);
      const initial = this.actions.get(pinned, prepared.binding.effectKey).action;
      unresolvedBefore = ['running', 'unknown', 'cancel_pending'].includes(initial.state);
    }
    catch { return deferred('authorization_or_storage', false); }
    const key = prepared.binding.effectKey;
    const fresh = (): GraphRunFence => {
      const run = this.runs.get(pinned.scope, pinned.graphRunId);
      if (!run) throw Error('RUN_NOT_FOUND');
      // Revision may advance while HTTP runs, but authority never follows a new owner/generation.
      return { ...pinned, expectedRevision: run.revision, now: this.now() };
    };
    const binding = (kind: GraphInvocationEvidenceBinding['kind']): GraphInvocationEvidenceBinding => ({ schemaVersion: 1, scope: pinned.scope,
      runId: pinned.graphRunId, effectKey: key, generation: pinned.expectedGeneration, requestDigest: prepared.requestDigest, kind });
    const authorize = () => {
      this.durable(); const fence = fresh(); const action = this.actions.get(fence, key).action;
      const existing = this.actions.getInvocation(fence, key).invocation;
      if (!['intent', 'running'].includes(action.state) || (existing && existing.request.requestDigest !== prepared.requestDigest)) throw Error('CHANGESET_ACTION_STATE');
      if (prepared.binding.runId !== pinned.graphRunId || prepared.binding.generation !== pinned.expectedGeneration
        || prepared.reservationTokens > action.reservationTokens || (action.action.kind !== 'implement' && action.action.kind !== 'repair')) throw Error('CHANGESET_BINDING');
      const verdict = this.verify(prepared, freezeWorkerData(structuredClone({ fence, action })));
      if (verdict !== undefined) { void Promise.resolve(verdict).catch(() => {}); throw Error('CHANGESET_AUTHORITY'); }
      this.durable(); return { fence: { ...fence, now: this.now() }, action };
    };
    const retainUnknown = () => {
      if (!gateAttempted || requestRef === null) return;
      try {
        this.durable(); const fence = fresh(); const saved = this.actions.getInvocation(fence, key).invocation;
        const action = this.actions.get(fence, key).action;
        if (saved?.request.requestDigest !== prepared.requestDigest || !['running', 'unknown', 'cancel_pending'].includes(action.state)) return;
        this.actions.markUncertain(fence, key, { state: signal?.aborted || action.state === 'cancel_pending' ? 'cancel_pending' : 'unknown',
          evidenceRef: terminalRef ?? responseRef ?? requestRef, observedTokens: result?.kind === 'terminal' ? result.actualTokens ?? action.reservationTokens : action.observedTokens });
      } catch { /* DB/lease failure cannot justify release or retry. Retained refs remain inspectable. */ }
    };
    try {
      authorize();
      requestRef = this.evidence.put(binding('request'), Buffer.from(workerCanonical(prepared)));
      result = await this.client.invoke(prepared, () => {
        // The artifact must remain readable and identical before committing dispatch eligibility.
        if (!this.evidence.read(requestRef!, binding('request')).equals(Buffer.from(workerCanonical(prepared)))) throw Error('CHANGESET_REQUEST_EVIDENCE');
        const { fence, action } = authorize();
        gateAttempted = true;
        const start = this.actions.beginInvocation(fence, key, executionRef, { schemaVersion: 1, profile: 'bounded-changeset-v1', ...prepared.binding,
          provider: prepared.provider, model: prepared.model, manifestDigest: prepared.manifestDigest, requestDigest: prepared.requestDigest,
          inputArtifactRef: (action.action as Extract<GraphAction['action'], { kind: 'implement' | 'repair' }>).inputArtifactRef,
          workspaceLeaseRef: (action.action as Extract<GraphAction['action'], { kind: 'implement' | 'repair' }>).workspaceLeaseRef });
        claimed = start.changed; return claimed;
      }, signal);
      if (result.kind === 'not_authorized') return deferred('not_authorized', gateAttempted || unresolvedBefore);
      if (result.kind !== 'terminal') { retainUnknown(); return deferred('transport_uncertain', gateAttempted || unresolvedBefore); }
      if (!claimed) throw Error('CHANGESET_UNCLAIMED_RESPONSE');
      const body = Buffer.from(result.responseBase64, 'base64');
      const rawDigest = changesetResponseDigest(body);
      if (body.toString('base64') !== result.responseBase64 || body.length > 65536 || rawDigest !== result.responseDigest || result.requestDigest !== prepared.requestDigest) throw Error('CHANGESET_RESPONSE_BINDING');
      responseRef = this.evidence.put(binding('response'), body);
      terminalRef = this.evidence.put(binding('terminal'), Buffer.from(workerCanonical({ schemaVersion: 1, kind: 'provider_terminal', requestRef, responseRef,
        requestDigest: prepared.requestDigest, responseDigest: result.responseDigest, provider: prepared.provider, model: prepared.model,
        providerResponseId: result.providerResponseId, disposition: result.disposition, actualTokens: result.actualTokens, budgetExceeded: result.budgetExceeded,
        proposalDigest: result.disposition === 'proposal' ? result.validated!.proposalDigest : null })));
      this.durable();
      const response = { schemaVersion: 1 as const, requestDigest: result.requestDigest, responseDigest: result.responseDigest,
        disposition: result.disposition, proposalDigest: result.disposition === 'proposal' ? result.validated!.proposalDigest : null,
        evidenceRef: responseRef, stopEvidenceRef: terminalRef };
      // Only a rejected revision CAS may retry, bounded to three DB attempts.
      // Network dispatch and evidence publication never run inside this loop.
      for (let attempt = 0; ; attempt++) {
        try {
          this.durable();
          const record = result.disposition === 'proposal' ? this.actions.recordInvocationResponse(fresh(), key, response)
            : this.actions.recordRejectedInvocation(fresh(), key, response, result.actualTokens);
          return { kind: 'recorded', requestRef, responseRef, terminalRef, result, run: record.run };
        } catch (error) {
          if (attempt >= 2 || !(error instanceof Error) || !('code' in error) || error.code !== 'REVISION_CONFLICT') throw error;
        }
      }
    } catch {
      retainUnknown();
      return deferred(result?.kind === 'terminal' ? 'response_persistence' : claimed ? 'transport_uncertain' : 'authorization_or_storage', gateAttempted || unresolvedBefore);
    }
  }
}
