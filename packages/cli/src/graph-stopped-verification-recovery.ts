import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { GraphRunStore, resolveRepositoryScope, type GraphRunFence } from '@osstack/core';
import { GraphArtifactStore } from '@osstack/core/graph-artifacts';
import { GraphRecoveryStore, type GraphExecutorInventory, type GraphRecoveryVerdict } from '@osstack/core/graph-recovery';
import { inspectRepoWriteLock, releaseReconciledRepoWriteLock, repoLockPath, type RepoLockOwner } from '@osstack/autonomy';
import { workerCanonical } from '@osstack/protocol';
import { compileGraphSpec } from '@osstack/graph/spec-compiler';
import { deliveryEpoch } from '@osstack/graph/templates/code-delivery-v1';
import { GraphReconciler } from './graph-reconciler.js';
import { loadGraphVerificationEvidence, type AcceptanceCommandSpec } from './graph-verification-store.js';
import { assertExactCandidateFiles } from './graph-verification.js';
import { verifyJournaledGraphWorkerExit } from './graph-worker-exit-proof.js';

const same = (a: unknown, b: unknown) => workerCanonical(a) === workerCanonical(b);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function dead(pid: number): void {
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw Error('VERIFICATION_RECOVERY_HOST_UNPROVEN'); }
  throw Error('VERIFICATION_RECOVERY_HOST_ALIVE');
}
export interface StoppedVerificationRecoveryInput {
  fence: GraphRunFence; receiptId: string; expectedDaemonPid: number;
  /** Exact owner captured by the read-only preflight; never infer a replacement. */
  expectedLockOwner?: RepoLockOwner;
  acceptanceRegistry: readonly AcceptanceCommandSpec[];
  /** Read-only preflight may inspect the still-running owner. Apply never does. */
  inspectOnly?: boolean;
}
/** Exact v4/epoch-0 seven-confirmed-action cancellation only. The sole obligation
 * must be a stopped, registered POSIX tests command whose exact lock was retained.
 * Never resumes a worker, infers unknown outcomes, signals a PID, or marks ready. */
