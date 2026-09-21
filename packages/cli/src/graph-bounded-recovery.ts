import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { GraphRunStore, resolveRepositoryScope, type GraphRunFence } from '@osstack/core';
import { GraphRecoveryStore, type GraphExecutorInventory, type GraphRecoveryVerdict } from '@osstack/core/graph-recovery';
import { inspectRepoWriteLock, releaseReconciledRepoWriteLock } from '@osstack/autonomy';
import { workerCanonical } from '@osstack/protocol';
import { compileGraphSpec } from '@osstack/graph/spec-compiler';
import { GraphReconciler } from './graph-reconciler.js';
import { verifyJournaledGraphWorkerExit } from './graph-worker-exit-proof.js';
import { loadDeliveryReceipt } from './graph-delivery-receipts.js';
import { assertBoundedDeliveryReceipt, boundedActionDigest, boundedWorkspaceFingerprint, loadBoundedRecoveryJournal } from './graph-bounded-recovery-journal.js';

const same = (a: unknown, b: unknown) => workerCanonical(a) === workerCanonical(b);
function dead(pid: number): void {
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw Error('BOUNDED_RECOVERY_HOST_UNPROVEN'); }
  throw Error('BOUNDED_RECOVERY_HOST_ALIVE');
}
/** Public cancellation recovery for the first bounded writer only. No execution,
 * takeover, graph resumption, or interpretation of a missing response as stopped.
 * Host-owned receipts attest stopped inference; the workspace fingerprint and
 * exact canonical lock independently bind the preserved local candidate. */
