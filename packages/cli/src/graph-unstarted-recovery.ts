import type Database from 'better-sqlite3';
import type { GraphRunFence } from '@osstack/core';
import { GraphRecoveryStore, type GraphExecutorInventory, type GraphRecoverySnapshot } from '@osstack/core/graph-recovery';
import { GraphWorkerBinding, workerCanonical } from '@osstack/protocol';
import { verifyJournaledGraphWorkerNotStarted } from './graph-worker-exit-proof.js';
import type { GraphReconciler } from './graph-reconciler.js';

export interface GraphUnstartedRecoveryRequest {
  fence: GraphRunFence;
  receiptId: string;
  owner: string;
  leaseExpiresAt: number;
}

/** Trusted host only. Proves absence of admitted executors, never their termination.
 * Every historical generation must have its own durable no-child observation. */
export async function recoverUnstartedGraphWorker(db: Database.Database, reconciler: GraphReconciler,
  value: GraphUnstartedRecoveryRequest, authorize: () => void) {
  return reconcileUnstarted(db, reconciler, { ...value, kind: 'takeover' }, authorize);
}

/** Cancellation needs no fresh execution deadline; it never starts a replacement. */
export async function cancelUnstartedGraphWorker(db: Database.Database, reconciler: GraphReconciler,
  value: Pick<GraphUnstartedRecoveryRequest, 'fence' | 'receiptId'>, authorize: () => void) {
  return reconcileUnstarted(db, reconciler, { ...value, kind: 'project', status: 'cancelled' }, authorize);
}

async function reconcileUnstarted(db: Database.Database, reconciler: GraphReconciler,
  value: (GraphUnstartedRecoveryRequest & { kind: 'takeover' })
    | (Pick<GraphUnstartedRecoveryRequest, 'fence' | 'receiptId'> & { kind: 'project'; status: 'cancelled' }), authorize: () => void) {
  const request = structuredClone(value);
  const binding = GraphWorkerBinding.parse({ scope: request.fence.scope, graphRunId: request.fence.graphRunId,
    identity: request.fence.identity, generation: request.fence.expectedGeneration, owner: request.fence.expectedOwner });
  const store = new GraphRecoveryStore(db, () => { throw Error('GRAPH_NO_CHILD_INSPECTION_ONLY'); });
  let inventory: GraphExecutorInventory | undefined;
  const verify = (snapshot: GraphRecoverySnapshot) => {
    const deadline = snapshot.run.spec && snapshot.run.createdAt + snapshot.run.spec.limits.deadlineSeconds * 1000;
    if (request.kind === 'takeover' && (!deadline || Date.now() >= deadline || request.leaseExpiresAt > deadline)) throw Error('GRAPH_DEADLINE_EXCEEDED');
    // Look across the entire run, not only the current generation or running rows.
    for (const table of ['graph_actions', 'graph_action_admissions', 'graph_checkpoints', 'graph_checkpoint_writes', 'graph_checkpoint_requests']) {
      if (db.prepare(`SELECT 1 FROM ${table} WHERE graph_run_id=? LIMIT 1`).get(binding.graphRunId)) {
        throw Error('GRAPH_EXECUTOR_ABSENCE_REQUIRED');
      }
    }
    inventory ??= store.inspectExecutors(snapshot.fence);
    if (db.inTransaction) store.assertExecutorInventory(inventory);
    else if (store.inspectExecutors(snapshot.fence).digest !== inventory.digest) throw Error('RECOVERY_INVENTORY_CHANGED');
    const proofs = inventory.workers.map(worker => verifyJournaledGraphWorkerNotStarted(db,
      { ...binding, generation: worker.generation, owner: worker.owner }));
    const current = proofs.at(-1);
    if (!current || current.generation !== binding.generation || current.owner !== binding.owner) throw Error('GRAPH_NO_CHILD_PROOF_REQUIRED');
    return current;
  };
  const connection = {};
  reconciler.register(connection, { binding, authorize,
    stopWorker: async () => undefined, // No signal is necessary or authorized by a no-child proof.
    verifyWorker: async snapshot => verify(snapshot),
    verifyQuiescence: async snapshot => {
      verify(snapshot);
      return { executorEvidenceRef: `no-admitted-executor:${inventory!.digest}`, workspaceEvidenceRef: `no-admitted-producer:${inventory!.digest}` };
    },
    verifyOutcome: async () => { throw Error('GRAPH_NO_EFFECT_RECONCILIATION'); },
    recheck: (snapshot, proof) => {
      if (workerCanonical(verify(snapshot)) !== workerCanonical(proof.worker)) throw Error('GRAPH_NO_CHILD_PROOF_REQUIRED');
    },
    release: async () => { throw Error('GRAPH_NO_RESOURCE_RELEASE'); },
  });
  try { return await reconciler.reconcile(connection, request); }
  finally { reconciler.unregister(connection); }
}
