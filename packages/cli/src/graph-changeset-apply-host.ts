import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { GraphActionStore, GraphRunStore, type GraphAction, type GraphRunFence } from '@osstack/core';
import type { GraphInvocationEvidenceStore, GraphInvocationEvidenceBinding } from '@osstack/core/graph-invocation-evidence';
import { freezeWorkerData, workerCanonical } from '@osstack/protocol';
import { validateChangesetProposal } from '@osstack/agents/experimental/changeset';
import { changesetResponseDigest } from '@osstack/agents/experimental/changeset-client';
import { applyGraphChangeset, type GraphApplyInput, type GraphApplyProof, type GraphApplyResult } from './graph-apply-changeset.js';

export interface GraphChangesetApplyOptions {
  /** Trusted synchronous check of real workspace registration/exclusive physical
   * lease, profile, grant and current run identity. Not an RPC callback. */
  verify: (context: { workspace: string; fence: GraphRunFence; action: GraphAction }) => unknown;
  now?: () => number;
}
/** Experimental connection of the physical applier to durable host evidence and
 * fenced SQLite ledger. No production enrollment, lease release, cleanup or
 * automatic unknown reconciliation. Requires the stopped provider receipt that
 * GraphChangesetInvocationHost persisted; arbitrary proposal digests grant nothing. */
