import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { deliveryCheckReference, freezeDeliveryContract } from '@osstack/core';
import { GraphDelegationStatus, computeGraphInputDigest } from '@osstack/protocol';
import { GraphRpcService, loadLocalGraphRegistration } from './graph-rpc.js';
import { graphRpcFixture } from './graph-test-fixture.js';
import { createExecutionContextAdapters, type ExecutionContextReceiptReference } from './execution-context.js';
import { persistDeliveryHostRecord } from './delivery-contract-host.js';
import { GraphContractCompletionReceipt } from './graph-contract-receipt.js';
import * as contractReceipts from './graph-contract-receipt.js';
import type { GraphExecutionContextRegistration } from './graph-execution-context.js';
import { GraphDelivery } from './graph-delivery.js';
import { assertGraphContractPaths } from './graph-delivery-contract.js';

async function fixture(mode: 'success' | 'repair' | 'unknown' = 'success', context = false) {
  const f = await graphRpcFixture(mode); await f.service.close();
  if (context) { f.request.scope = { ...f.request.scope, tenantId: 'default' }; f.registration.scope = f.request.scope; }
  const originalRun = GraphDelivery.prototype.run;
  const routes: Awaited<ReturnType<GraphDelivery['run']>>[] = [];
  const runSpy = vi.spyOn(GraphDelivery.prototype, 'run').mockImplementation(async function (this: GraphDelivery) {
    const result = await originalRun.call(this);
    routes.push(result);
    return result;
  });
  const policyDigest = 'b'.repeat(64);
  const frozen = freezeDeliveryContract({ schema_version: 2, contract_id: 'graph-contract', task_id: f.request.spec.input.taskRef,
    canonical_repo: f.registration.delivery.repositoryPath, mode: 'implement', base_head: f.request.spec.input.baseRevision, goal: f.registration.delivery.task,
    required_checks: [{ id: 'accept', registry_ref: deliveryCheckReference(f.registration.delivery.acceptanceRegistry[0]!.command) }],
    review_policy_ref: 'graph:independent', requested_completion: 'local_verified', allowed_paths: ['answer'], requested_actions: ['build', 'verify'],
    budget_ref: `policy:${policyDigest}`, policy_digest: policyDigest, publication_scope: { mode: 'none' }, merge_authority: { mode: 'none' } });
  const registration = { ...f.registration, delivery: { ...f.registration.delivery,
    deliveryContract: { frozen, policy: { policyDigest, reviewPolicyRef: 'graph:independent', limits: { ...f.request.spec.limits } } } } };
  const prompts: string[] = []; const writer = registration.delivery.writer.adapter;
  registration.delivery.writer = { ...registration.delivery.writer, adapter: { ...writer, invoke: async function* (task, signal) {
    prompts.push(task.prompt); yield* writer.invoke(task, signal);
  } } };
  const reviewPrompts: string[] = []; const rawReviewer = registration.delivery.reviewer.adapter;
  registration.delivery.reviewer = { ...registration.delivery.reviewer, adapter: { ...rawReviewer, invoke: async function* (task, signal) {
    reviewPrompts.push(task.prompt); yield* rawReviewer.invoke(task, signal);
  } } };
  const contextRefs: ExecutionContextReceiptReference[] = []; const receiptRoot = join(f.root, 'context-receipts');
  const executionContext: GraphExecutionContextRegistration = { configDigest: 'd'.repeat(64), receiptRoot, assertCurrent: () => {},
    create: async input => {
      const wrapped = createExecutionContextAdapters({ adapters: [input.adapter], workspacePath: input.workspacePath, mode: 'local',
        contractDigest: input.frozen.digest, contractBrief: input.frozen.brief, loadContext: async () => [], recordReceipt: async receipt => {
          const ref = await persistDeliveryHostRecord(receiptRoot, receipt); contextRefs.push(ref); return ref;
        } });
      return { adapter: wrapped.adapters[0]!, receiptRefs: wrapped.receiptRefs };
    } };
  const options = { ...f.options, registrations: [{ ...registration, delivery: { ...registration.delivery, ...(context ? { executionContext } : {}) } }] }; const service = new GraphRpcService(options);
  const start = async () => GraphDelegationStatus.parse(await service.handle(f.connection, 'graph.start', f.request));
  const until = async (id: string, waiting = false) => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const state = GraphDelegationStatus.parse(await service.handle(f.connection, 'graph.status', { schemaVersion: 1, scope: f.request.scope, graphRunId: id }));
      if (['ready', 'failed', 'reconciliation_required', ...(waiting ? ['waiting_input'] : [])].includes(state.status)) return state;
      if (Date.now() >= deadline) throw Error(`timeout ${state.status}`); await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  return { ...f, registration, options, service, start, until, prompts, reviewPrompts, contextRefs, executionContext, routes, close: async () => { await service.close(); runSpy.mockRestore(); await f.close(); } };
}
it('binds the durable host contract before the real Graph launch and never changes source HEAD/refs/index/files', async () => {
  const f = await fixture();
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.registration.delivery.repositoryPath, encoding: 'utf8' });
    const source = [git('rev-parse', 'HEAD'), git('show-ref'), git('ls-files', '--stage'), await readFile(join(f.registration.delivery.repositoryPath, 'answer'), 'utf8')];
    const [a, b] = await Promise.all([f.start(), f.start()]); expect(a.graphRunId).toBe(b.graphRunId);
    expect(a.inputDigest).not.toBe(computeGraphInputDigest(f.request)); expect(f.writes()).toBe(0);
    const descriptor = JSON.parse((f.db.prepare('SELECT descriptor_json FROM graph_public_delivery WHERE graph_run_id=?').get(a.graphRunId) as { descriptor_json: string }).descriptor_json);
    expect(descriptor.contractEnvelope.frozen.digest).toBe(f.registration.delivery.deliveryContract.frozen.digest);
    expect(descriptor.request.inputArtifactRef).toMatch(/^graph-contract-input:/);
    const ready = await f.until(a.graphRunId); expect(ready.status).toBe('ready'); expect(f.writes()).toBe(1);
    expect(ready.evidenceRefs.some(ref => ref.startsWith('graph-contract:'))).toBe(true);
    const receipt = GraphContractCompletionReceipt.parse(await f.service.handle(f.connection, 'graph.contract', { schemaVersion: 1, scope: f.request.scope, graphRunId: a.graphRunId }));
    expect(receipt).toMatchObject({ achievedCompletion: 'local_verified', publication: 'artifact_only', contextEvidence: [], check: { exitCode: 0 }, review: { verdict: 'accept' } });
    expect(f.prompts[0]!.split('Delivery contract V2:').length).toBe(2);
    expect([git('rev-parse', 'HEAD'), git('show-ref'), git('ls-files', '--stage'), await readFile(join(f.registration.delivery.repositoryPath, 'answer'), 'utf8')]).toEqual(source);
    const replay = new GraphRpcService(f.options);
    try { expect(await replay.handle(f.connection, 'graph.submit', f.request)).toEqual(ready); } finally { await replay.close(); }
  } finally { await f.close(); }
}, 30000);
it.each(['grant', 'revision'] as const)('does not publish a durable completion file after %s changes during the last await', async drift => {
  const f = await fixture(); const publish = contractReceipts.publishGraphContractCompletion;
  const spy = vi.spyOn(contractReceipts, 'publishGraphContractCompletion').mockImplementation(async input => {
    const ref = await publish(input);
    if (drift === 'grant') f.grant(false);
    else f.db.prepare('UPDATE graph_runs SET revision=revision+1 WHERE graph_run_id=?').run(input.decision.snapshot.run.graphRunId);
    return ref;
  });
  try {
    const start = await f.start(); const deadline = Date.now() + 20000;
    while (!f.routes.length) { if (Date.now() > deadline) throw Error('driver timeout'); await new Promise(resolve => setTimeout(resolve, 20)); }
    expect(spy).toHaveBeenCalledOnce();
    const result = GraphDelegationStatus.parse(await f.service.handle(f.connection, 'graph.result', { schemaVersion: 1, scope: f.request.scope, graphRunId: start.graphRunId }));
    expect(result.status).not.toBe('ready'); expect(result.evidenceRefs.some(ref => ref.startsWith('graph-contract:'))).toBe(false);
    await expect(f.service.handle(f.connection, 'graph.contract', { schemaVersion: 1, scope: f.request.scope, graphRunId: start.graphRunId })).rejects.toThrow();
  } finally { spy.mockRestore(); await f.close(); }
}, 30000);
it('never exposes a contract completion when executor stop remains unknown', async () => {
  const f = await fixture('unknown', true);
  try {
    const start = await f.start(); const unknown = await f.until(start.graphRunId); expect(unknown.status).toBe('reconciliation_required');
    expect(unknown.evidenceRefs.some(ref => ref.startsWith('graph-contract:'))).toBe(false);
    await expect(f.service.handle(f.connection, 'graph.contract', { schemaVersion: 1, scope: f.request.scope, graphRunId: start.graphRunId })).rejects.toThrow();
  } finally { await f.close(); }
}, 30000);
it('binds actual writer and rebuilt reviewer prompts to two-phase context receipts before ready', async () => {
  const f = await fixture('success', true);
  try {
    const start = await f.start(); const ready = await f.until(start.graphRunId); expect(ready.status).toBe('ready');
    const receipt = GraphContractCompletionReceipt.parse(await f.service.handle(f.connection, 'graph.contract', { schemaVersion: 1, scope: f.request.scope, graphRunId: start.graphRunId }));
    expect(receipt.contextDigest).toBe(f.executionContext.configDigest); expect(receipt.contextEvidence).toHaveLength(2); expect(f.contextRefs).toHaveLength(4);
    const digests = [f.prompts[0]!, f.reviewPrompts[0]!].map(prompt => createHash('sha256').update(prompt).digest('hex'));
    expect(receipt.contextEvidence.map(row => row.promptDigest).sort()).toEqual(digests.sort());
    expect(receipt.review.promptDigest).toBe(createHash('sha256').update(f.reviewPrompts[0]!).digest('hex'));
    for (const prompt of [...f.prompts, ...f.reviewPrompts]) expect(prompt.split('Delivery contract V2:')).toHaveLength(2);
    for (const ref of f.contextRefs) {
      const bytes = await readFile(ref.path); expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.digest);
      const stored = JSON.parse(bytes.toString()); expect(stored.contract_digest).toBe(f.registration.delivery.deliveryContract.frozen.digest);
      expect(stored.repo_path).toBe(f.registration.delivery.repositoryPath); expect(stored.execution_repo_path).not.toBe(stored.repo_path);
    }
    const published = ready.evidenceRefs.find(ref => ref.startsWith('graph-contract:'))!;
    const file = join(f.options.root, start.graphRunId, 'contract-receipts', `${published.slice('graph-contract:'.length)}.json`);
    await writeFile(file, '{}');
    await expect(f.service.handle(f.connection, 'graph.contract', { schemaVersion: 1, scope: f.request.scope, graphRunId: start.graphRunId })).rejects.toThrow();
  } finally { await f.close(); }
}, 30000);
it('does not transfer a prior epoch context/check/review receipt to a repaired candidate', async () => {
  const f = await fixture('repair', true);
  try {
    const start = await f.start(); const waiting = await f.until(start.graphRunId, true); expect(waiting.status).toBe('waiting_input');
    await expect(f.service.handle(f.connection, 'graph.contract', { schemaVersion: 1, scope: f.request.scope, graphRunId: start.graphRunId })).rejects.toThrow();
    await f.service.handle(f.connection, 'graph.resume', { schemaVersion: 1, kind: 'resume', scope: f.request.scope, idempotencyKey: 'repair',
      graphRunId: start.graphRunId, expectedRevision: waiting.revision, interruptId: waiting.interrupt!.interruptId,
      input: { kind: 'data', value: { inputDigest: waiting.inputDigest } } });
    const ready = await f.until(start.graphRunId); expect(ready.status).toBe('ready'); expect(f.writes()).toBe(2);
    const receipt = GraphContractCompletionReceipt.parse(await f.service.handle(f.connection, 'graph.contract', { schemaVersion: 1, scope: f.request.scope, graphRunId: start.graphRunId }));
    expect(receipt.epoch).toBe(1); expect(receipt.contextEvidence).toHaveLength(2); expect(f.contextRefs).toHaveLength(8);
    const keys = (f.db.prepare('SELECT effect_key FROM graph_actions WHERE graph_run_id=? AND node_id IN (?,?)').all(start.graphRunId, 'e1.repair', 'e1.review') as Array<{ effect_key: string }>).map(row => row.effect_key).sort();
    expect(receipt.contextEvidence.map(row => row.effectKey).sort()).toEqual(keys);
  } finally { await f.close(); }
}, 30000);
it('requires a trusted policy resolver in local registration and rechecks its live authority', async () => {
  const f = await fixture();
  try {
    const registration = f.registration; const config = join(f.root, 'host.json');
    await writeFile(config, JSON.stringify({ schemaVersion: 1, registration: { id: registration.id, scope: registration.scope,
      repositoryRef: registration.repositoryRef, repositoryPath: registration.delivery.repositoryPath, taskRef: registration.taskRef,
      task: registration.delivery.task, inputArtifactRef: registration.inputArtifactRef,
      writer: { agentId: 'writer', capabilityId: 'write' }, reviewer: { agentId: 'reviewer', capabilityId: 'review' },
      acceptanceRegistry: registration.delivery.acceptanceRegistry, deliveryContract: registration.delivery.deliveryContract.frozen.contract,
      grant: { scope: registration.scope, expiresAt: Date.now() + 60000, operations: ['read', 'execute', 'cancel', 'resume'] } } }), { mode: 0o600 });
    const adapters = new Map([['writer', f.writer], ['reviewer', f.reviewer]]);
    await expect(loadLocalGraphRegistration(config, adapters)).rejects.toThrow('POLICY_REQUIRED');
    let allowed = true;
    const loaded = await loadLocalGraphRegistration(config, adapters, { resolveDeliveryContractPolicy: async () => ({
      policy: registration.delivery.deliveryContract.policy, assertCurrent: () => { if (!allowed) throw Error('live-policy-changed'); },
    }) });
    expect(loaded.delivery.deliveryContract).toEqual(registration.delivery.deliveryContract);
    loaded.authorize('execute'); allowed = false;
    expect(() => loaded.authorize('resume')).toThrow('live-policy-changed'); expect(() => loaded.authorize('read')).not.toThrow();
    await expect(loadLocalGraphRegistration(config, adapters, { resolveDeliveryContractPolicy: async () => ({ policy: registration.delivery.deliveryContract.policy,
      assertCurrent: (async () => {}) as () => void }) })).rejects.toThrow('POLICY_DENIED');
  } finally { await f.close(); }
});
it('rejects a changed contract under an existing idempotency key before a second launch', async () => {
  const f = await fixture();
  try {
    const first = await f.start();
    const changed = { ...f.registration, delivery: { ...f.registration.delivery, deliveryContract: { ...f.registration.delivery.deliveryContract,
      frozen: freezeDeliveryContract({ ...f.registration.delivery.deliveryContract.frozen.contract, contract_id: 'changed' }) } } };
    const service = new GraphRpcService({ ...f.options, registrations: [changed] });
    try { await expect(service.handle(f.connection, 'graph.start', f.request)).rejects.toThrow('IDEMPOTENCY_CONFLICT'); } finally { await service.close(); }
    expect(f.db.prepare('SELECT count(*) n FROM graph_runs').get()).toEqual({ n: 1 });
    await f.service.handle(f.connection, 'graph.cancel', { schemaVersion: 1, kind: 'cancel', scope: f.request.scope, graphRunId: first.graphRunId, expectedRevision: first.revision, idempotencyKey: 'cancel' });
  } finally { await f.close(); }
});
it('rejects a path outside contract before verification or ready publication', async () => {
  const f = await fixture(); await f.service.close();
  const frozen = freezeDeliveryContract({ ...f.registration.delivery.deliveryContract.frozen.contract, allowed_paths: ['other'] });
  const service = new GraphRpcService({ ...f.options, registrations: [{ ...f.registration, delivery: { ...f.registration.delivery,
    deliveryContract: { ...f.registration.delivery.deliveryContract, frozen } } }] });
  try {
    const start = GraphDelegationStatus.parse(await service.handle(f.connection, 'graph.start', f.request));
    const deadline = Date.now() + 20000; let status = start;
    while (!['failed', 'reconciliation_required'].includes(status.status)) {
      if (Date.now() > deadline) throw Error(`timeout ${status.status}`); await new Promise(resolve => setTimeout(resolve, 20));
      status = GraphDelegationStatus.parse(await service.handle(f.connection, 'graph.status', { schemaVersion: 1, scope: f.request.scope, graphRunId: start.graphRunId }));
    }
    expect(status.candidate).toBeUndefined(); expect(status.resultRef).toBeUndefined();
    expect(f.db.prepare("SELECT count(*) n FROM graph_actions WHERE node_id LIKE '%.review' OR node_id LIKE '%.tests'").get()).toEqual({ n: 0 });
  } finally { await service.close(); await f.close(); }
}, 30000);

it('rejects an ignored untracked path outside the contract before candidate serialization', async () => {
  const f = await fixture();
  try {
    const repo = f.registration.delivery.repositoryPath;
    await writeFile(join(repo, '.git/info/exclude'), 'hidden-output\n');
    await writeFile(join(repo, 'hidden-output'), 'candidate side effect');
    expect(() => assertGraphContractPaths(f.registration.delivery.deliveryContract.frozen, repo)).toThrow('delivery_contract_path_outside_scope');
  } finally { await f.close(); }
});
