import { expect, it, vi } from 'vitest';
import { granted, setup, T0 } from './contained-mission-grant.testkit.js';

it.each(['abandon', 'takeover'] as const)('admits %s once with the client revision and key', async decision => {
  const f = await setup();
  const { chain } = await granted(f);
  const second = await granted(f);
  const request = { chain_id: chain.chain_id, decision, decision_id: 'key:1', expected_revision: chain.revision };
  const decide = (input: typeof request, actor = 'a') => f.service.chainDecide(f.actor(actor), input);
  await expect(decide({ ...request, expected_revision: chain.revision + 1 })).rejects.toThrow('stale_revision');
  await expect(decide(request, 'b')).rejects.toThrow('permission_denied');
  expect(f.rig.chains.get(chain.chain_id)).toEqual(chain);
  const first = await decide(request);
  expect(first).toEqual({ chain_id: chain.chain_id, decision, state: 'closed', child_cancel: 'not_needed' });
  const changes = () => f.rig.db.prepare('SELECT total_changes()').pluck().get();
  const before = changes();
  expect(await decide(request)).toEqual({ ...first, replay: true });
  await expect(decide(request, 'c')).rejects.toThrow('decision_id_owner_mismatch');
  await expect(decide({ ...request, decision: decision === 'abandon' ? 'takeover' : 'abandon' })).rejects.toThrow('decision_id_conflict');
  await expect(decide({ ...request, chain_id: second.chain.chain_id })).rejects.toThrow('decision_id_conflict');
  expect(changes()).toBe(before);
});

it.each([true, false])('records a reconcile read or leaves its outcome unknown (interrupted=%s)', async interrupted => {
  const reconcileReceipt = vi.fn(async () => ({ settled: false }));
  if (interrupted) reconcileReceipt.mockRejectedValueOnce(Error('read_interrupted'));
  const f = await setup({ grantOptions: { reconcileReceipt } });
  const { chain } = await granted(f);
  const request = { chain_id: chain.chain_id, decision_id: 'reconcile:1', decision: 'reconcile' } as const;
  const decide = (key: string) => f.service.chainDecide(f.actor('a'), { ...request, decision_id: key });
  await expect(decide(request.decision_id)).rejects.toThrow('nothing_to_reconcile');
  const chains = f.rig.chains;
  const reserved = chains.reserve(chain.chain_id, chain.revision, { head: chain.published_head, review_ids: [1], feedback_digest: 'd'.repeat(64) }, T0);
  const child = f.rig.missions.authorize(f.rig.principal, { scope_id: f.scope, spec: { goal: 'child' },
    claim: { repo_identity: 'repo', branch: 'child', worktree_identity: 'child' } }, T0);
  const dispatched = chains.dispatch(chain.chain_id, reserved.chain.revision, chain.published_head, child.mission_id, T0).chain;
  const { intent } = chains.recordIntent(chain.chain_id, dispatched.revision, { kind: 'push', branch: chain.branch, expected_old_head: chain.published_head,
    new_head: '2'.repeat(40), expected_base_sha: chain.published_base, child_mission_id: child.mission_id }, T0);
  chains.settleIntent(intent.intent_id, 'uncertain', T0);
  if (interrupted) await expect(decide(request.decision_id)).rejects.toThrow('read_interrupted');
  else expect(await decide(request.decision_id)).toMatchObject({ settled: false });
  expect(await decide(request.decision_id)).toMatchObject(interrupted ? { outcome: 'unknown', replay: true } : { settled: false, replay: true });
  expect(reconcileReceipt).toHaveBeenCalledTimes(1);
  expect(await decide('reconcile:2')).toMatchObject({ settled: false });
  chains.settleIntent(intent.intent_id, 'confirmed', T0);
  await expect(decide('reconcile:3')).rejects.toThrow('nothing_to_reconcile');
  expect(reconcileReceipt).toHaveBeenCalledTimes(2);
});

it('compares a client revision without a key and writes no answer receipt', async () => {
  const f = await setup();
  const { chain } = await granted(f);
  const input = { chain_id: chain.chain_id, decision: 'abandon' } as const;
  const decide = (revision: number) => f.service.chainDecide(f.actor('a'), { ...input, expected_revision: revision });
  await expect(decide(chain.revision + 1)).rejects.toThrow('stale_revision');
  expect(f.rig.chains.get(chain.chain_id)).toEqual(chain);
  expect(await decide(chain.revision)).toEqual({ ...input, state: 'closed', child_cancel: 'not_needed' });
  expect(f.rig.chains.events(chain.chain_id).filter(e => e.kind.startsWith('chain_answer_'))).toEqual([]);
});
