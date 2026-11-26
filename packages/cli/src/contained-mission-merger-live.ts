import type { MergerShadowStore } from '@osstack/core';
import type { MergerConfig } from './contained-mission-merger-config.js';
import type { MergerShadowOptions } from './contained-mission-merger-shadow.js';
import { createSandboxAppEWriteAdapter } from './contained-mission-sandbox-app-e-github.js';
import { executeMissionAppEMerge, SANDBOX_MERGER_POLICY } from './contained-mission-sandbox-app-e.js';

export function createMissionLiveMerger(config: MergerConfig, live: NonNullable<MergerConfig['live']>, store: MergerShadowStore,
  enabled: () => boolean, now: () => number): NonNullable<MergerShadowOptions['live']> {
  const policy = { ...SANDBOX_MERGER_POLICY, appId: config.merger.app_id, actorId: config.merger.actor_id,
    installationId: live.merger_installation_id, publisherId: config.publisher.actor_id };
  if (config.repository.toLowerCase() !== policy.repository) throw Error('MERGER_LIVE_SANDBOX_ONLY:repository');
  const write = createSandboxAppEWriteAdapter({ policy, privateKeyPath: live.merger_key_path });
  store.recoverLiveMerges(now());
  return async (evidence, decision, reread, running) => {
    if (evidence.repository.toLowerCase() !== policy.repository || !evidence.base_head) throw Error('MERGER_BINDING_INVALID');
    const binding = { repository: policy.repository, repositoryId: policy.repositoryId, branch: evidence.branch,
      pr: evidence.pr_number, head: evidence.head, base: evidence.base_head };
    let reservation: number | null = null;
    let gates = decision.gates;
    const observe = async () => {
      const verdict = await reread();
      if (verdict) gates = verdict.gates;
      return verdict?.verdict === 'would_merge';
    };
    const result = await executeMissionAppEMerge(binding, decision, { ...write, observe, enabled: () => {
      if (!enabled() || !running()) return false;
      store.attention.assertOwner(store.owner);
      return true;
    },
      reserveOnce: async () => {
        reservation = store.reserveLiveMerge(evidence.mission_id, binding, now());
        return reservation !== null;
      },
    }, policy);
    store.recordLiveMerge(evidence.mission_id, { binding, reservation, gates,
      outcome: result.kind === 'refused' ? `refused:${result.reason}` : result.kind,
      ...(result.kind === 'merged' && { sha: result.sha }) }, now());
  };
}
