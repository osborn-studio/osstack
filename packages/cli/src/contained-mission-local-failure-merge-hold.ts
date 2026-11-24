import type { ContainedMissionStore } from '@osstack/core';
import { DiagnosisStore, LocalFailureRecheckStore } from '@osstack/core/verification-intake';

export type LocalFailureMergeHold = { held: false } | { held: true; reason:
  'verification_pending' | 'verify_recheck_missing' | 'verify_recheck_failed' | 'verify_recheck_binding_changed'
  | 'verify_approval_required' | 'verify_merge_unverified' };

export function readLocalFailureMergeHold(store: ContainedMissionStore,
  target: { repository: string; pr: number; root_mission_id: string; head: string; base: string }): LocalFailureMergeHold {
  try {
    const match = 'root_mission_id=@root_mission_id OR chain_id IN (SELECT chain_id FROM matched)';
    const chains = store.db.prepare(`WITH matched AS (
      SELECT chain_id,grant_json FROM engineering_revision_chains WHERE mode='live'
        AND ((lower(repository)=lower(@repository) AND pr_number=@pr) OR root_mission_id=@root_mission_id)
    ), evidence(chain_id,repair) AS (
      SELECT chain_id,0 FROM matched WHERE json_extract(grant_json,'$.version') IS 2 OR json_type(grant_json,'$.local_failure') IS NOT NULL
      UNION ALL SELECT chain_id,0 FROM engineering_local_failure_intakes WHERE ${match}
      UNION ALL SELECT chain_id,1 FROM engineering_local_failure_dispatches WHERE ${match}
      UNION ALL SELECT chain_id,1 FROM engineering_local_failure_rechecks WHERE ${match}
    )
    SELECT e.chain_id,c.published_head,c.published_base,max(e.repair) AS repair FROM evidence e
      LEFT JOIN engineering_revision_chains c ON c.chain_id=e.chain_id AND c.mode='live'
      GROUP BY e.chain_id ORDER BY e.chain_id`).all(target) as {
      chain_id: string; published_head: string | null; published_base: string | null; repair: number;
    }[];
    if (!chains.length) return { held: false };
    const ledger = new LocalFailureRecheckStore(new DiagnosisStore(store.attention, store.owner));
    const rows = chains.flatMap(chain => ledger.forChain(chain.chain_id).map(row => ({ chain, row })));
    const decision = rows.find(({ row }) => row.state === 'awaiting_decision');
    if (decision) {
      const { reason } = decision.row;
      return { held: true, reason: reason === 'verify_recheck_failed' || reason === 'verify_recheck_binding_changed'
        ? reason : 'verify_merge_unverified' };
    }
    if (rows.some(({ chain, row }) => row.state === 'recheck_passed' && row.reason === null
      && row.new_head_sha === target.head && row.base_sha === target.base
      && chain.published_head === target.head && chain.published_base === target.base && ledger.resultCurrent(row.recheck_id))) {
      return { held: true, reason: 'verify_approval_required' };
    }
    return { held: true, reason: rows.length || chains.some(chain => chain.repair) ? 'verify_recheck_missing' : 'verification_pending' };
  } catch {
    return { held: true, reason: 'verify_merge_unverified' };
  }
}
