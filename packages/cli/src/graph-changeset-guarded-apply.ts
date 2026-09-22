import type Database from 'better-sqlite3';
import type { GraphRunFence } from '@osstack/core';
import type { GraphInvocationEvidenceStore } from '@osstack/core/graph-invocation-evidence';
import { freezeWorkerData } from '@osstack/protocol';
import { GraphChangesetApplyHost, type GraphChangesetApplyOptions } from './graph-changeset-apply-host.js';
import type { GraphApplyInput, GraphApplyResult } from './graph-apply-changeset.js';
import type { ExecutionLease } from './governed-execution.js';

/** Host-only adapter for real canonical write authority. Does not release the
 * lease/admission after success: the owner must carry both through freeze. Any
 * ambiguous/partial result retains physical capacity for trusted reconciliation.
 * Grant/profile/registration checks remain required in verify, independently of
 * the scoped physical lock proof. Not a production executor registration. */
export async function applyGraphChangesetWithLease(options: {
  db: Database.Database; evidence: GraphInvocationEvidenceStore; input: GraphApplyInput;
  fence: GraphRunFence; lease: ExecutionLease; verify: GraphChangesetApplyOptions['verify'];
  signal?: AbortSignal; now?: () => number;
}): Promise<GraphApplyResult> {
  const { db, evidence, lease, verify, signal, now } = options;
  const input = freezeWorkerData(structuredClone(options.input));
  const fence = freezeWorkerData(structuredClone(options.fence));
  if (!lease.withWriteGuard) throw Error('CHANGESET_WRITE_GUARD_REQUIRED');
  try {
    const result = await lease.withWriteGuard(input.workspace, assertActive => {
      const host = new GraphChangesetApplyHost(db, evidence, {
        ...(now === undefined ? {} : { now }),
        verify: context => {
          assertActive(); if (signal?.aborted) throw Error('CHANGESET_APPLY_CANCELLED');
          const verdict = verify(context);
          if (verdict !== undefined) { void Promise.resolve(verdict).catch(() => {}); throw Error('APPLY_AUTHORITY'); }
          assertActive(); if (signal?.aborted) throw Error('CHANGESET_APPLY_CANCELLED');
        },
      });
      return host.apply(input, fence);
    });
    if (result.kind !== 'applied' || result.reconciliationRequired) lease.retain('graph changeset apply requires reconciliation');
    return result;
  } catch (error) {
    lease.retain('graph changeset guarded apply failed');
    throw error;
  }
}