export async function cancelJournaledBoundedWriter(db: Database.Database, root: string, sourcePath: string,
  value: { fence: GraphRunFence; receiptId: string }, authorize: () => void) {
  const input = structuredClone(value); const store = new GraphRecoveryStore(db, () => { throw Error('INSPECTION_ONLY'); });
  const check = () => { const value: unknown = authorize(); if (value !== undefined) { void Promise.resolve(value).catch(() => {}); throw Error('BOUNDED_RECOVERY_AUTHORITY'); } };
  check();
  const initial = store.inspectExecutors(input.fence);
  if (initial.snapshot.run.status !== 'cancel_pending' || initial.workers.length !== 1 || initial.entries.length !== 2) throw Error('BOUNDED_RECOVERY_SCOPE');
  const run = initial.snapshot.run;
  if (!run.spec) throw Error('BOUNDED_RECOVERY_PROGRAM');
  const compiled = compileGraphSpec(run.spec);
  // Explicit compatibility boundary: do not automatically follow a future
  // graphDeliveryVersion bump while reconstructing this v4 business result.
  const supported = { executionModel: 'langgraph-functional-v1', durability: 'sync', engineVersion: '1.4.15',
    checkpointVersion: '1.1.5', templateVersion: '4', registryVersion: compiled.registryVersion,
    compilerVersion: compiled.compilerVersion, schemaVersion: compiled.schemaVersion, compiledProgramDigest: compiled.compiledProgramDigest };
  if (Object.entries(supported).some(([key, value]) => run.identity[key as keyof typeof run.identity] !== value)) throw Error('BOUNDED_RECOVERY_PROGRAM');
  const writer = initial.entries.find(e => e.action.effect.nodeId === 'e0.implement');
  const workspace = initial.entries.find(e => e.action.effect.nodeId === 'e0.workspace');
  if (!writer || !workspace || writer.action.generation !== 1 || workspace.action.generation !== 1
    || writer.action.effect.epoch !== 0 || workspace.action.effect.epoch !== 0
    || writer.action.effect.logicalAttempt !== 1 || workspace.action.effect.logicalAttempt !== 1
    || writer.action.action.kind !== 'implement' || writer.action.action.workspaceLeaseRef !== 'e0.writer'
    || workspace.action.action.kind !== 'workspace_create' || !writer.admission
    || workspace.admission?.releasedAt == null || workspace.action.outcome?.state !== 'confirmed'
    || workspace.action.outcome.result.kind !== 'workspace' || workspace.action.outcome.result.workspaceLeaseRef !== 'e0.writer') throw Error('BOUNDED_RECOVERY_SCOPE');
  const journal = loadBoundedRecoveryJournal(root, writer.action.effectKey);
  if (journal.actionDigest !== boundedActionDigest(writer.action) || journal.owner !== writer.owner
    || journal.executionRef !== writer.action.executionRef || journal.workspacePath !== join(root, 'writer-0')
    || journal.commonDir !== join(journal.workspacePath, '.git') || journal.lockOwner.repo_id !== journal.repoId
    || journal.lockOwner.autonomy_run_id !== `graph-action:${writer.action.effectKey}`) throw Error('BOUNDED_RECOVERY_BINDING');
  dead(journal.lockOwner.pid);
  const scope = await resolveRepositoryScope(journal.workspacePath); check();
  if (scope.commonDir !== journal.commonDir || scope.repoId !== journal.repoId) throw Error('BOUNDED_RECOVERY_WORKSPACE');
  const receiptBinding = (entry: typeof writer, workspacePath: string) => ({ effect: entry.action.effect, effectKey: entry.action.effectKey,
    generation: entry.action.generation, owner: entry.owner, workspacePath });
  const predecessor = await loadDeliveryReceipt(root, workspace.action.outcome.evidenceRef, receiptBinding(workspace, sourcePath)); check();
  const evidence = await loadDeliveryReceipt(root, journal.evidenceRef, receiptBinding(writer, journal.workspacePath)); check();
  const expectedWorkspace = { workspace_id: input.fence.scope.workspaceId, workspace_path: journal.workspacePath };
  const created = predecessor.workspace as { workspace?: unknown; baseRevision?: string } | undefined;
  if (predecessor.stopped !== true || predecessor.status !== 'completed' || !same(created?.workspace, expectedWorkspace)
    || created?.baseRevision !== initial.snapshot.run.spec?.input.baseRevision
    || evidence.stopped !== true || evidence.status !== 'completed' || evidence.candidate?.status !== 'implementation_complete'
    || !same(evidence.candidate.workspace, expectedWorkspace)
    || !/^(anthropic|deepseek)-bounded-v1:/.test(evidence.stopEvidenceRef ?? '')) throw Error('BOUNDED_RECOVERY_STOP_REQUIRED');
  const execution = evidence.candidate.execution;
  const tokens = [execution?.tokens_in, execution?.tokens_out];
  if (tokens.some(n => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)) throw Error('BOUNDED_RECOVERY_USAGE');
  const actualTokens = tokens[0]! + tokens[1]!;
  if (!Number.isSafeInteger(actualTokens)) throw Error('BOUNDED_RECOVERY_USAGE');
  const verdict: GraphRecoveryVerdict = { outcome: 'applied', evidenceRef: journal.evidenceRef, actualTokens,
    result: { schemaVersion: 1, kind: 'implementation_complete', workspaceLeaseRef: 'e0.writer', receiptRef: 'e0.implementation' } };
  const workerBinding = { scope: input.fence.scope, graphRunId: input.fence.graphRunId, identity: input.fence.identity,
    generation: input.fence.expectedGeneration, owner: input.fence.expectedOwner! };
  const recheck = () => {
    check(); dead(journal.lockOwner.pid);
    if (!same(loadBoundedRecoveryJournal(root, writer.action.effectKey), journal)
      || boundedWorkspaceFingerprint(journal.workspacePath) !== journal.fingerprint) throw Error('BOUNDED_RECOVERY_CHANGED');
    assertBoundedDeliveryReceipt(root, journal.evidenceRef);
    assertBoundedDeliveryReceipt(root, workspace.action.outcome!.evidenceRef);
    return verifyJournaledGraphWorkerExit(db, workerBinding);
  };
  recheck();
  const reconciler = new GraphReconciler(db); const connection = {};
  let inventory: GraphExecutorInventory | undefined;
  reconciler.register(connection, { binding: workerBinding, authorize: check, stopWorker: async () => undefined,
    verifyWorker: async () => recheck(), verifyQuiescence: async snapshot => {
      recheck(); inventory = store.inspectExecutors(snapshot.fence, snapshot.action?.effectKey);
      // Exact two-action history is fixed; G15 may only change this writer's settlement/admission.
      if (inventory.entries.length !== 2 || inventory.workers.length !== 1
        || !same(inventory.entries.find(e => e.action.effectKey === workspace.action.effectKey), workspace)
        || boundedActionDigest(inventory.entries.find(e => e.action.effectKey === writer.action.effectKey)!.action) !== journal.actionDigest) throw Error('BOUNDED_RECOVERY_CHANGED');
      return { executorEvidenceRef: journal.evidenceRef, workspaceEvidenceRef: `bounded-workspace:${journal.fingerprint}` };
    }, verifyOutcome: async () => verdict,
    recheck: (_snapshot, proof, decision) => {
      if (!same(recheck(), proof.worker) || !inventory) throw Error('BOUNDED_RECOVERY_CHANGED');
      store.assertExecutorInventory(inventory);
      if (decision.kind === 'effect' ? !same(decision.verdict, verdict) : decision.kind !== 'project' || decision.status !== 'cancelled') throw Error('BOUNDED_RECOVERY_DECISION');
    }, release: async (_result, reverify) => {
      await reverify();
      const lockRoot = join(journal.commonDir, 'osstack', 'writer-locks');
      const current = await inspectRepoWriteLock(lockRoot, journal.repoId);
      if (current) await releaseReconciledRepoWriteLock({ root_dir: lockRoot, repo_id: journal.repoId, expectedOwner: journal.lockOwner,
        verifyQuiescent: async () => { await reverify(); } });
      // Missing lock only acknowledges release of this already-proven stopped
      // producer. Never unlink a replacement token; lost unlink ACK is replayable.
      await reverify();
    },
  });
  try {
    const result = await reconciler.reconcile(connection, { kind: 'effect', fence: input.fence,
      effectKey: writer.action.effectKey, receiptId: `bounded-effect:${writer.action.effectKey}` });
    if (result.exit === 'release_pending') return result;
    const run = new GraphRunStore(db).get(input.fence.scope, input.fence.graphRunId)!;
    return await reconciler.reconcile(connection, { kind: 'project', status: 'cancelled', receiptId: input.receiptId,
      fence: { ...input.fence, expectedRevision: run.revision, now: Date.now() } });
  } finally { reconciler.unregister(connection); }
}
