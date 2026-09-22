import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { GraphArtifactStore } from '@osstack/core/graph-artifacts';
import { resolveRepositoryScope } from '@osstack/core';
import { freezeGraphChangeset } from './graph-changeset-freeze.js';
import { GraphChangesetApplyHost } from './graph-changeset-apply-host.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { GraphActionStore, GraphRunStore, openDb } from '@osstack/core';
import { GraphAdmissionStore } from '@osstack/core/graph-recovery';
import { GraphInvocationEvidenceStore } from '@osstack/core/graph-invocation-evidence';
import { changesetPolicyDigest } from '@osstack/agents/experimental/changeset';
import { GraphChangesetInvocationHost } from './graph-changeset-invocation.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const payload = (text = JSON.stringify({ kind: 'propose', changes: [{ kind: 'create', path: 'src/a.ts', content: 'new' }] })) => ({ id: 'msg1', type: 'message', role: 'assistant', model: 'fixture', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 } });
function fixture(baseRevision = 'a'.repeat(40)) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'changeset host-'))); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openDb({ path: join(root, 'state.db') }); cleanups.push(() => { if (db.open) db.close(); }); db.pragma('synchronous = FULL');
  const runs = new GraphRunStore(db); const actions = new GraphActionStore(db); const now = Date.now();
  const scope = { schemaVersion: 1 as const, tenantId: 't', principalId: 'p', workspaceId: 'w' };
  let run = runs.create({ schemaVersion: 1, kind: 'start', scope, idempotencyKey: 'start', inputArtifactRef: 'input', source: { product: 'osstack', requestId: 'r' },
    spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only', input: { taskRef: 't', repositoryRef: 'repo', baseRevision, acceptanceRef: 'a' },
      limits: { maxEpochs: 2, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 10, deadlineSeconds: 60, tokenReservationLimit: 2000 } } },
    { executionModel: 'langgraph-functional-v1', durability: 'sync', engineVersion: '1', checkpointVersion: '1', templateVersion: '1', registryVersion: '1', compilerVersion: '1', schemaVersion: '1', compiledProgramDigest: 'b'.repeat(64) }, now);
  const fence = () => ({ scope, graphRunId: run.graphRunId, expectedGeneration: run.generation, expectedOwner: run.leaseOwner, expectedRevision: runs.get(scope, run.graphRunId)!.revision, identity: run.identity, now: Date.now() });
  run = runs.acquireLease({ ...fence(), owner: 'worker', leaseExpiresAt: now + 120000 });
  const admitted = actions.reserve(fence(), { epoch: 0, nodeId: 'implement', effectSlot: 'invoke', reservationTokens: 1100, action: { kind: 'implement', inputArtifactRef: 'input', workspaceLeaseRef: 'workspace' } }); run = admitted.run;
  const key = admitted.action.effectKey; new GraphAdmissionStore(db).hold(key, Date.now());
  const policy = { exactPaths: ['src/a.ts'], directoryPrefixes: [], denyPaths: [], denyPrefixes: [] };
  const binding = { runId: run.graphRunId, effectKey: key, generation: run.generation, baseRevision, treeRevision: 'c'.repeat(40), profileDigest: 'd'.repeat(64), grantDigest: 'e'.repeat(64), programDigest: 'b'.repeat(64), policyDigest: changesetPolicyDigest(policy) };
  const input = { task: 'Create', binding, policy, manifest: { schemaVersion: 1, binding, entries: [{ path: 'src/a.ts', state: 'absent' }] }, inputTokenUpperBound: 1000, maxOutputTokens: 100, tokenBoundEvidenceRef: 'fixture-bound' };
  const store = new GraphInvocationEvidenceStore(join(root, 'evidence'));
  const fetcher = vi.fn(async () => new Response(JSON.stringify(payload())));
  const verify = vi.fn(() => undefined); // Explicit fixture authority; not a production tokenizer or grant verifier.
  const options = { client: { provider: 'anthropic' as const, model: 'fixture', apiKey: 'fixture-secret', fetch: fetcher }, verify };
  const host = new GraphChangesetInvocationHost(db, store, options);
  return { db, root, runs, actions, run, key, scope, fence, input, store, fetcher, verify, options, host };
}
it('persists request before dispatch and exact response plus terminal receipt before ledger publication', async () => {
  const f = fixture();
  f.fetcher.mockImplementation(async () => {
    const invocation = f.actions.getInvocation(f.fence(), f.key).invocation!;
    const ref = f.store.lookup({ schemaVersion: 1, scope: f.scope, runId: f.run.graphRunId, effectKey: f.key, generation: 1, requestDigest: invocation.request.requestDigest, kind: 'request' });
    expect(ref).not.toBeNull(); return new Response(JSON.stringify(payload()));
  });
  const result = await f.host.invoke(f.input, f.fence(), 'execution');
  expect(result.kind).toBe('recorded'); if (result.kind !== 'recorded') throw Error('fixture');
  const saved = f.actions.getInvocation(f.fence(), f.key).invocation!;
  expect(saved.response).toMatchObject({ disposition: 'proposal', evidenceRef: result.responseRef, stopEvidenceRef: result.terminalRef });
  expect(f.actions.get(f.fence(), f.key)).toMatchObject({ action: { state: 'running', actualTokens: null }, budget: { actionStarts: 1, reservedTokens: '1100' } });
  const replay = new GraphChangesetInvocationHost(f.db, f.store, f.options);
  expect((await replay.invoke(f.input, f.fence(), 'execution')).kind).toBe('deferred'); expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it.each(['normal-sync', 'no-admission', 'low-budget', 'denied', 'async-authority', 'request-storage'])('does not dispatch on %s', async which => {
  const f = fixture();
  if (which === 'normal-sync') f.db.pragma('synchronous = NORMAL');
  if (which === 'no-admission') new GraphAdmissionStore(f.db).released(f.key, Date.now());
  if (which === 'low-budget') f.input.inputTokenUpperBound = 1500;
  if (which === 'denied') f.verify.mockImplementation(() => { throw Error('fixture-secret'); });
  if (which === 'request-storage') vi.spyOn(f.store, 'put').mockImplementation(() => { throw Error('ENOSPC fixture-secret'); });
  const host = which === 'async-authority' ? new GraphChangesetInvocationHost(f.db, f.store, { ...f.options, verify: () => Promise.reject(Error('denied')) }) : f.host;
  const result = await host.invoke(f.input, f.fence(), 'execution');
  expect(result.kind).toBe('deferred'); expect(f.fetcher).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain('fixture-secret');
});
it.each(['response', 'terminal'])('retains unknown and prevents resend when %s persistence fails after HTTP', async kind => {
  const f = fixture(); const put = f.store.put.bind(f.store);
  vi.spyOn(f.store, 'put').mockImplementation((binding, body) => { if ((binding as { kind: string }).kind === kind) throw Error('ENOSPC'); return put(binding, body); });
  const result = await f.host.invoke(f.input, f.fence(), 'execution');
  expect(result).toMatchObject({ kind: 'deferred', reason: 'response_persistence', reconciliationRequired: true });
  expect(f.actions.get(f.fence(), f.key).action.state).toBe('unknown');
  expect(f.actions.getInvocation(f.fence(), f.key).invocation?.response).toBeNull();
  await new GraphChangesetInvocationHost(f.db, f.store, f.options).invoke(f.input, f.fence(), 'execution'); expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it('retains a published response artifact on ledger write failure and never reports success', async () => {
  const f = fixture(); f.db.exec("CREATE TRIGGER inject_response BEFORE INSERT ON graph_invocation_responses BEGIN SELECT RAISE(ABORT, 'injected'); END");
  const result = await f.host.invoke(f.input, f.fence(), 'execution');
  expect(result).toMatchObject({ kind: 'deferred', reason: 'response_persistence', reconciliationRequired: true });
  if (result.kind !== 'deferred') throw Error('fixture'); expect(result.responseRef).not.toBeNull(); expect(result.terminalRef).not.toBeNull();
  expect(f.actions.get(f.fence(), f.key).action.state).toBe('unknown');
});
it('records nonretryable stopped failure on cannot_complete without releasing physical admission', async () => {
  const f = fixture(); f.fetcher.mockImplementation(async () => new Response(JSON.stringify(payload(JSON.stringify({ kind: 'cannot_complete', reason: 'insufficient_context' })))));
  expect((await f.host.invoke(f.input, f.fence(), 'execution')).kind).toBe('recorded');
  expect(f.actions.get(f.fence(), f.key)).toMatchObject({ action: { state: 'failed', retrySafe: false, actualTokens: 20 } });
  expect(f.db.prepare('SELECT released_at FROM graph_action_admissions WHERE effect_key=?').get(f.key)).toEqual({ released_at: null });
});
it('marks transport uncertainty without settling or releasing capacity', async () => {
  const f = fixture(); f.fetcher.mockImplementation(async () => { throw Error('disconnected'); });
  expect(await f.host.invoke(f.input, f.fence(), 'execution')).toMatchObject({ kind: 'deferred', reconciliationRequired: true });
  expect(f.actions.get(f.fence(), f.key)).toMatchObject({ action: { state: 'unknown' }, budget: { reservedTokens: '1100' } });
});
it('uses real loopback HTTP with the existing DeepSeek codec and stores the exact wire response', async () => {
  const f = fixture(); let calls = 0; let server!: Server;
  const body = JSON.stringify({ id: 'chat_1', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ kind: 'cannot_complete', reason: 'insufficient_context' }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  server = createServer((req, res) => { calls++; expect(req.url).toBe('/chat/completions'); req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('fixture');
  const host = new GraphChangesetInvocationHost(f.db, f.store, { client: { provider: 'deepseek', model: 'fixture', apiKey: 'local-fixture', baseUrl: `http://127.0.0.1:${address.port}` }, verify: f.verify });
  const result = await host.invoke(f.input, f.fence(), 'execution');
  expect(result.kind).toBe('recorded'); expect(calls).toBe(1);
  if (result.kind !== 'recorded') throw Error('fixture');
  expect(f.store.read(result.responseRef, { schemaVersion: 1, scope: f.scope, runId: f.run.graphRunId, effectKey: f.key, generation: 1, requestDigest: result.result.requestDigest, kind: 'response' }).toString()).toBe(body);
});
it('never dispatches again after beginInvocation committed but its ACK was lost', async () => {
  const f = fixture(); const original = GraphActionStore.prototype.beginInvocation;
  const spy = vi.spyOn(GraphActionStore.prototype, 'beginInvocation').mockImplementation(function (this: GraphActionStore, ...args) { original.apply(this, args); throw Error('lost ACK'); });
  try {
    expect(await f.host.invoke(f.input, f.fence(), 'execution')).toMatchObject({ kind: 'deferred', reconciliationRequired: true });
  } finally { spy.mockRestore(); }
  expect(f.actions.get(f.fence(), f.key).action.state).toBe('unknown'); expect(f.fetcher).not.toHaveBeenCalled();
  await new GraphChangesetInvocationHost(f.db, f.store, f.options).invoke(f.input, f.fence(), 'execution'); expect(f.fetcher).not.toHaveBeenCalled();
});
it('rechecks FULL durability after the authority callback', async () => {
  const f = fixture(); f.verify.mockImplementation(() => { f.db.pragma('synchronous = NORMAL'); return undefined; });
  await f.host.invoke(f.input, f.fence(), 'execution'); expect(f.fetcher).not.toHaveBeenCalled();
});
it('refreshes time after a slow authority verifier before committing dispatch', async () => {
  const f = fixture(); let now = Date.now(); let checks = 0;
  const host = new GraphChangesetInvocationHost(f.db, f.store, { ...f.options, now: () => now, verify: () => { if (++checks === 2) now += 65000; } });
  await host.invoke(f.input, f.fence(), 'execution'); expect(f.fetcher).not.toHaveBeenCalled();
});
it('charges over-budget terminal failures conservatively and blocks further accounting', async () => {
  const f = fixture(); f.fetcher.mockImplementation(async () => new Response(JSON.stringify({ ...payload(), usage: { input_tokens: 1200, output_tokens: 10 } })));
  expect((await f.host.invoke(f.input, f.fence(), 'execution')).kind).toBe('recorded');
  expect(f.actions.get(f.fence(), f.key)).toMatchObject({ action: { state: 'failed', actualTokens: 1210, retrySafe: false, accountingBlocked: true }, budget: { chargedTokens: '1210' } });
});
it('retains cancellation after dispatch and does not turn a late response into apply eligibility', async () => {
  const f = fixture(); let finish!: (response: Response) => void;
  f.fetcher.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; })); const controller = new AbortController();
  const pending = f.host.invoke(f.input, f.fence(), 'execution', controller.signal); controller.abort();
  expect(await pending).toMatchObject({ kind: 'deferred', reconciliationRequired: true }); finish(new Response(JSON.stringify(payload())));
  await Promise.resolve();
  expect(f.actions.get(f.fence(), f.key).action.state).toBe('cancel_pending');
  expect(f.actions.getInvocation(f.fence(), f.key).invocation?.response).toBeNull();
});
it('preserves reservation and blocks accounting for terminal usage whose sum is not a safe integer', async () => {
  const f = fixture(); f.fetcher.mockImplementation(async () => new Response(JSON.stringify({ ...payload(), usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 10 } })));
  expect((await f.host.invoke(f.input, f.fence(), 'execution')).kind).toBe('recorded');
  expect(f.actions.get(f.fence(), f.key)).toMatchObject({ action: { state: 'failed', actualTokens: null, retrySafe: false, accountingBlocked: true }, budget: { reservedTokens: '1100' } });
});
it('rolls back rejection response and failed outcome together if settlement cannot commit', async () => {
  const f = fixture(); f.fetcher.mockImplementation(async () => new Response(JSON.stringify(payload(JSON.stringify({ kind: 'cannot_complete', reason: 'insufficient_context' })))));
  f.db.exec("CREATE TRIGGER fail_settlement BEFORE UPDATE OF state ON graph_actions WHEN NEW.state = 'failed' BEGIN SELECT RAISE(ABORT, 'injected'); END");
  expect(await f.host.invoke(f.input, f.fence(), 'execution')).toMatchObject({ kind: 'deferred', reason: 'response_persistence' });
  expect(f.actions.getInvocation(f.fence(), f.key).invocation?.response).toBeNull();
  expect(f.actions.get(f.fence(), f.key).action.state).toBe('unknown');
});
it('retries only response ledger fencing when a concurrent lease renewal changes revision', async () => {
  const f = fixture(); const original = GraphActionStore.prototype.recordInvocationResponse; let calls = 0;
  const spy = vi.spyOn(GraphActionStore.prototype, 'recordInvocationResponse').mockImplementation(function (this: GraphActionStore, ...args) {
    if (++calls === 1) f.runs.renewLease({ ...f.fence(), leaseExpiresAt: Date.now() + 120000 });
    return original.apply(this, args);
  });
  try { expect((await f.host.invoke(f.input, f.fence(), 'execution')).kind).toBe('recorded'); }
  finally { spy.mockRestore(); }
  expect(calls).toBe(2); expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it('stores neither the API key nor authorization headers in request evidence', async () => {
  const f = fixture(); const result = await f.host.invoke(f.input, f.fence(), 'execution');
  if (result.kind !== 'recorded') throw Error('fixture');
  const raw = f.store.read(result.requestRef, { schemaVersion: 1, scope: f.scope, runId: f.run.graphRunId, effectKey: f.key, generation: 1, requestDigest: result.result.requestDigest, kind: 'request' }).toString();
  expect(raw).not.toContain('fixture-secret'); expect(raw).not.toContain('x-api-key'); expect(raw).not.toContain('authorization');
});
it('contains a rejecting foreign Promise from authority without granting dispatch', async () => {
  const f = fixture();
  const host = new GraphChangesetInvocationHost(f.db, f.store, { ...f.options, verify: () => runInNewContext('Promise.reject(new Error("foreign authority rejected"))') });
  expect(await host.invoke(f.input, f.fence(), 'execution')).toMatchObject({ kind: 'deferred', reason: 'authorization_or_storage' });
  await new Promise(resolve => setImmediate(resolve)); expect(f.fetcher).not.toHaveBeenCalled();
});

async function physicalFixture(multifile = false) {
  const physicalRoot = realpathSync(mkdtempSync(join(tmpdir(), 'graph-physical-')));
  cleanups.push(() => rmSync(physicalRoot, { recursive: true, force: true }));
  const workspace = join(physicalRoot, 'workspace'); mkdirSync(workspace);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd: workspace, encoding: 'utf8', env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git('init', '-q'); writeFileSync(join(workspace, 'keep.txt'), 'keep');
  if (multifile) writeFileSync(join(workspace, 'remove.txt'), 'old');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
  const f = fixture(git('rev-parse', 'HEAD'));
  f.input.binding.treeRevision = git('rev-parse', 'HEAD^{tree}');
  if (multifile) {
    const sha = (value: string) => createHash('sha256').update(value).digest('hex');
    f.input.policy.exactPaths.push('keep.txt', 'remove.txt'); f.input.binding.policyDigest = changesetPolicyDigest(f.input.policy);
    const entries: unknown[] = f.input.manifest.entries;
    entries.push({ path: 'keep.txt', state: 'present', content: 'keep', sha256: sha('keep'), mode: '100644' },
      { path: 'remove.txt', state: 'present', content: 'old', sha256: sha('old'), mode: '100644' });
    f.fetcher.mockImplementation(async () => new Response(JSON.stringify(payload(JSON.stringify({ kind: 'propose', changes: [
      { kind: 'create', path: 'src/a.ts', content: 'new' }, { kind: 'replace', path: 'keep.txt', content: 'updated', expectedSha256: sha('keep') },
      { kind: 'delete', path: 'remove.txt', expectedSha256: sha('old') },
    ] })))));
  }
  const invocation = await f.host.invoke(f.input, f.fence(), 'execution');
  if (invocation.kind !== 'recorded' || !invocation.result.validated) throw Error('fixture invocation');
  const applyInput = { workspace, binding: f.input.binding, manifest: f.input.manifest, policy: f.input.policy, proposal: invocation.result.validated.proposal };
  const applyHost = new GraphChangesetApplyHost(f.db, f.store, { verify: () => undefined });
  return { ...f, workspace, git, invocation, applyInput, applyHost };
}
it('applies a real Git candidate only after durable provider and apply evidence, then settles the original action', async () => {
  const f = await physicalFixture();
  expect(f.applyHost.apply(f.applyInput, f.fence())).toMatchObject({ kind: 'applied', reconciliationRequired: false });
  expect(readFileSync(join(f.workspace, 'src/a.ts'), 'utf8')).toBe('new');
  const apply = f.actions.getApply(f.fence(), f.key).apply!;
  expect(apply.resolution).toMatchObject({ kind: 'applied', actualTokens: 20 });
  expect(f.actions.get(f.fence(), f.key)).toMatchObject({ action: { state: 'confirmed' }, budget: { chargedTokens: '20', reservedTokens: '0' } });
  expect((f.db.prepare('SELECT released_at FROM graph_action_admissions WHERE effect_key=?').get(f.key) as { released_at: number | null }).released_at).toBeNull();
  expect(() => f.applyHost.apply(f.applyInput, f.fence())).toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it('rejects mismatched provider proposal before any physical change or apply intent', async () => {
  const f = await physicalFixture(); f.applyInput.proposal = { kind: 'propose', changes: [{ kind: 'create', path: 'src/a.ts', content: 'forged' }] };
  expect(() => f.applyHost.apply(f.applyInput, f.fence())).toThrow('APPLY_INVOCATION_BINDING');
  expect(existsSync(join(f.workspace, 'src'))).toBe(false); expect(f.actions.getApply(f.fence(), f.key).apply).toBeNull();
});
it('keeps real workspace quarantined and reservation held if completeApply fails before commit', async () => {
  const f = await physicalFixture(); const spy = vi.spyOn(GraphActionStore.prototype, 'completeApply').mockImplementation(() => { throw Error('DB failed'); });
  try { expect(f.applyHost.apply(f.applyInput, f.fence()).kind).toBe('quarantined'); } finally { spy.mockRestore(); }
  expect(f.actions.getApply(f.fence(), f.key).apply?.resolution?.kind).toBe('quarantined');
  expect(f.actions.get(f.fence(), f.key)).toMatchObject({ action: { state: 'unknown' }, budget: { reservedTokens: '1100' } });
  expect(readFileSync(join(f.workspace, 'src/a.ts'), 'utf8')).toBe('new');
});
it('does not overwrite a committed receipt when completeApply loses its ACK', async () => {
  const f = await physicalFixture(); const complete = GraphActionStore.prototype.completeApply;
  const spy = vi.spyOn(GraphActionStore.prototype, 'completeApply').mockImplementation(function (this: GraphActionStore, ...args) { complete.apply(this, args); throw Error('lost ACK'); });
  try { expect(f.applyHost.apply(f.applyInput, f.fence()).reconciliationRequired).toBe(true); } finally { spy.mockRestore(); }
  expect(f.actions.getApply(f.fence(), f.key).apply?.resolution?.kind).toBe('applied');
  expect(f.actions.get(f.fence(), f.key).action.state).toBe('confirmed');
});
it('blocks physical apply when the provider terminal artifact is missing', async () => {
  const f = await physicalFixture(); const read = f.store.read.bind(f.store);
  vi.spyOn(f.store, 'read').mockImplementation((ref, binding) => { if (ref === f.invocation.terminalRef) throw Error('missing'); return read(ref, binding); });
  expect(() => f.applyHost.apply(f.applyInput, f.fence())).toThrow('missing'); expect(existsSync(join(f.workspace, 'src'))).toBe(false);
});
it('stops physical application when canonical admission is released between file boundaries', async () => {
  const f = await physicalFixture();
  const host = new GraphChangesetApplyHost(f.db, f.store, { verify: () => {
    if (existsSync(join(f.workspace, 'src'))) new GraphAdmissionStore(f.db).released(f.key, Date.now());
  } });
  expect(host.apply(f.applyInput, f.fence()).kind).toBe('quarantined');
  expect(existsSync(join(f.workspace, 'src/a.ts'))).toBe(false);
  expect(f.actions.get(f.fence(), f.key).action.state).toBe('unknown');
  expect(f.actions.getApply(f.fence(), f.key).apply?.resolution?.kind).toBe('quarantined');
});
it('does not silently adopt a new revision between authorized journal verification and apply gate', async () => {
  const f = await physicalFixture(); const read = f.store.read.bind(f.store); let changed = false;
  vi.spyOn(f.store, 'read').mockImplementation((ref, binding) => {
    const bytes = read(ref, binding);
    if (!changed && (binding as { kind: string }).kind === 'apply_journal') { changed = true; f.runs.renewLease({ ...f.fence(), leaseExpiresAt: Date.now() + 120000 }); }
    return bytes;
  });
  expect(f.applyHost.apply(f.applyInput, f.fence()).kind).toBe('reconciliation_required');
  expect(existsSync(join(f.workspace, 'src'))).toBe(false);
  expect(f.actions.getApply(f.fence(), f.key).apply).toBeNull();
});


async function freezeFixture(orphan = false) {
  const f = await physicalFixture(true);
  const spy = orphan ? vi.spyOn(GraphActionStore.prototype, 'completeApply').mockImplementation(() => { throw Error('commit unavailable'); }) : undefined;
  try { f.applyHost.apply(f.applyInput, f.fence()); } finally { spy?.mockRestore(); }
  const scope = await resolveRepositoryScope(f.workspace);
  const apply = f.actions.getApply(f.fence(), f.key).apply!;
  const receipt = f.store.lookup({ schemaVersion: 1, scope: f.scope, runId: f.run.graphRunId, generation: 1, effectKey: f.key,
    requestDigest: f.invocation.result.requestDigest, kind: 'apply_complete' });
  if (!receipt) throw Error('fixture apply receipt');
  const input = { artifactId: 'changeset-freeze', scope: f.scope, runId: f.run.graphRunId, generation: 1, owner: 'worker',
    workspaceLeaseRef: 'workspace', repoId: scope.repoId, commonDir: scope.commonDir, worktreePath: f.workspace,
    baseRevision: f.git('rev-parse', 'HEAD'), implementationReceiptRef: receipt, producerStopEvidenceRef: f.invocation.terminalRef };
  const artifacts = new GraphArtifactStore(join(f.root, 'artifacts'));
  const authority = { lease: {}, verifyLease: vi.fn(() => undefined), verifyProducersStopped: vi.fn(() => undefined) };
  const freeze = () => freezeGraphChangeset({ db: f.db, evidence: f.store, artifacts, effectKey: f.key, input, fence: f.fence(), authority });
  return { ...f, input, artifacts, authority, freeze, apply };
}
it('freezes, restores and replays exactly the ledger-confirmed applied candidate', async () => {
  const f = await freezeFixture(); const candidate = await f.freeze();
  expect((await f.artifacts.verify(candidate.artifactDigest)).tree).toBe(f.apply.intent.targetTreeRevision);
  expect(await f.freeze()).toEqual(candidate);
  const restored = await f.artifacts.restore(candidate.artifactDigest, { rootPath: f.root, directoryName: 'review' });
  expect(readFileSync(join(restored.worktreePath, 'src/a.ts'), 'utf8')).toBe('new');
  expect(readFileSync(join(restored.worktreePath, 'keep.txt'), 'utf8')).toBe('updated');
  expect(existsSync(join(restored.worktreePath, 'remove.txt'))).toBe(false);
  expect(f.authority.verifyProducersStopped).toHaveBeenCalled(); expect(f.fetcher).toHaveBeenCalledTimes(1);
}, 15000);
it('refuses extra changes after apply instead of freezing them into the candidate', async () => {
  const f = await freezeFixture(); writeFileSync(join(f.workspace, 'keep.txt'), 'late producer');
  await expect(f.freeze()).rejects.toThrow('applied tree mismatch');
});
it.each(['receipt', 'stop', 'scope', 'lease', 'owner', 'base'] as const)('refuses mismatched freeze %s binding', async field => {
  const f = await freezeFixture();
  if (field === 'receipt') f.input.implementationReceiptRef = 'forged';
  if (field === 'stop') f.input.producerStopEvidenceRef = 'forged';
  if (field === 'scope') f.input.scope = { ...f.scope, principalId: 'other' };
  if (field === 'lease') f.input.workspaceLeaseRef = 'other';
  if (field === 'owner') f.input.owner = 'other';
  if (field === 'base') f.input.baseRevision = 'f'.repeat(40);
  await expect(f.freeze()).rejects.toThrow('FREEZE_APPLY_BINDING');
  expect(f.authority.verifyLease).not.toHaveBeenCalled();
});
it('refuses an orphan completion artifact without the committed apply resolution', async () => {
  const f = await freezeFixture(true);
  await expect(f.freeze()).rejects.toThrow('FREEZE_APPLY_BINDING');
});
it('rechecks fenced state after asynchronous physical authority verification', async () => {
  const f = await freezeFixture();
  f.authority.verifyLease.mockImplementation(() => { f.runs.project({ ...f.fence(), status: 'cancel_pending' }); });
  await expect(f.freeze()).rejects.toThrow('FREEZE_APPLY_BINDING');
});
it('does not substitute provider completion for physical producer stop proof', async () => {
  const f = await freezeFixture(); f.authority.verifyProducersStopped.mockImplementation(() => { throw Error('producer still active'); });
  await expect(f.freeze()).rejects.toThrow('producer still active');
});

it('refuses freeze after implementation admission was released', async () => {
  const f = await freezeFixture(); new GraphAdmissionStore(f.db).released(f.key, Date.now());
  await expect(f.freeze()).rejects.toThrow('FREEZE_ADMISSION_REQUIRED');
});
it('rejects gitignored extra files planted after apply', async () => {
  const f = await freezeFixture(); f.git('config', 'core.excludesFile', join(f.root, 'ignore'));
  writeFileSync(join(f.root, 'ignore'), 'hidden.txt\n'); writeFileSync(join(f.workspace, 'hidden.txt'), 'late');
  await expect(f.freeze()).rejects.toThrow('applied tree mismatch');
});

it('rejects admission release during receipt evidence reads', async () => {
  const f = await freezeFixture(); const read = f.store.read.bind(f.store); let released = false;
  vi.spyOn(f.store, 'read').mockImplementation((ref, binding) => {
    const bytes = read(ref, binding);
    if (!released) { released = true; new GraphAdmissionStore(f.db).released(f.key, Date.now()); }
    return bytes;
  });
  await expect(f.freeze()).rejects.toThrow('FREEZE_ADMISSION_REQUIRED');
});
