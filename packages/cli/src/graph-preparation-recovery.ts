import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { GraphRunStore, resolveRepositoryScope, type GraphRunFence } from '@osstack/core';
import { GraphRecoveryStore, type GraphExecutorInventory, type GraphRecoveryVerdict } from '@osstack/core/graph-recovery';
import { inspectRepoWriteLock, repoLockPath } from '@osstack/autonomy';
import { workerCanonical } from '@osstack/protocol';
import { resolveV4GraphProgram } from '@osstack/graph/program-resolver';
import { deliveryEpoch } from '@osstack/graph/templates/code-delivery-v1';
import { GraphReconciler } from './graph-reconciler.js';
import { loadDeliveryReceipt } from './graph-delivery-receipts.js';
import { assertBoundedDeliveryReceipt } from './graph-bounded-recovery-journal.js';
import { verifyJournaledGraphWorkerExit } from './graph-worker-exit-proof.js';

const same = (a: unknown, b: unknown) => workerCanonical(a) === workerCanonical(b);
/** Compatibility recovery for v4's exact first-epoch preparation cancellation.
 * Never infers stop from a failed outcome alone. No signaling, unlink, replay,
 * takeover, or changes to existing action outcomes are authorized by this path. */
export async function cancelUnstartedGraphPreparation(db: Database.Database, root: string, sourcePath: string,
  value: { fence: GraphRunFence; receiptId: string }, authorize: () => void) {
  const input = structuredClone(value);
  const store = new GraphRecoveryStore(db, () => { throw Error('INSPECTION_ONLY'); });
  const check = () => { const result: unknown = authorize(); if (result !== undefined) {
    void Promise.resolve(result).catch(() => {}); throw Error('PREPARATION_RECOVERY_AUTHORITY');
  } };
  check(); const initial = store.inspectExecutors(input.fence); const run = initial.snapshot.run;
  if (run.status !== 'cancel_pending' || run.generation !== 1 || initial.workers.length !== 1 || initial.entries.length !== 5 || !run.spec) throw Error('PREPARATION_RECOVERY_SCOPE');
  // This recovery window only supports the frozen v4 action shape.
  const compiled = (() => {
    try { return resolveV4GraphProgram(run.spec, run.identity); }
    catch { throw Error('PREPARATION_RECOVERY_PROGRAM'); }
  })();
  const epoch = deliveryEpoch(compiled, 0);
  const names = ['workspace', 'implement', 'freeze', 'prepare_review', 'prepare_tests'] as const;
  const entries = names.map(name => {
    const node = epoch.node(name); const slot = name === 'prepare_review' ? epoch.preparationSlot('review', 1)
      : name === 'prepare_tests' ? epoch.preparationSlot('tests', 1) : node.effectSlot;
    const entry = initial.entries.find(e => e.action.effect.nodeId === node.id && e.action.effect.effectSlot === slot);
    if (!entry || entry.action.generation !== 1 || entry.action.effect.epoch !== 0 || entry.action.effect.logicalAttempt !== 1) throw Error('PREPARATION_RECOVERY_SCOPE');
    return entry;
  });
  const [workspace, writer, freeze, review, target] = entries;
  if (!workspace || !writer || !freeze || !review || !target) throw Error('PREPARATION_RECOVERY_SCOPE');
  const predecessors = entries.slice(0, 4);
  if (predecessors.some(e => e.action.state !== 'confirmed' || e.admission?.releasedAt == null || e.action.outcome?.state !== 'confirmed')
    || workspace.action.action.kind !== 'workspace_create' || writer.action.action.kind !== 'implement' || freeze.action.action.kind !== 'freeze'
    || review.action.action.kind !== 'workspace_create') throw Error('PREPARATION_RECOVERY_PREDECESSORS');
  const outcome = target.action.outcome;
  if (target.action.state !== 'failed' || target.action.executionRef !== null || target.action.uncertainty !== null
    || target.action.actualTokens !== 0 || target.action.observedTokens !== 0 || target.action.reservationTokens !== 0 || target.action.accountingBlocked
    || target.action.retrySafe || outcome?.state !== 'failed' || !/^not-started:[a-f0-9-]{36}$/.test(outcome.evidenceRef)
    || !same(outcome, { state: 'failed', evidenceRef: outcome.evidenceRef, actualTokens: 0, retrySafe: false,
      error: { message: 'admission refused before invocation' } })) throw Error('PREPARATION_RECOVERY_NOT_STARTED');
  const frozen = freeze.action.outcome;
  if (frozen?.state !== 'confirmed' || frozen.result.kind !== 'candidate_ready' || target.action.action.kind !== 'workspace_create'
    || target.action.action.baseRevision !== frozen.result.candidateRevision || target.action.action.repositoryRef !== run.spec.input.repositoryRef
    || review.action.action.baseRevision !== frozen.result.candidateRevision) throw Error('PREPARATION_RECOVERY_CANDIDATE');
  const effectReceiptId = `unstarted-preparation:${target.action.effectKey}`;
  const verdict: GraphRecoveryVerdict = { outcome: 'not_applied', evidenceRef: outcome.evidenceRef, actualTokens: 0, error: outcome.error };
  const validate = (inventory: GraphExecutorInventory) => {
    if (inventory.snapshot.run.status !== 'cancel_pending') throw Error('PREPARATION_RECOVERY_NOT_CANCELLING');
    if (!same(inventory.workers, initial.workers) || inventory.entries.length !== 5
      || predecessors.some(e => !same(inventory.entries.find(f => f.action.effectKey === e.action.effectKey), e))) throw Error('PREPARATION_RECOVERY_CHANGED');
    const current = inventory.entries.find(e => e.action.effectKey === target.action.effectKey);
    if (!current || !same(current.action, target.action) || current.owner !== target.owner
      || inventory.requiredEffectKeys.some(key => key !== target.action.effectKey)) throw Error('PREPARATION_RECOVERY_CHANGED');
    if (current.admission) {
      // Only this recovery's durable decision may explain an added obligation.
      const row = db.prepare('SELECT decision_json,effect_key FROM graph_recovery_decisions WHERE graph_run_id=? AND receipt_id=?')
        .get(run.graphRunId, effectReceiptId) as { decision_json: string; effect_key: string } | undefined;
      if (!row || row.effect_key !== target.action.effectKey || !same(JSON.parse(row.decision_json),
        { kind: 'effect', receiptId: effectReceiptId, verdict })) throw Error('PREPARATION_RECOVERY_ADMISSION');
    } else if (!same(inventory.requiredEffectKeys, [target.action.effectKey])) throw Error('PREPARATION_RECOVERY_ADMISSION');
  };
  validate(initial);
  const workspaceOutcome = workspace.action.outcome;
  if (workspaceOutcome?.state !== 'confirmed' || workspaceOutcome.result.kind !== 'workspace'
    || workspaceOutcome.result.workspaceLeaseRef !== 'e0.writer') throw Error('PREPARATION_RECOVERY_WORKSPACE');
  // In pinned v4, preparation() registers this.workspace() for admission.
  // That e0.writer mapping is created only by the bound workspace receipt below;
  // workspace_create's action JSON intentionally contains no physical path.
  if (writer.action.action.workspaceLeaseRef !== 'e0.writer' || freeze.action.action.workspaceLeaseRef !== 'e0.writer') throw Error('PREPARATION_RECOVERY_WORKSPACE');
  const writerPath = join(root, 'writer-0');
  const receipt = await loadDeliveryReceipt(root, workspaceOutcome.evidenceRef, { effect: workspace.action.effect,
    effectKey: workspace.action.effectKey, generation: 1, owner: workspace.owner, workspacePath: sourcePath }); check();
  const created = receipt.workspace as { workspace?: unknown; baseRevision?: string } | undefined;
  if (receipt.status !== 'completed' || receipt.stopped !== true || created?.baseRevision !== run.spec.input.baseRevision
    || !same(created.workspace, { workspace_id: run.scope.workspaceId, workspace_path: writerPath })) throw Error('PREPARATION_RECOVERY_WORKSPACE');
  const scope = await resolveRepositoryScope(writerPath); check();
  if (scope.commonDir !== join(writerPath, '.git')) throw Error('PREPARATION_RECOVERY_WORKSPACE');
  const lockRoot = join(scope.commonDir, 'osstack', 'writer-locks');
  const paths = [root, writerPath, scope.commonDir, join(scope.commonDir, 'osstack'), lockRoot];
  const stamp = () => paths.map(path => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || realpathSync(path) !== path) throw Error('PREPARATION_RECOVERY_WORKSPACE');
    return [path, stat.dev, stat.ino];
  });
  const identity = stamp();
  if (await inspectRepoWriteLock(lockRoot, scope.repoId) !== null) throw Error('PREPARATION_RECOVERY_LOCK_PRESENT');
  const binding = { scope: run.scope, graphRunId: run.graphRunId, identity: run.identity, generation: 1, owner: run.leaseOwner! };
  const recheck = () => {
    check();
    if (!same(stamp(), identity)) throw Error('PREPARATION_RECOVERY_WORKSPACE');
    assertBoundedDeliveryReceipt(root, workspaceOutcome.evidenceRef);
    try { lstatSync(repoLockPath(lockRoot, scope.repoId)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return verifyJournaledGraphWorkerExit(db, binding); throw error; }
    throw Error('PREPARATION_RECOVERY_LOCK_PRESENT');
  };
  recheck();
  const reconciler = new GraphReconciler(db); const connection = {}; let inventory: GraphExecutorInventory | undefined;
  reconciler.register(connection, { binding, authorize: check, stopWorker: async () => undefined,
    verifyWorker: async () => recheck(), verifyQuiescence: async snapshot => {
      recheck(); inventory = store.inspectExecutors(snapshot.fence, snapshot.action?.effectKey); validate(inventory);
      return { executorEvidenceRef: outcome.evidenceRef, workspaceEvidenceRef: workspaceOutcome.evidenceRef };
    }, verifyOutcome: async () => verdict,
    recheck: (_snapshot, proof, decision) => {
      if (!same(recheck(), proof.worker) || !inventory) throw Error('PREPARATION_RECOVERY_CHANGED');
      validate(inventory); store.assertExecutorInventory(inventory);
      if (decision.kind === 'effect' ? !same(decision.verdict, verdict) || decision.receiptId !== effectReceiptId
        : decision.kind !== 'project' || decision.status !== 'cancelled' || decision.receiptId !== input.receiptId) throw Error('PREPARATION_RECOVERY_DECISION');
    }, release: async (_result, reverify) => { await reverify(); recheck(); },
  });
  try {
    const result = await reconciler.reconcile(connection, { kind: 'effect', fence: input.fence, effectKey: target.action.effectKey, receiptId: effectReceiptId });
    if (result.exit === 'release_pending') return result;
    const current = new GraphRunStore(db).get(run.scope, run.graphRunId)!;
    return await reconciler.reconcile(connection, { kind: 'project', status: 'cancelled', receiptId: input.receiptId,
      fence: { ...input.fence, expectedRevision: current.revision, now: Date.now() } });
  } finally { reconciler.unregister(connection); }
}
