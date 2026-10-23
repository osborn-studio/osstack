import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AgentAdapter, AgentTask } from '@osstack/agents';
import { createScratchDir, deliveryCheckReference, freezeDeliveryContract } from '@osstack/core';
import { computeGraphEffectKey } from '@osstack/protocol';
import { createExecutionContextAdapters } from './execution-context.js';
import { persistDeliveryHostRecord } from './delivery-contract-host.js';
import { prepareGraphExecutionContext, snapshotGraphExecutionContext } from './graph-execution-context.js';

const roots: string[] = [];
const effect = { schemaVersion: 1 as const, scope: { schemaVersion: 1 as const, tenantId: 'default', principalId: 'p', workspaceId: 'w' },
  graphRunId: 'graph', specHash: 'f'.repeat(64), epoch: 0, nodeId: 'e0.implement', effectSlot: 'main', logicalAttempt: 1 };
const identity = { effect, effectKey: computeGraphEffectKey(effect) };
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(mutation?: 'run_id' | 'task_id' | 'session_id' | 'contract_digest' | 'prompt_sha256' | 'tenant' | 'missing_phase') {
  const root = await createScratchDir('tests', 'graph-context'); roots.push(root);
  const candidate = join(root, 'candidate'); await mkdir(candidate);
  const frozen = freezeDeliveryContract({ schema_version: 2, contract_id: 'contract', task_id: 'task', canonical_repo: root,
    mode: 'implement', base_head: 'a'.repeat(40), goal: 'change', required_checks: [{ id: 'test', registry_ref: deliveryCheckReference('true') }],
    review_policy_ref: 'graph:review', requested_completion: 'local_verified', allowed_paths: ['src'], requested_actions: ['build', 'verify'],
    budget_ref: `policy:${'b'.repeat(64)}`, policy_digest: 'b'.repeat(64), publication_scope: { mode: 'none' }, merge_authority: { mode: 'none' } });
  const observed: AgentTask[] = [];
  const raw: AgentAdapter = Object.freeze({ id: 'writer', display_name: 'writer', cost_tier: 'low', capabilities: () => [],
    isAvailable: async () => ({ available: true, last_checked_at: 0 }),
    confirmStopped: async function (this: AgentAdapter) { expect(this.id).toBe('writer'); return { stopped: true, evidence: 'actual' }; },
    invoke: async function* (task: AgentTask) { expect(Object.isFrozen(task)).toBe(true); expect(Object.isFrozen(task.context)).toBe(true);
      expect(() => { task.prompt = 'mutated'; }).toThrow(); observed.push(task); yield { event_id: 'done', run_id: task.run_id, session_id: task.session_id,
      seq: 1, created_at: 1, type: 'done' as const, terminal: true, payload: { status: 'completed' as const, last_seq: 0 } }; } });
  const prepared = await prepareGraphExecutionContext({ adapter: raw, workspacePath: root, frozen, authorize: () => {},
    registration: snapshotGraphExecutionContext({ configDigest: 'c'.repeat(64), receiptRoot: join(root, 'receipts'), assertCurrent: () => {},
      create: async input => {
        const context = createExecutionContextAdapters({ adapters: [input.adapter], workspacePath: root, mode: 'local', contractDigest: frozen.digest,
          contractBrief: frozen.brief, loadContext: async () => [], recordReceipt: async receipt => persistDeliveryHostRecord(join(root, 'receipts'),
            mutation && mutation !== 'missing_phase' ? { ...receipt, [mutation]: 'wrong' } : receipt) });
        return { adapter: context.adapters[0]!, receiptRefs: () => mutation === 'missing_phase' ? context.receiptRefs().slice(0, 1) : context.receiptRefs() };
      } }),
  });
  const task = { run_id: 'run', task_id: 'task', session_id: 'session', capability_id: 'write', prompt: 'Implement', context: { repo_path: candidate } };
  for await (const _event of prepared.adapter.invoke(task, new AbortController().signal)) { /* Actual complete adapter iteration. */ }
  return { prepared, observed, frozen };
}
it('observes final task inside assembly and delegates stop identity on frozen source adapters', async () => {
  const f = await fixture();
  expect(f.observed).toHaveLength(1); expect(f.observed[0]!.prompt).toContain(f.frozen.brief);
  const receipt = await f.prepared.evidence('run', identity); expect(receipt.runId).toBe('run'); expect(receipt.prepared).not.toEqual(receipt.adapterObserved);
  expect(receipt.effect).toEqual(effect); expect(receipt.link.digest).toMatch(/^[a-f0-9]{64}$/);
  await expect(f.prepared.adapter.confirmStopped!('run')).resolves.toEqual({ stopped: true, evidence: 'actual' });
  await expect(f.prepared.evidence('other', identity)).rejects.toThrow('ACTUAL_INVOCATION_REQUIRED');
  await expect(f.prepared.evidence('run', { ...identity, effectKey: 'd'.repeat(64) })).rejects.toThrow('EFFECT_MISMATCH');
  const iterator = f.prepared.adapter.invoke({ ...f.observed[0]!, run_id: 'second' }, new AbortController().signal)[Symbol.asyncIterator]();
  await expect(iterator.next()).rejects.toThrow('INVOCATION_REPLAY');
  await expect(f.prepared.evidence('run', identity)).resolves.toEqual(receipt);
});
it.each(['run_id', 'task_id', 'session_id', 'contract_digest', 'prompt_sha256', 'tenant', 'missing_phase'] as const)(
  'rejects %s receipt substitution before it can enter a Graph proof', async mutation => {
    const f = await fixture(mutation); await expect(f.prepared.evidence('run', identity)).rejects.toThrow(/GRAPH_CONTEXT_RECEIPT/);
  });