export async function cancelStoppedGraphVerification(db: Database.Database, root: string,
  value: StoppedVerificationRecoveryInput, authorize: () => void) {
  const input = structuredClone(value);
  if (!Number.isSafeInteger(input.expectedDaemonPid) || input.expectedDaemonPid <= 0) throw Error('VERIFICATION_RECOVERY_PID');
  const check = () => { const result: unknown = authorize(); if (result !== undefined) {
    void Promise.resolve(result).catch(() => {}); throw Error('VERIFICATION_RECOVERY_AUTHORITY');
  } };
  const store = new GraphRecoveryStore(db, () => { throw Error('INSPECTION_ONLY'); });
  check(); const initial = store.inspectExecutors(input.fence); const run = initial.snapshot.run;
  if (run.status !== 'cancel_pending' || run.generation !== 1 || initial.workers.length !== 1 || initial.entries.length !== 7 || !run.spec) throw Error('VERIFICATION_RECOVERY_SCOPE');
  const compiled = compileGraphSpec(run.spec);
  const supported = { executionModel: 'langgraph-functional-v1', durability: 'sync', engineVersion: '1.4.15', checkpointVersion: '1.1.5',
    templateVersion: '4', registryVersion: 'code-delivery-registry-v3', compilerVersion: 'code-delivery-functional-v4',
    schemaVersion: 'code-delivery-schema-v3', compiledProgramDigest: compiled.compiledProgramDigest };
  if (Object.entries(supported).some(([key, v]) => run.identity[key as keyof typeof run.identity] !== v)) throw Error('VERIFICATION_RECOVERY_PROGRAM');
  const epoch = deliveryEpoch(compiled, 0);
  const names = ['workspace','implement','freeze','prepare_review','prepare_tests','review','tests'] as const;
  const entries = names.map(name => {
    const node = epoch.node(name); const slot = name === 'prepare_review' ? epoch.preparationSlot('review', 1)
      : name === 'prepare_tests' ? epoch.preparationSlot('tests', 1) : node.effectSlot;
    const entry = initial.entries.find(e => e.action.effect.nodeId === node.id && e.action.effect.effectSlot === slot);
    if (entry?.action.generation !== 1 || entry.action.effect.epoch !== 0 || entry.action.effect.logicalAttempt !== 1
      || entry.action.state !== 'confirmed' || entry.action.outcome?.state !== 'confirmed' || entry.action.accountingBlocked
      || entry.action.uncertainty !== null || entry.action.actualTokens === null || !entry.admission) throw Error('VERIFICATION_RECOVERY_ACTIONS');
    return entry;
  });
  const target = entries[6]!, freeze = entries[2]!, review = entries[5]!;
  const outcome = target.action.outcome!;
  if (target.action.action.kind !== 'tests' || outcome.state !== 'confirmed' || outcome.result.kind !== 'tests'
    || target.action.actualTokens !== 0 || target.action.observedTokens !== 0 || target.action.reservationTokens !== 0
    || target.admission!.owner !== run.leaseOwner || entries.slice(0, 6).some(e => e.admission!.releasedAt === null)) throw Error('VERIFICATION_RECOVERY_ADMISSION');
  const frozen = freeze.action.outcome!;
  if (freeze.action.action.kind !== 'freeze' || frozen.state !== 'confirmed' || frozen.result.kind !== 'candidate_ready') throw Error('VERIFICATION_RECOVERY_CANDIDATE');
  const candidate = frozen.result;
  const binding = { scope: run.scope, graphRunId: run.graphRunId, specHash: run.identity.specHash,
    epoch: 0, candidateRevision: candidate.candidateRevision, artifactDigest: candidate.artifactDigest, acceptanceRef: run.spec.input.acceptanceRef };
  const effectReceiptId = `stopped-verification:${target.action.effectKey}`;
  const verdict: GraphRecoveryVerdict = { outcome: 'applied', evidenceRef: outcome.evidenceRef, actualTokens: 0, result: outcome.result };
  const validate = (inventory: GraphExecutorInventory) => {
    if (inventory.snapshot.run.status !== 'cancel_pending' || !same(inventory.workers, initial.workers)
      || inventory.entries.length !== 7 || inventory.entries.some(e => !same(e.action, initial.entries.find(x => x.action.effectKey === e.action.effectKey)?.action))
      || entries.slice(0, 6).some(e => !same(inventory.entries.find(x => x.action.effectKey === e.action.effectKey), e))
      || inventory.requiredEffectKeys.some(key => key !== target.action.effectKey)) throw Error('VERIFICATION_RECOVERY_CHANGED');
    // No unrelated held graph, active generation or unstarted run may be hidden by stopping the daemon.
    if (db.prepare("SELECT 1 FROM graph_runs WHERE graph_run_id != ? AND status NOT IN ('ready','failed','cancelled') LIMIT 1").get(run.graphRunId)
      || db.prepare('SELECT 1 FROM graph_action_admissions WHERE effect_key != ? AND released_at IS NULL LIMIT 1').get(target.action.effectKey)) throw Error('VERIFICATION_RECOVERY_OTHER_OBLIGATION');
  };
  validate(initial);
  const prior = db.prepare('SELECT decision_json FROM graph_recovery_decisions WHERE graph_run_id=? AND receipt_id=?').get(run.graphRunId, effectReceiptId) as { decision_json: string } | undefined;
  const expectedDecision = { kind: 'effect', receiptId: effectReceiptId, verdict };
  if (prior && !same(JSON.parse(prior.decision_json), expectedDecision)) throw Error('VERIFICATION_RECOVERY_DECISION');
  if (target.admission!.releasedAt !== null && !prior) throw Error('VERIFICATION_RECOVERY_ADMISSION');
  const artifacts = new GraphArtifactStore(join(root, 'artifacts'));
  const manifest = await artifacts.verify(candidate.artifactDigest); check();
  if (manifest.candidateRevision !== candidate.candidateRevision || manifest.input.runId !== run.graphRunId
    || !same(manifest.input.scope, run.scope)) throw Error('VERIFICATION_RECOVERY_CANDIDATE');
  const envelope = await loadGraphVerificationEvidence(join(root, 'verification'), outcome.evidenceRef, binding,
    { effect: target.action.effect, effectKey: target.action.effectKey }); check();
  const reviewOutcome = review.action.outcome!;
  if (reviewOutcome.state !== 'confirmed' || reviewOutcome.result.kind !== 'review') throw Error('VERIFICATION_RECOVERY_REVIEW');
  const reviewEnvelope = await loadGraphVerificationEvidence(join(root, 'verification'), reviewOutcome.evidenceRef, binding,
    { effect: review.action.effect, effectKey: review.action.effectKey }); check();
  const command = envelope.evidence.command;
  const registered = input.acceptanceRegistry.filter(a => a.ref === binding.acceptanceRef);
  if (registered.length !== 1 || !same(registered[0], envelope.acceptance) || envelope.kind !== 'tests' || envelope.verificationFailure
    || envelope.evidence.contained || !command || command.termination?.scope !== 'posix_process_group'
    || command.termination.trigger !== 'exit' || command.termination.stop_confirmed !== true || command.termination.leader_exit_code !== command.exitCode
    || command.failure_code || command.cancellation || envelope.workspaceLeaseRef !== target.action.action.workspaceLeaseRef
    || envelope.binding.candidateRevision !== target.action.action.candidateRevision
    || outcome.result.passed !== envelope.acceptance.passExitCodes.includes(command.exitCode)
    || reviewEnvelope.kind !== 'review' || reviewEnvelope.verificationFailure || reviewEnvelope.report?.verdict !== reviewOutcome.result.verdict) throw Error('VERIFICATION_RECOVERY_STOP_REQUIRED');
  const workspace = envelope.workspace.workspace_path;
  if (!workspace.startsWith(join(root, 'verification', 'tests-')) || realpathSync(workspace) !== workspace) throw Error('VERIFICATION_RECOVERY_WORKSPACE');
  const scope = await resolveRepositoryScope(workspace); check();
  if (scope.commonDir !== join(workspace, '.git')) throw Error('VERIFICATION_RECOVERY_WORKSPACE');
  const lockRoot = join(scope.commonDir, 'osstack', 'writer-locks');
  const owner = await inspectRepoWriteLock(lockRoot, scope.repoId); check();
  if (!owner && !prior) throw Error('VERIFICATION_RECOVERY_LOCK_MISSING');
  if (owner && (owner.pid !== input.expectedDaemonPid || owner.autonomy_run_id !== `graph-action:${target.action.effectKey}`
    || owner.recovery_policy !== 'reconcile')) throw Error('VERIFICATION_RECOVERY_LOCK_OWNER');
  const expectedOwner = input.inspectOnly ? owner ?? (prior ? input.expectedLockOwner : undefined) : input.expectedLockOwner;
  if (!expectedOwner || expectedOwner.pid !== input.expectedDaemonPid || expectedOwner.repo_id !== scope.repoId
    || expectedOwner.autonomy_run_id !== `graph-action:${target.action.effectKey}` || expectedOwner.recovery_policy !== 'reconcile'
    || (owner && !same(owner, expectedOwner))) throw Error('VERIFICATION_RECOVERY_LOCK_OWNER');
  const lockProof = `verification-lock:${sha(workerCanonical(expectedOwner))}:${candidate.artifactDigest}`;
  if (prior) {
    const record = db.prepare('SELECT proof_json FROM graph_recovery_decisions WHERE graph_run_id=? AND receipt_id=?').get(run.graphRunId, effectReceiptId) as { proof_json: string };
    if (JSON.parse(record.proof_json).workspaceEvidenceRef !== lockProof) throw Error('VERIFICATION_RECOVERY_LOCK_OWNER');
  }
  const lockPath = repoLockPath(lockRoot, scope.repoId);
  const evidenceFiles = [outcome.evidenceRef, reviewOutcome.evidenceRef].map(ref => ({ path: join(root, 'verification', 'evidence', ref.slice('graph-verification:'.length) + '.json'), digest: ref.slice('graph-verification:'.length) }));
  const directories = [root, join(root, 'verification'), join(root, 'verification', 'evidence'), workspace, scope.commonDir, join(scope.commonDir, 'osstack'), lockRoot];
  const stamp = () => directories.map(path => { const stat = lstatSync(path); if (!stat.isDirectory() || realpathSync(path) !== path || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw Error('VERIFICATION_RECOVERY_WORKSPACE'); return [path, stat.dev, stat.ino]; });
  const identity = stamp();
  const workerBinding = { scope: run.scope, graphRunId: run.graphRunId, identity: run.identity, generation: 1, owner: run.leaseOwner! };
  const recheck = () => {
    check(); if (!input.inspectOnly) dead(input.expectedDaemonPid);
    if (!same(stamp(), identity)) throw Error('VERIFICATION_RECOVERY_WORKSPACE');
    for (const file of evidenceFiles) {
      const fd = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536 || sha(readFileSync(fd)) !== file.digest) throw Error('VERIFICATION_RECOVERY_EVIDENCE'); }
      finally { closeSync(fd); }
    }
    // Keep the exact candidate byte/mode/tree check; a dirty directory is never a release proof.
    assertExactCandidateFiles(workspace, candidate.candidateRevision);
    if (readdirSync(lockRoot).some(name => name.endsWith('.lock') && join(lockRoot, name) !== lockPath)) throw Error('VERIFICATION_RECOVERY_OTHER_LOCK');
    return verifyJournaledGraphWorkerExit(db, workerBinding);
  };
  const worker = recheck();
  if (input.inspectOnly) return { mode: 'read_only' as const, graphRunId: run.graphRunId, revision: run.revision,
    effectKey: target.action.effectKey, owner: expectedOwner, worker, candidateRevision: candidate.candidateRevision,
    evidenceRef: outcome.evidenceRef, actionDigest: sha(workerCanonical(entries.map(e => e.action))) };
  const reconciler = new GraphReconciler(db); const connection = {}; let inventory: GraphExecutorInventory | undefined;
  reconciler.register(connection, { binding: workerBinding, authorize: check, stopWorker: async () => undefined,
    verifyWorker: async () => recheck(), verifyQuiescence: async snapshot => {
      recheck(); inventory = store.inspectExecutors(snapshot.fence, snapshot.action?.effectKey); validate(inventory);
      return { executorEvidenceRef: outcome.evidenceRef, workspaceEvidenceRef: lockProof };
    }, verifyOutcome: async () => verdict,
    recheck: (_snapshot, proof, decision) => {
      if (!same(recheck(), proof.worker) || !inventory) throw Error('VERIFICATION_RECOVERY_CHANGED');
      validate(inventory); store.assertExecutorInventory(inventory);
      if (decision.kind === 'effect' ? !same(decision, expectedDecision)
        : decision.kind !== 'project' || decision.status !== 'cancelled' || decision.receiptId !== input.receiptId) throw Error('VERIFICATION_RECOVERY_DECISION');
    }, release: async (_result, reverify) => {
      recheck(); const current = await inspectRepoWriteLock(lockRoot, scope.repoId); check();
      if (current) {
        if (!same(current, expectedOwner)) throw Error('VERIFICATION_RECOVERY_LOCK_OWNER');
        await releaseReconciledRepoWriteLock({ root_dir: lockRoot, repo_id: scope.repoId, expectedOwner,
          verifyQuiescent: async () => { await reverify(); recheck(); } });
      } else {
        if (owner && _result.record.decision.kind === 'effect') throw Error('VERIFICATION_RECOVERY_CHANGED');
        await reverify(); recheck();
      }
    },
  });
  try {
    const result = await reconciler.reconcile(connection, { kind: 'effect', fence: input.fence, effectKey: target.action.effectKey, receiptId: effectReceiptId });
    if (result.exit === 'release_pending') return result;
    const current = new GraphRunStore(db).get(run.scope, run.graphRunId)!;
    return await reconciler.reconcile(connection, { kind: 'project', status: 'cancelled', receiptId: input.receiptId,
      fence: { ...input.fence, expectedRevision: current.revision, now: Date.now() } });
  } finally { reconciler.unregister(connection); }
}
