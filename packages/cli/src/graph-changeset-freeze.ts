import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { GraphActionStore, GraphRunStore, type GraphRunFence } from '@osstack/core';
import type { GraphArtifactStore, GraphFreezeAuthority, GraphFreezeInput } from '@osstack/core/graph-artifacts';
import type { GraphInvocationEvidenceStore, GraphInvocationEvidenceBinding } from '@osstack/core/graph-invocation-evidence';
import { freezeWorkerData, workerCanonical } from '@osstack/protocol';

/** A terminal HTTP response proves only the provider stopped. The caller must
 * independently hold the canonical writer lease, authenticate registration and
 * current grant, and exclude every physical producer through publication. */
export type GraphChangesetFreezeAuthority = Omit<GraphFreezeAuthority, 'verifyImplementationReceipt' | 'expectedTrees'>;

/** Experimental host bridge. A private artifact alone is never a committed apply
 * receipt. Re-read the fenced ledger and immutable evidence at each freeze check.
 * Requires the original implementation admission to remain held through freeze.
 * No lease acquisition/release, automatic recovery, or production registration. */
export async function freezeGraphChangeset(options: {
  db: Database.Database; evidence: GraphInvocationEvidenceStore; artifacts: GraphArtifactStore;
  input: GraphFreezeInput; fence: GraphRunFence; effectKey: string;
  authority: GraphChangesetFreezeAuthority; now?: () => number;
}) {
  const { db, evidence, artifacts, effectKey } = options;
  const input = freezeWorkerData(structuredClone(options.input));
  const pinned = freezeWorkerData(structuredClone(options.fence));
  const authority = Object.freeze({ ...options.authority });
  const now = options.now ?? Date.now;
  const actions = new GraphActionStore(db); const runs = new GraphRunStore(db);
  const verify = () => {
    if (db.inTransaction || db.pragma('journal_mode', { simple: true }) !== 'wal'
      || ![2, 3].includes(Number(db.pragma('synchronous', { simple: true })))) throw Error('CHANGESET_DURABILITY_REQUIRED');
    const run = runs.get(pinned.scope, pinned.graphRunId); if (!run) throw Error('RUN_NOT_FOUND');
    const fence = { ...pinned, expectedRevision: run.revision, now: now() };
    const { action, budget } = actions.get(fence, effectKey);
    const checkAdmission = () => {
      const held = db.prepare("SELECT graph_run_id,generation,owner,released_at FROM graph_action_admissions WHERE effect_key=?").get(effectKey) as
        { graph_run_id: string; generation: number; owner: string; released_at: number | null } | undefined;
      if (!held || held.graph_run_id !== pinned.graphRunId || held.generation !== pinned.expectedGeneration
        || held.owner !== pinned.expectedOwner || held.released_at !== null) throw Error('FREEZE_ADMISSION_REQUIRED');
    };
    checkAdmission();
    const apply = actions.getApply(fence, effectKey).apply;
    const invocation = actions.getInvocation(fence, effectKey).invocation;
    if (input.runId !== pinned.graphRunId || input.generation !== pinned.expectedGeneration || input.owner !== pinned.expectedOwner
      || workerCanonical(input.scope) !== workerCanonical(pinned.scope) || action.generation !== pinned.expectedGeneration
      || action.state !== 'confirmed' || action.outcome?.state !== 'confirmed'
      || !['implement', 'repair'].includes(action.action.kind) || action.outcome.result.kind !== 'implementation_complete'
      || action.outcome.result.workspaceLeaseRef !== input.workspaceLeaseRef
      || action.outcome.result.receiptRef !== input.implementationReceiptRef || action.outcome.evidenceRef !== input.implementationReceiptRef
      || apply?.resolution?.kind !== 'applied' || apply.resolution.evidenceRef !== input.implementationReceiptRef
      || (action.action.kind === 'implement' && input.baseRevision !== invocation?.request.baseRevision)
      || (action.action.kind === 'repair' && input.baseRevision !== action.action.candidateRevision)
      || invocation?.request.programDigest !== pinned.identity.compiledProgramDigest
      || invocation?.response?.disposition !== 'proposal' || invocation.response.stopEvidenceRef !== input.producerStopEvidenceRef
      || budget.accountingBlocked || run.status === 'cancel_pending' || run.status === 'reconciliation_required'
      || (run.spec && now() - run.createdAt >= run.spec.limits.deadlineSeconds * 1000)) throw Error('FREEZE_APPLY_BINDING');
    const binding = (kind: GraphInvocationEvidenceBinding['kind']): GraphInvocationEvidenceBinding => ({ schemaVersion: 1,
      scope: pinned.scope, runId: pinned.graphRunId, generation: pinned.expectedGeneration, effectKey, requestDigest: invocation.request.requestDigest, kind });
    const proof = JSON.parse(evidence.read(input.implementationReceiptRef, binding('apply_complete')).toString('utf8'));
    const journalBytes = evidence.read(apply.intent.journalRef, binding('apply_journal'));
    const journal = JSON.parse(journalBytes.toString('utf8'));
    const terminal = JSON.parse(evidence.read(input.producerStopEvidenceRef, binding('terminal')).toString('utf8'));
    const journalDigest = createHash('sha256').update('osstack.apply-journal.v1\n').update(journalBytes).digest('hex');
    const st = lstatSync(input.worktreePath);
    if ([proof, journal, terminal].some(value => !value || typeof value !== 'object' || Array.isArray(value))) throw Error('FREEZE_APPLY_EVIDENCE');
    if (proof.schemaVersion !== 1 || proof.kind !== 'apply_complete' || proof.journalDigest !== journalDigest
      || proof.journalRef !== apply.intent.journalRef || proof.treeRevision !== apply.resolution.treeRevision
      || proof.proposalDigest !== apply.intent.proposalDigest || proof.actualTokens !== apply.resolution.actualTokens
      || proof.providerTerminalRef !== input.producerStopEvidenceRef || journalDigest !== apply.intent.journalDigest
      || journal.schemaVersion !== 1 || journal.beforeTreeRevision !== apply.intent.beforeTreeRevision
      || journal.targetTreeRevision !== apply.intent.targetTreeRevision || journal.targetTreeRevision !== proof.treeRevision
      || journal.manifestDigest !== invocation.request.manifestDigest || journal.proposalDigest !== proof.proposalDigest
      || !st.isDirectory() || st.isSymbolicLink() || journal.workspaceIdentity?.dev !== st.dev || journal.workspaceIdentity?.ino !== st.ino
      || terminal.schemaVersion !== 1 || terminal.provider !== invocation.request.provider || terminal.model !== invocation.request.model
      || terminal.responseRef !== invocation.response.evidenceRef || terminal.responseDigest !== invocation.response.responseDigest
      || terminal.kind !== 'provider_terminal' || terminal.disposition !== 'proposal' || terminal.budgetExceeded !== false
      || terminal.requestDigest !== invocation.request.requestDigest || terminal.proposalDigest !== proof.proposalDigest
      || terminal.actualTokens !== proof.actualTokens) throw Error('FREEZE_APPLY_EVIDENCE');
    for (const field of ['runId', 'effectKey', 'generation', 'baseRevision', 'treeRevision', 'profileDigest', 'grantDigest', 'programDigest', 'policyDigest'] as const) {
      if (journal.binding?.[field] !== invocation.request[field]) throw Error('FREEZE_APPLY_EVIDENCE');
    }
    // Core reads own BEGIN IMMEDIATE transactions and reject nesting. Receipt
    // rows are immutable; validate the SAME revision again after evidence I/O,
    // and recheck admission (its release does not advance the run revision).
    actions.get({ ...fence, now: now() }, effectKey); checkAdmission();
    return { base: apply.intent.beforeTreeRevision, candidate: apply.resolution.treeRevision };
  };
  const expectedTrees = verify();
  const checked = async (fn: () => void | Promise<void>) => {
    verify(); if (await fn() !== undefined) throw Error('FREEZE_AUTHORITY'); verify();
  };
  return artifacts.freeze(input, { lease: authority.lease, expectedTrees,
    verifyImplementationReceipt: () => { verify(); },
    verifyProducersStopped: current => checked(() => authority.verifyProducersStopped(current)),
    verifyLease: (current, lease) => checked(() => authority.verifyLease(current, lease)),
  });
}