export class GraphChangesetApplyHost {
  constructor(private readonly db: Database.Database, private readonly evidence: GraphInvocationEvidenceStore,
    private readonly options: GraphChangesetApplyOptions) {}
  apply(input: GraphApplyInput, rawFence: GraphRunFence): GraphApplyResult {
    input = freezeWorkerData(structuredClone(input));
    const pinned = freezeWorkerData(structuredClone(rawFence));
    const validated = validateChangesetProposal(input.proposal, input.manifest, input.policy, input.binding);
    const key = validated.manifest.binding.effectKey;
    const actions = new GraphActionStore(this.db); const runs = new GraphRunStore(this.db);
    const now = this.options.now ?? Date.now;
    const durable = () => {
      if (this.db.inTransaction || this.db.pragma('journal_mode', { simple: true }) !== 'wal'
        || ![2, 3].includes(Number(this.db.pragma('synchronous', { simple: true })))) throw Error('CHANGESET_DURABILITY_REQUIRED');
    };
    const fence = () => {
      const run = runs.get(pinned.scope, pinned.graphRunId); if (!run) throw Error('RUN_NOT_FOUND');
      return { ...pinned, expectedRevision: run.revision, now: now() };
    };
    durable();
    const saved = actions.getInvocation(fence(), key).invocation;
    if (saved?.response?.disposition !== 'proposal' || saved.response.proposalDigest !== validated.proposalDigest
      || saved.request.manifestDigest !== validated.manifestDigest) throw Error('APPLY_INVOCATION_BINDING');
    for (const [field, value] of Object.entries(validated.manifest.binding)) {
      if (saved.request[field as keyof typeof saved.request] !== value) throw Error('APPLY_INVOCATION_BINDING');
    }
    const evidenceBinding = (kind: GraphInvocationEvidenceBinding['kind']): GraphInvocationEvidenceBinding => ({ schemaVersion: 1,
      scope: pinned.scope, runId: pinned.graphRunId, effectKey: key, generation: pinned.expectedGeneration, requestDigest: saved.request.requestDigest, kind });
    const responseBytes = this.evidence.read(saved.response.evidenceRef, evidenceBinding('response'));
    if (changesetResponseDigest(responseBytes) !== saved.response.responseDigest) throw Error('APPLY_RESPONSE_BINDING');
    const terminal = JSON.parse(this.evidence.read(saved.response.stopEvidenceRef, evidenceBinding('terminal')).toString('utf8')) as Record<string, unknown>;
    if (terminal.schemaVersion !== 1 || terminal.kind !== 'provider_terminal' || terminal.disposition !== 'proposal' || terminal.budgetExceeded !== false
      || terminal.proposalDigest !== validated.proposalDigest || terminal.requestDigest !== saved.request.requestDigest
      || terminal.responseDigest !== saved.response.responseDigest || terminal.responseRef !== saved.response.evidenceRef
      || terminal.provider !== saved.request.provider || terminal.model !== saved.request.model
      || typeof terminal.requestRef !== 'string' || typeof terminal.actualTokens !== 'number'
      || !Number.isSafeInteger(terminal.actualTokens) || terminal.actualTokens < 0) throw Error('APPLY_TERMINAL_BINDING');
    const actualTokens = terminal.actualTokens;
    const request = JSON.parse(this.evidence.read(terminal.requestRef, evidenceBinding('request')).toString('utf8')) as Record<string, unknown>;
    const { requestDigest, ...requestBody } = request;
    const digest = createHash('sha256').update('osstack.changeset-client.request.v1\n').update(workerCanonical(requestBody)).digest('hex');
    if (requestDigest !== saved.request.requestDigest || digest !== requestDigest || request.manifestDigest !== validated.manifestDigest
      || workerCanonical(request.binding) !== workerCanonical(validated.manifest.binding)) throw Error('APPLY_REQUEST_BINDING');
    const held = () => {
      const row = this.db.prepare('SELECT graph_run_id,generation,owner,released_at FROM graph_action_admissions WHERE effect_key=?').get(key) as
        { graph_run_id: string; generation: number; owner: string; released_at: number | null } | undefined;
      if (!row || row.graph_run_id !== pinned.graphRunId || row.generation !== pinned.expectedGeneration || row.owner !== pinned.expectedOwner || row.released_at !== null) throw Error('APPLY_ADMISSION_REQUIRED');
    };
    const authorize = () => {
      durable(); held(); const currentFence = fence(); const current = actions.get(currentFence, key);
      if (current.action.state !== 'running' || current.run.status === 'cancel_pending' || current.run.status === 'reconciliation_required'
        || current.budget.accountingBlocked || current.action.reservationTokens < actualTokens) throw Error('APPLY_ACTION_STATE');
      if (current.run.spec && now() - current.run.createdAt >= current.run.spec.limits.deadlineSeconds * 1000) throw Error('APPLY_DEADLINE');
      const result = this.options.verify(freezeWorkerData(structuredClone({ workspace: input.workspace, fence: currentFence, action: current.action })));
      if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw Error('APPLY_AUTHORITY'); }
      durable(); held();
      // Refresh both deadline and lease fence after a slow verifier.
      const authorizedFence = fence(); const after = actions.get(authorizedFence, key);
      if (after.action.state !== 'running' || after.run.status === 'cancel_pending' || after.run.status === 'reconciliation_required'
        || (after.run.spec && now() - after.run.createdAt >= after.run.spec.limits.deadlineSeconds * 1000)) throw Error('APPLY_ACTION_STATE');
      return authorizedFence;
    };
    const putProof = (kind: 'apply_complete' | 'apply_quarantine', proof: GraphApplyProof) => this.evidence.put(evidenceBinding(kind),
      Buffer.from(workerCanonical({ schemaVersion: 1, kind, ...proof, actualTokens, providerTerminalRef: saved.response!.stopEvidenceRef })));
    return applyGraphChangeset(input, {
      authorize: () => { authorize(); },
      journal: (journal) => this.evidence.put(evidenceBinding('apply_journal'), Buffer.from(workerCanonical(journal))),
      begin: (journal, journalDigest, journalRef) => {
        const authorizedFence = authorize();
        if (!this.evidence.read(journalRef, evidenceBinding('apply_journal')).equals(Buffer.from(workerCanonical(journal)))) throw Error('APPLY_JOURNAL_BINDING');
        return actions.beginApply({ ...authorizedFence, now: now() }, key, { schemaVersion: 1, requestDigest: saved.request.requestDigest, proposalDigest: validated.proposalDigest,
          manifestDigest: validated.manifestDigest, beforeTreeRevision: journal.beforeTreeRevision, targetTreeRevision: journal.targetTreeRevision, journalRef, journalDigest }).applyAuthorized;
      },
      complete: proof => {
        authorize(); const evidenceRef = putProof('apply_complete', proof); const authorizedFence = authorize();
        actions.completeApply({ ...authorizedFence, now: now() }, key, { schemaVersion: 1, kind: 'applied', proposalDigest: proof.proposalDigest, journalDigest: proof.journalDigest,
          treeRevision: proof.treeRevision, evidenceRef, actualTokens });
      },
      quarantine: proof => {
        // Revocation prevents new writes, not forensic recording. Core fences
        // identity and immutable resolution; no admission release or downgrade.
        durable(); const evidenceRef = putProof('apply_quarantine', proof);
        actions.quarantineApply(fence(), key, { schemaVersion: 1, kind: 'quarantined', proposalDigest: proof.proposalDigest,
          journalDigest: proof.journalDigest, evidenceRef, observedTokens: actualTokens, cancelled: runs.get(pinned.scope, pinned.graphRunId)?.status === 'cancel_pending' });
      },
    });
  }
}
