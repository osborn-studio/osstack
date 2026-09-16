import type Database from 'better-sqlite3';
import type { GraphRunFence } from '@osstack/core';
import type { GraphRecoverySnapshot } from '@osstack/core/graph-recovery';
import { GraphWorkerBinding, workerCanonical } from '@osstack/protocol';
import { GraphProcessJournal } from './graph-process-journal.js';
import type { GraphReconciler } from './graph-reconciler.js';

export interface GraphUnstartedRecoveryRequest {
  fence: GraphRunFence;
  receiptId: string;
  owner: string;
  leaseExpiresAt: number;
}

/** Trusted host only. Proves absence of admitted executors, never their termination.
 * First generation only: historical launched generations require a different proof. */
export async function recoverUnstartedGraphWorker(db: Database.Database, reconciler: GraphReconciler,
  value: GraphUnstartedRecoveryRequest, authorize: () => void) {
  const request = structuredClone(value);
  const binding = GraphWorkerBinding.parse({ scope: request.fence.scope, graphRunId: request.fence.graphRunId,
    identity: request.fence.identity, generation: request.fence.expectedGeneration, owner: request.fence.expectedOwner });
  const journal = new GraphProcessJournal(db);
  const verify = (snapshot: GraphRecoverySnapshot) => {
    if (snapshot.run.generation !== 1) throw Error('GRAPH_NO_CHILD_PROOF_REQUIRED');
    const deadline = snapshot.run.spec && snapshot.run.createdAt + snapshot.run.spec.limits.deadlineSeconds * 1000;
    if (!deadline || Date.now() >= deadline || request.leaseExpiresAt > deadline) throw Error('GRAPH_DEADLINE_EXCEEDED');
    const report = journal.observe(binding); const event = report.observations[0];
    if (!report.intentRecorded || report.launch || report.observations.length !== 1 || event?.kind !== 'spawn_failed') {
      throw Error('GRAPH_NO_CHILD_PROOF_REQUIRED');
    }
    // Look across the entire run, not only the current generation or running rows.
    for (const table of ['graph_actions', 'graph_action_admissions', 'graph_checkpoints', 'graph_checkpoint_writes', 'graph_checkpoint_requests']) {
      if (db.prepare(`SELECT 1 FROM ${table} WHERE graph_run_id=? LIMIT 1`).get(binding.graphRunId)) {
        throw Error('GRAPH_EXECUTOR_ABSENCE_REQUIRED');
      }
    }
    return { kind: 'not_started' as const, graphRunId: event.graphRunId, generation: event.generation,
      owner: event.owner, confirmedAt: event.confirmedAt, evidenceRef: event.evidenceRef };
  };
  const connection = {};
  reconciler.register(connection, { binding, authorize,
    stopWorker: async () => undefined, // No signal is necessary or authorized by a no-child proof.
    verifyWorker: async snapshot => verify(snapshot),
    verifyQuiescence: async snapshot => {
      verify(snapshot);
      return { executorEvidenceRef: `no-admitted-executor:${snapshot.digest}`, workspaceEvidenceRef: `no-admitted-producer:${snapshot.digest}` };
    },
    verifyOutcome: async () => { throw Error('GRAPH_NO_EFFECT_RECONCILIATION'); },
    recheck: (snapshot, proof) => {
      if (workerCanonical(verify(snapshot)) !== workerCanonical(proof.worker)) throw Error('GRAPH_NO_CHILD_PROOF_REQUIRED');
    },
    release: async () => { throw Error('GRAPH_NO_RESOURCE_RELEASE'); },
  });
  try { return await reconciler.reconcile(connection, { ...request, kind: 'takeover' }); }
  finally { reconciler.unregister(connection); }
}
