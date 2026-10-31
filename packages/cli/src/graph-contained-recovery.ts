import type Database from 'better-sqlite3';
import type { GraphRunFence } from '@osstack/core';
import { GraphRecoveryStore } from '@osstack/core/graph-recovery';
import { parseVerificationBinding, verificationCanonical, type VerificationBinding } from '@osstack/graph/nodes/branch';
import { authorizeContained, reopenContainedExecution } from './contained-verification.js';
import { graphContainedCodec, validateContainedTestIdentity, type GraphContainedTestOptions } from './graph-contained-tests.js';

export interface ReopenContainedTests {
  fence: GraphRunFence;
  effectKey: string;
  /** Trusted manifest/registry inputs, never inferred from the journal itself. */
  binding: VerificationBinding;
  command: string;
  contentDigest: string;
}

/** Host-only per-action cleanup port, reconstructible after supervisor restart.
 * Does not execute, settle outcomes, release admission, or prove all workers stopped.
 * read_only also inspects released admissions, but can never stop an executor.
 * Private journal + trusted daemon/admin remain authority; labels are never searched. */
export async function reopenGraphContainedTests(db: Database.Database, options: GraphContainedTestOptions, request: ReopenContainedTests, mode: 'held' | 'read_only' = 'held') {
  if (mode !== 'held' && mode !== 'read_only') throw Error('CONTAINED_RECOVERY_MODE');
  const fixed = structuredClone({ request, socketPath: options.socketPath, daemonId: options.daemonId,
    baseImageId: options.baseImageId, journalRoot: options.journalRoot });
  const { authorizeRead, authorizeStop } = options;
  const input = fixed.request; const binding = parseVerificationBinding(input.binding);
  // This instance cannot commit a recovery decision, even accidentally.
  const store = new GraphRecoveryStore(db, () => { throw Error('CONTAINED_REOPEN_IS_NOT_RECOVERY_AUTHORITY'); });
  authorizeContained(authorizeRead);
  const initial = store.inspectExecutors(input.fence, input.effectKey);
  const admission = initial.entries.find(entry => entry.action.effectKey === input.effectKey)?.admission;
  if (!admission) throw Error('RECOVERY_ADMISSION_BINDING');
  const action = initial.snapshot.action!;
  const prefix = `graph-execution:${input.effectKey}:`;
  const invocationId = action.executionRef?.startsWith(prefix) ? action.executionRef.slice(prefix.length) : '';
  if ((mode === 'held' && admission.releasedAt !== null) || action.action.kind !== 'tests'
    || action.action.candidateRevision !== binding.candidateRevision || action.action.commandSpecRef !== binding.acceptanceRef
    || action.effect.epoch !== binding.epoch || action.effect.specHash !== binding.specHash
    || binding.graphRunId !== input.fence.graphRunId || verificationCanonical(binding.scope) !== verificationCanonical(input.fence.scope)
    || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(invocationId)) throw Error('CONTAINED_LEDGER_BINDING');
  const opened = await reopenContainedExecution({ socketPath: fixed.socketPath, daemonId: fixed.daemonId, journalRoot: fixed.journalRoot, authorizeRead, authorizeStop }, {
    invocationId, command: input.command, mode, codec: graphContainedCodec,
    validate: value => {
      const identity = validateContainedTestIdentity(value, binding, input.effectKey, input.command, input.contentDigest);
      if (identity.invocationId !== invocationId || identity.generation !== action.generation
        || identity.image.daemonId !== fixed.daemonId || identity.image.baseImageId !== fixed.baseImageId) throw Error('CONTAINED_LEDGER_BINDING');
      return { identity, image: identity.image };
    },
    fence: () => {
      if (db.inTransaction) store.assertExecutorInventory(initial);
      else if (store.inspectExecutors(input.fence, input.effectKey).digest !== initial.digest) throw Error('CONTAINED_RECOVERY_CHANGED');
    },
    inTransaction: () => db.inTransaction,
  });
  return {
    identity: opened.identity,
    confirmStopped: opened.confirmStopped,
    stop: opened.stop,
    /** Per-invocation proof only; the host must separately cover every other producer. */
    captureQuiescence: async () => {
      const proof = await opened.captureQuiescence();
      return Object.freeze({ executorEvidenceRef: proof.executorEvidenceRef, isolationEvidenceRef: proof.isolationEvidenceRef,
        effectKey: input.effectKey, scope: proof.scope, recheck: proof.recheck });
    },
  };
}
