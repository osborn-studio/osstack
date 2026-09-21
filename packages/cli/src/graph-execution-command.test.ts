import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { computeGraphInputDigest, StartGraphRequest } from '@osstack/protocol';
import { handleGraphCommand } from './graph-command.js';
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'graph-command-')); roots.push(root);
  const request = StartGraphRequest.parse({ schemaVersion: 1, kind: 'start', scope: { schemaVersion: 1, tenantId: 'local', principalId: 'owner', workspaceId: 'repo' },
    idempotencyKey: 'one', inputArtifactRef: 'task-input', source: { product: 'osstack', requestId: 'source-one' },
    spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only', input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: 'a'.repeat(40), acceptanceRef: 'test' },
      limits: { maxEpochs: 1, maxBranchAttempts: 1, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 7, deadlineSeconds: 60, tokenReservationLimit: 49152 } } });
  const save = (name: string, value: unknown) => { const p = join(root, name); writeFileSync(p, JSON.stringify(value)); return p; };
  const file = save('request.json', request); const scopeFile = save('scope.json', request.scope); const specFile = save('spec.json', request.spec);
  const status = { schemaVersion: 1, scope: request.scope, graphRunId: 'graph-1', source: request.source, status: 'queued', revision: 0, generation: 0,
    inputDigest: computeGraphInputDigest(request), specHash: 'b'.repeat(64), createdAt: 1, updatedAt: 1, publication: 'artifact_only', phase: 'queued',
    budget: { limits: request.spec.limits, actionStarts: 0, reservedTokens: '0', chargedTokens: '0', accountingBlocked: false }, delivery: 'pending', evidenceRefs: [] };
  const stdout = vi.fn(); const stderr = vi.fn(); const rpc = vi.fn().mockResolvedValue({ ok: true, result: status });
  return { root, request, file, specFile, scopeFile, save, status, deps: { stdout, stderr, rpc }, output: () => JSON.parse(stdout.mock.calls.at(-1)![0] as string) as Record<string, unknown> };
}
it('validates offline without opening or migrating a reserved control plane', async () => {
  const f = fixture(); f.save('control-plane-reserved.json', {}); writeFileSync(join(f.root, 'state.db'), 'must not open');
  vi.stubEnv('OSSTACK_HOME', f.root); const before = readdirSync(f.root);
  expect(await handleGraphCommand(['validate', '--spec', f.specFile, '--json'], f.deps)).toBe(0);
  expect(f.output()).toMatchObject({ valid: true, budget: { maxActionStarts: 7 } });
  expect(f.deps.rpc).not.toHaveBeenCalled(); expect(readdirSync(f.root)).toEqual(before);
  const invalid = f.save('bad.json', { ...f.request.spec, limits: { ...f.request.spec.limits, maxActionStarts: 1 } });
  expect(await handleGraphCommand(['validate', '--spec', invalid, '--json'], f.deps)).toBe(1);
  expect(f.output()).toMatchObject({ error: { code: 'SPEC_INVALID' } });
});
it('submits exact business JSON and preserves key on duplicate CLI invocations', async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) expect(await handleGraphCommand(['run', '--request', f.file, '--json'], f.deps)).toBe(0);
  expect(f.deps.rpc.mock.calls).toEqual([['graph.start', f.request], ['graph.start', f.request]]);
  expect(f.output()).toMatchObject({ graphRunId: 'graph-1', status: 'queued', inputDigest: computeGraphInputDigest(f.request) });
});
it('reads scoped status and result via daemon; rejects mismatched response scope', async () => {
  const f = fixture();
  for (const command of ['status', 'result']) expect(await handleGraphCommand([command, '--run', 'graph-1', '--scope', f.scopeFile, '--json'], f.deps)).toBe(0);
  expect(f.deps.rpc.mock.calls[0]).toEqual(['graph.status', { schemaVersion: 1, scope: f.request.scope, graphRunId: 'graph-1' }]);
  f.deps.rpc.mockResolvedValue({ ok: true, result: { ...f.status, scope: { ...f.request.scope, principalId: 'someone-else' } } });
  expect(await handleGraphCommand(['status', '--run', 'graph-1', '--scope', f.scopeFile, '--json'], f.deps)).toBe(1);
  expect(f.output()).toMatchObject({ error: { code: 'RESPONSE_MISMATCH' } });
});
it('lost mutation response reports delivery_unknown and exact retry binding', async () => {
  const f = fixture(); f.deps.rpc.mockRejectedValue(new Error('response lost'));
  expect(await handleGraphCommand(['run', '--request', f.file, '--json'], f.deps)).toBe(2);
  expect(f.output()).toEqual({ schemaVersion: 1, kind: 'delivery_unknown', scope: f.request.scope, idempotencyKey: 'one', inputDigest: computeGraphInputDigest(f.request), nextAction: 'retry_same_request' });
  expect(f.deps.rpc).toHaveBeenCalledTimes(1);
});
it('preserves cancel/resume fences and cannot turn approved booleans into a resume request', async () => {
  const f = fixture();
  const cancel = { schemaVersion: 1, kind: 'cancel', scope: f.request.scope, graphRunId: 'graph-1', expectedRevision: 3, idempotencyKey: 'cancel-1' };
  const resume = { ...cancel, kind: 'resume', idempotencyKey: 'resume-1', interruptId: 'i-1', input: { kind: 'data', value: { inputDigest: f.status.inputDigest } } };
  for (const request of [cancel, resume]) {
    expect(await handleGraphCommand([request.kind, '--request', f.save(`${request.kind}.json`, request), '--json'], f.deps)).toBe(0);
    expect(f.deps.rpc.mock.calls.at(-1)).toEqual([`graph.${request.kind}`, request]);
  }
  const count = f.deps.rpc.mock.calls.length;
  expect(await handleGraphCommand(['resume', '--request', f.save('approved.json', { ...resume, input: true }), '--json'], f.deps)).toBe(1);
  expect(f.deps.rpc).toHaveBeenCalledTimes(count);
});
it('returns stable rejection codes and rejects duplicate flags and oversized JSON before RPC', async () => {
  const f = fixture(); f.deps.rpc.mockResolvedValue({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT', message: 'same key, different business input' } });
  expect(await handleGraphCommand(['run', '--request', f.file, '--json'], f.deps)).toBe(1);
  expect(f.output()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT', retryable: false } });
  f.deps.rpc.mockClear();
  for (const args of [['run', '--request', f.file, '--request', f.file], ['cancel', '--request', f.file], ['run', '--request', f.save('large.json', 'x'.repeat(70000))]]) {
    expect(await handleGraphCommand([...args, '--json'], f.deps)).toBe(1);
  }
  expect(f.deps.rpc).not.toHaveBeenCalled();
});

it('malformed and mismatched mutation acknowledgements preserve the original retry key', async () => {
  const f = fixture();
  for (const reply of [null, { ok: true, result: {} }, { ok: true, result: { ...f.status, inputDigest: 'c'.repeat(64) } }]) {
    f.deps.rpc.mockResolvedValue(reply);
    expect(await handleGraphCommand(['run', '--request', f.file, '--json'], f.deps)).toBe(2);
    expect(f.output()).toMatchObject({ kind: 'delivery_unknown', idempotencyKey: f.request.idempotencyKey, inputDigest: computeGraphInputDigest(f.request) });
  }
});

it.each(['EXECUTOR_UNSUPPORTED', 'GRAPH_ADMISSION_DISABLED'])('surfaces %s as a definite nonretryable rejection', async code => {
  const f = fixture(); f.deps.rpc.mockResolvedValue({ ok: false, error: { code, message: code } });
  expect(await handleGraphCommand(['run', '--request', f.file, '--json'], f.deps)).toBe(1);
  expect(f.output()).toMatchObject({ error: { code, retryable: false, nextAction: 'stop' } });
  expect(f.deps.rpc).toHaveBeenCalledTimes(1);
});

it('reconcile sends the strict cancellation contract and preserves its exact retry identity on lost response', async () => {
  const f = fixture(); const request = { schemaVersion: 1, kind: 'cancel', scope: f.request.scope, graphRunId: 'graph-1', expectedRevision: 3, idempotencyKey: 'settle' };
  const file = f.save('reconcile.json', request);
  expect(await handleGraphCommand(['reconcile', '--request', file, '--json'], f.deps)).toBe(0);
  expect(f.deps.rpc.mock.calls[0]).toEqual(['graph.reconcile', request]);
  f.deps.rpc.mockRejectedValue(Error('lost response'));
  expect(await handleGraphCommand(['reconcile', '--request', file, '--json'], f.deps)).toBe(2);
  expect(f.output()).toMatchObject({ kind: 'delivery_unknown', idempotencyKey: 'settle', inputDigest: computeGraphInputDigest(request), nextAction: 'retry_same_request' });
  f.deps.rpc.mockClear();
  expect(await handleGraphCommand(['reconcile', '--request', f.save('forged.json', { ...request, evidenceRefs: ['trust-me'], outcome: 'stopped' }), '--json'], f.deps)).toBe(1);
  expect(f.deps.rpc).not.toHaveBeenCalled();
});
