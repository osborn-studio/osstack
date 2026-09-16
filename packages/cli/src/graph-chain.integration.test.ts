import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { openDb, GraphRunStore, GraphCheckpointStore, type GraphProgramVersion } from '@osstack/core';
import type { StartGraphRequest } from '@osstack/protocol';
import { GraphRuntime } from './graph-runtime.js';
import { GraphActionBroker } from './graph-action-broker.js';
import { GraphCheckpointService } from './graph-checkpoint-service.js';

const priorHome = process.env['OSSTACK_HOME'];
// Optional evidence-launcher override; normal runs use the hermetic suite home.
if (process.env['G17_TEST_HOME']) process.env['OSSTACK_HOME'] = process.env['G17_TEST_HOME'];
afterAll(() => { if (priorHome === undefined) delete process.env['OSSTACK_HOME']; else process.env['OSSTACK_HOME'] = priorHome; });
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
function fixture(programSource?: string) {
  const root = mkdtempSync(join(tmpdir(), 'g17-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openDb({ path: join(root, 'state.db') }); cleanup.push(() => { db.close(); });
  const modulePath = join(root, 'program.mjs'); const source = programSource ?? 'export async function run(context) { return await context.task("value", async () => 42)(); }';
  writeFileSync(modulePath, source);
  const programs = [{ id: 'chain', modulePath, digest: createHash('sha256').update(source).digest('hex') }];
  const version: GraphProgramVersion = { executionModel: 'langgraph-functional-v1', durability: 'sync', engineVersion: '1.4.15', checkpointVersion: '1.1.5', templateVersion: '1', registryVersion: '1', compilerVersion: '1', schemaVersion: '1', compiledProgramDigest: programs[0]!.digest };
  const request: StartGraphRequest = { schemaVersion: 1, kind: 'start', scope: { schemaVersion: 1, tenantId: 'tenant', principalId: 'principal', workspaceId: 'workspace' }, idempotencyKey: 'start', inputArtifactRef: 'input', source: { product: 'osstack', requestId: 'request' }, spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only', input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: 'a'.repeat(40), acceptanceRef: 'acceptance' }, limits: { maxEpochs: 1, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 5, deadlineSeconds: 120, tokenReservationLimit: 100 } } };
  const broker = new GraphActionBroker(db, { acquire: async () => { throw new Error('no action registered'); } });
  const checkpoints = new GraphCheckpointService({ runs: new GraphRunStore(db), checkpoints: new GraphCheckpointStore(db), bindings: new Map() });
  const runtimeOptions = { db, broker, checkpoints, programs, workerOptions: { shutdownTimeoutMs: 30, terminationTimeoutMs: 30 } };
  const runtime = new GraphRuntime(runtimeOptions);
  cleanup.push(() => runtime.close());
  return { root, db, runtime, broker, checkpoints, request, version, runtimeOptions };
}
it('uses real worker IPC and durable SQLite checkpoints, retires both ports and exposes OS exit', async () => {
  const f = fixture(); const prepared = f.runtime.prepare(f.request, f.version);
  expect(prepared.generation).toBe(0);
  const run = f.runtime.claim(prepared, 'owner', Date.now() + 30_000);
  const handle = f.runtime.start({ request: f.request, run, programId: 'chain', authorize: () => {}, registration: {
    scope: run.scope, graphRunId: run.graphRunId, identity: run.identity, generation: run.generation, owner: 'owner', epoch: 0,
    workspace: { workspace_id: 'workspace', workspace_path: f.root }, authorize: () => {}, actions: [],
  } });
  expect(await handle.result).toBe(42);
  const stopped = await handle.stop(); expect(stopped.worker.kind).toBe('exited'); expect(stopped.actionsSettled).toBe(true);
  expect(f.runtime.observedExit(handle.connection)).toEqual(stopped.worker);
  expect(f.db.prepare('SELECT count(*) AS n FROM graph_checkpoints').get()).toMatchObject({ n: expect.any(Number) });
  expect((f.db.prepare('SELECT count(*) AS n FROM graph_checkpoints').get() as { n: number }).n).toBeGreaterThan(0);
  await expect(f.checkpoints.execute(handle.connection, { kind: 'get', threadId: run.graphRunId, namespace: '' })).rejects.toThrow('UNAUTHENTICATED');
  expect(await f.broker.handle(handle.connection, {})).toMatchObject({ kind: 'worker_action_rejected' });
  expect(() => f.runtime.claim(run, 'another', Date.now() + 30_000)).toThrow('RECOVERY_REQUIRED');
});
it('rejects asynchronous authority and terminal/old identities before spawning', () => {
  const f = fixture(); const run = f.runtime.claim(f.runtime.prepare(f.request, f.version), 'owner', Date.now() + 30_000);
  expect(() => f.runtime.start({ request: f.request, run, programId: 'chain', authorize: async () => {}, registration: {
    scope: run.scope, graphRunId: run.graphRunId, identity: run.identity, generation: run.generation, owner: 'owner', epoch: 0,
    workspace: { workspace_id: 'workspace', workspace_path: f.root }, authorize: () => {}, actions: [],
  } })).toThrow('GRAPH_AUTHORITY_MUST_BE_SYNC');
});

// Build a dedicated trusted host process from actual source. All production
// dependencies stay external; only this fixture owns fault interception.
import { fork, ChildProcess, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const buildRoot = mkdtempSync(join(tmpdir(), 'g17-build-'));
const builtFixture = join(buildRoot, 'graph-chain-host.mjs');
let built = false;
function buildFixture() {
  if (built) return; built = true;
  const modules = join(buildRoot, 'node_modules');
  if (!existsSync(modules)) symlinkSync(resolve(repoRoot, 'packages/cli/node_modules'), modules, 'dir');
  execFileSync(resolve(repoRoot, 'node_modules/.bin/esbuild'), [resolve(repoRoot, 'scripts/fixtures/graph-chain-host.ts'), '--bundle', '--platform=node', '--format=esm', '--packages=external', `--outfile=${builtFixture}`], { cwd: repoRoot });
}
async function host(mode: 'assembly' | 'daemon', existingRoot?: string, deadlineSeconds = 120) {
  buildFixture(); const root = existingRoot ?? mkdtempSync(join(tmpdir(), 'g17-chain-'));
  // Keep all fixture evidence under gc5 for parent inspection, including failures.
  const child = fork(builtFixture, [root, mode, String(deadlineSeconds)], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, OSSTACK_HOME: process.env['G17_TEST_HOME'] ?? join(root, 'home'), OSSTACK_DASHBOARD: '0' } });
  let output = ''; let sequence = 0; const messages: Array<Record<string, any>> = []; const changed = new Set<() => void>();
  child.stdout!.on('data', chunk => { output += String(chunk); }); child.stderr!.on('data', chunk => { output += String(chunk); });
  child.on('message', message => { messages.push(message as Record<string, any>); for (const fn of changed) fn(); });
  child.on('exit', () => { writeFileSync(join(root, `host-${child.pid}.log`), output); for (const fn of changed) fn(); });
  const next = async (predicate: (message: Record<string, any>) => boolean, timeout = 15_000): Promise<Record<string, any>> => {
    const take = () => { const index = messages.findIndex(predicate); return index < 0 ? undefined : messages.splice(index, 1)[0]; };
    const found = take(); if (found) return found;
    return new Promise((resolveNext, reject) => {
      const check = () => { const message = take(); if (message) { clearTimeout(timer); changed.delete(check); resolveNext(message); }
        else if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); changed.delete(check); reject(new Error(`Host exited: ${output}`)); } };
      const timer = setTimeout(() => { changed.delete(check); reject(new Error(`Fixture timeout: ${JSON.stringify(messages)}\n${output}`)); }, timeout);
      changed.add(check); check();
    });
  };
  const call = async (op: string, input: Record<string, unknown> = {}) => {
    const id = ++sequence; child.send({ id, op, ...input }); const result = await next(message => message['id'] === id);
    if (result['error']) throw new Error(String(result['error']) + '\n' + String(result['stack'])); return result['value'];
  };
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { try { await call('close'); } catch { child.kill('SIGKILL'); } } });
  await next(message => message['event'] === 'ready');
  return { child, root, call, next };
}
async function killHost(child: ChildProcess): Promise<void> {
  const exit = new Promise<void>(done => child.once('exit', () => done())); child.kill('SIGKILL'); await exit;
}
for (const mode of ['assembly', 'daemon'] as const) {
  it(`${mode}: real command implement → freeze persists a selfcontained candidate`, async () => {
    const h = await host(mode); if (mode === 'daemon') await expect(h.call('singleton')).rejects.toThrow('GRAPH_RUNTIME_ALREADY_CONFIGURED'); await h.call('start'); const result = await h.next(message => message['event'] === 'result' || message['event'] === 'result-error');
    expect(result['event'], JSON.stringify(result)).toBe('result'); expect(result['result']).toMatchObject({ kind: 'candidate_ready' });
    const stopped = await h.call('stop'); expect(stopped).toMatchObject({ actionsSettled: true, worker: { kind: 'exited', signal: 'SIGKILL' } });
    const state = await h.call('inspect'); expect(state.external).toBe('once\n'); expect(state.budget.actionStarts).toBe(2); expect(state.actions.map((a: {state: string}) => a.state)).toEqual(['confirmed', 'confirmed']);
    const verified = await h.call('verify'); expect(verified.content).toBe('after\n'); expect(verified.manifest.candidateRevision).toBe(result['result'].candidateRevision);
  }, 25_000);
}
for (const mode of ['assembly', 'daemon'] as const) {
it.each(['before-return', 'before-final', 'after-final'] as const)(`${mode}: SIGKILL at %s resumes using actual SQLite saver and ledger`, async fault => {
  const h = await host(mode); await h.call('start', { fault }); await h.next(message => message['event'] === 'boundary');
  await h.call('stop'); const before = await h.call('inspect'); expect(before.external).toBe('once\n');
  expect(before.actions[0].state).toBe('confirmed');
  const returns = before.writes.filter((write: { channel: string; value: string }) => write.channel === '__return__' && write.value.includes('implementation_complete'));
  expect(returns.length).toBe(fault === 'before-return' ? 0 : 1);
  expect(before.finalCheckpoints.n).toBe(fault === 'after-final' ? 1 : 0);
  await h.call('takeover'); expect(await h.call('old-action')).toMatchObject({ kind: 'worker_action_rejected', error: { code: 'UNAUTHENTICATED' } }); await h.call('start'); const result = await h.next(message => message['event'] === 'result');
  expect(result['result'].kind).toBe('candidate_ready'); await h.call('stop');
  const after = await h.call('inspect'); expect(after.external).toBe('once\n'); expect(after.budget.actionStarts).toBe(2);
  const count = (value: string) => value.split('\n').filter(line => line.startsWith('implement:')).length;
  expect(count(after.reentries)).toBe(fault === 'before-return' ? 2 : 1);
}, 25_000);
it(`${mode}: restore then SIGKILL again re-enters implement without repeating the confirmed external command`, async () => {
  const h = await host(mode);
  for (let crash = 0; crash < 2; crash++) {
    await h.call('start', { fault: 'before-return' }); await h.next(message => message['event'] === 'boundary'); await h.call('stop'); await h.call('takeover');
  }
  await h.call('start'); await h.next(message => message['event'] === 'result'); await h.call('stop');
  const state = await h.call('inspect'); expect(state.external).toBe('once\n'); expect(state.reentries.split('\n').filter((line: string) => line.startsWith('implement:'))).toHaveLength(3); expect(state.budget.actionStarts).toBe(2);
}, 25_000);
}
it('daemon: true daemon process SIGKILL/restart retains SQLite results and resumes through G15', async () => {
  const first = await host('daemon'); await first.call('start', { fault: 'before-return' }); await first.next(message => message['event'] === 'boundary');
  const receipt = await first.call('stop'); expect(receipt.worker.kind).toBe('exited'); await killHost(first.child);
  const second = await host('daemon', first.root); expect(second.child.pid).not.toBe(first.child.pid);
  await second.call('takeover'); await second.call('start'); await second.next(message => message['event'] === 'result'); await second.call('stop');
  const state = await second.call('inspect'); expect(state.external).toBe('once\n'); expect(state.budget.actionStarts).toBe(2);
  expect(readFileSync(join(first.root, 'stopped.json'), 'utf8')).toContain('worker-exit:');
}, 30_000);
for (const mode of ['assembly', 'daemon'] as const) {
it(`${mode}: real broker unknown stays quarantined, then durable applied release failure is retried without resending`, async () => {
  const h = await host(mode); await h.call('start', { fault: 'unknown' }); await h.next(message => message['event'] === 'result-error'); await h.call('stop');
  let state = await h.call('inspect'); expect(state.external).toBe('once\n'); expect(state.actions[0].state).toBe('unknown'); expect(state.lock).not.toBeNull();
  const unknown = await h.call('reconcile', { verdict: 'unknown', receiptId: 'still-unknown' }); expect(unknown.exit).toBe('unknown');
  await expect(h.call('takeover')).rejects.toThrow('UNRESOLVED');
  const failed = await h.call('reconcile', { verdict: 'applied', receiptId: 'applied', releaseFails: true }); expect(failed.exit).toBe('release_pending');
  state = await h.call('inspect'); expect(state.actions[0].state).toBe('confirmed'); expect(state.lock).not.toBeNull();
  const released = await h.call('reconcile', { verdict: 'applied', receiptId: 'applied' }); expect(released.exit).toBe('applied');
  state = await h.call('inspect'); expect(state.lock).toBeNull(); expect(state.external).toBe('once\n'); expect(state.budget.actionStarts).toBe(1);
}, 25_000);
it(`${mode}: trusted not_applied reconciliation releases exact retained broker lease without automatically retrying`, async () => {
  const h = await host(mode); await h.call('start', { fault: 'unknown-not-applied' }); await h.next(message => message['event'] === 'result-error'); await h.call('stop');
  const unknown = await h.call('inspect'); expect(unknown.external).toBe(''); expect(unknown.actions[0].state).toBe('unknown'); expect(unknown.lock).not.toBeNull();
  const result = await h.call('reconcile', { verdict: 'not_applied', receiptId: 'absent' }); expect(result.exit).toBe('not_applied');
  const after = await h.call('inspect'); expect(after.external).toBe(''); expect(after.actions[0].state).toBe('failed'); expect(after.lock).toBeNull(); expect(after.budget.actionStarts).toBe(1);
}, 25_000);
it(`${mode}: cancel reaches actual command process group and kills abort-ignoring worker without starting freeze`, async () => {
  const h = await host(mode); await h.call('start', { fault: 'cancel' });
  let state = await h.call('inspect'); const deadline = Date.now() + 5000;
  while (!state.external && Date.now() < deadline) { await new Promise(done => setTimeout(done, 20)); state = await h.call('inspect'); }
  expect(state.external).toBe('started\n'); const stop = await h.call('stop'); expect(stop.worker).toMatchObject({ kind: 'exited', signal: 'SIGKILL' });
  state = await h.call('inspect'); expect(state.actions).toHaveLength(1); expect(state.reentries).not.toContain('freeze:');
  const commandPid = Number(readFileSync(join(h.root, 'command.pid'), 'utf8'));
  await expect.poll(() => { try { process.kill(commandPid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } }, { timeout: 5000 }).toBe(true);
  // Drained calls are not an external stop receipt. If G04 cannot prove stop,
  // the actual broker preserves an unresolved ledger row and canonical lock.
  if (state.actions[0].state === 'unknown' || state.actions[0].state === 'running') expect(state.lock).not.toBeNull();
  else { const evidence = JSON.parse(readFileSync(join(h.root, 'implementation.json'), 'utf8')); expect(evidence.command.termination).toMatchObject({ scope: 'posix_process_group', stop_confirmed: true }); }
}, 25_000);
}
it('module: a fresh supervisor cannot relaunch a consumed generation from the persistent database', async () => {
  const f = fixture(); const run = f.runtime.claim(f.runtime.prepare(f.request, f.version), 'owner', Date.now() + 30_000);
  const start = { request: f.request, run, programId: 'chain', authorize: () => {}, registration: {
    scope: run.scope, graphRunId: run.graphRunId, identity: run.identity, generation: run.generation, owner: 'owner', epoch: 0,
    workspace: { workspace_id: 'workspace', workspace_path: f.root }, authorize: () => {}, actions: [],
  } };
  const first = f.runtime.start(start); expect(await first.result).toBe(42); await first.stop(); await f.runtime.close();
  const secondDb = openDb({ path: join(f.root, 'state.db') }); cleanup.push(() => { secondDb.close(); });
  const runs = new GraphRunStore(secondDb); const second = new GraphRuntime({ ...f.runtimeOptions, db: secondDb,
    checkpoints: new GraphCheckpointService({ runs, checkpoints: new GraphCheckpointStore(secondDb), bindings: new Map() }) }); cleanup.push(() => second.close());
  const duplicate = second.start({ ...start, run: runs.get(run.scope, run.graphRunId)! });
  await expect(duplicate.result).rejects.toThrow('GRAPH_GENERATION_ALREADY_LAUNCHED');
  expect((await duplicate.exit).kind).toBe('spawn_failed');
});
it('daemon: unknown retained canonical lock survives actual daemon SIGKILL and releases only after G15 committed decision', async () => {
  const first = await host('daemon'); await first.call('start', { fault: 'unknown' }); await first.next(message => message['event'] === 'result-error');
  await first.call('stop'); const before = await first.call('inspect'); expect(before.lock).not.toBeNull(); expect(before.actions[0].state).toBe('unknown');
  await killHost(first.child); const second = await host('daemon', first.root);
  expect((await second.call('inspect')).lock).toEqual(before.lock);
  const pending = await second.call('reconcile', { verdict: 'applied', receiptId: 'restart-applied', releaseFails: true }); expect(pending.exit).toBe('release_pending');
  expect((await second.call('inspect')).lock).toEqual(before.lock);
  const released = await second.call('reconcile', { verdict: 'applied', receiptId: 'restart-applied' }); expect(released.exit).toBe('applied');
  const after = await second.call('inspect'); expect(after.lock).toBeNull(); expect(after.external).toBe('once\n'); expect(after.actions[0].state).toBe('confirmed'); expect(after.budget.actionStarts).toBe(1);
  await second.call('takeover'); await second.call('start'); await second.next(message => message['event'] === 'result'); await second.call('stop'); expect((await second.call('verify')).content).toBe('after\n');
}, 30_000);
it('module: durable original deadline refuses a live lease and cannot be reset by start', () => {
  const f = fixture(); f.request.spec.limits.deadlineSeconds = 1;
  const prior = new GraphRunStore(f.db).create(f.request, f.version, Date.now() - 2000);
  const run = f.runtime.claim(prior, 'owner', Date.now() + 30_000);
  expect(() => f.runtime.start({ request: f.request, run, programId: 'chain', authorize: () => {}, registration: {
    scope: run.scope, graphRunId: run.graphRunId, identity: run.identity, generation: run.generation, owner: 'owner', epoch: 0,
    workspace: { workspace_id: 'workspace', workspace_path: f.root }, authorize: () => {}, actions: [],
  } })).toThrow('GRAPH_DEADLINE_EXCEEDED');
});
for (const mode of ['assembly', 'daemon'] as const) {
  it(`${mode}: bounded stop reports undrained actual broker Promise and refuses recovery before drainage`, async () => {
    const h = await host(mode); await h.call('start', { fault: 'hold-persist' }); await h.next(message => message['event'] === 'boundary');
    const stopped = await h.call('stop', { releaseHold: false }); expect(stopped).toMatchObject({ actionsSettled: false, worker: { kind: 'exited' } });
    const held = await h.call('inspect'); expect(held.actions[0].state).toBe('running'); expect(held.lock).not.toBeNull();
    await expect(h.call('takeover')).rejects.toThrow('NO_OBSERVED_EXIT');
    await h.call('release-hold'); const drained = await h.call('stop'); expect(drained.actionsSettled).toBe(true);
    const settled = await h.call('inspect'); expect(settled.actions[0].state).toBe('confirmed'); expect(settled.actions).toHaveLength(1); expect(settled.external).toBe('once\n');
  }, 25_000);
  it(`${mode}: original deadline aborts actual in-flight command through supervisor heartbeat`, async () => {
    const h = await host(mode, undefined, 2); await h.call('start', { fault: 'cancel' });
    const result = await h.next(message => message['event'] === 'result-error'); expect(result['error']).toContain('GRAPH_DEADLINE_EXCEEDED');
    const stopped = await h.call('stop'); expect(stopped.worker.kind).toBe('exited');
    const state = await h.call('inspect'); expect(state.actions).toHaveLength(1); expect(state.reentries).not.toContain('freeze:');
  }, 25_000);
  it(`${mode}: stubborn command cancellation settles after proven process-group exit`, async () => {
    const h = await host(mode); await h.call('start', { fault: 'cancel-stubborn' });
    let state = await h.call('inspect'); const deadline = Date.now() + 5000;
    while (!state.external && Date.now() < deadline) { await new Promise(done => setTimeout(done, 20)); state = await h.call('inspect'); }
    expect(state.external).toBe('started\n'); const stopped = await h.call('stop'); expect(stopped.worker.signal).toBe('SIGKILL');
    // Bounded host drainage can finish before the command's TERM/KILL sequence.
    await expect.poll(async () => (await h.call('stop')).actionsSettled, { timeout: 5000 }).toBe(true);
    state = await h.call('inspect'); expect(state.actions).toHaveLength(1); expect(state.actions[0].state).toBe('failed');
    expect(JSON.parse(state.actions[0].outcome_json)).toMatchObject({ state: 'failed', retrySafe: false });
    const evidence = JSON.parse(readFileSync(join(h.root, 'implementation.json'), 'utf8'));
    expect(evidence).toMatchObject({ stopped: true, command: { termination: { scope: 'posix_process_group', stop_confirmed: true } } });
    const pid = Number(readFileSync(join(h.root, 'command.pid'), 'utf8'));
    await expect.poll(() => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } }, { timeout: 5000 }).toBe(true);
    expect(evidence.command.termination.pgid).toBe(pid);
    expect((await h.call('inspect')).lock).toBeNull(); expect(state.reentries).not.toContain('freeze:');
  }, 25_000);
}
it('module: late actual worker OS exit replaces unconfirmed observation without rewriting bounded stop', async () => {
  const f = fixture('export async function run(context) { process.on("SIGTERM",()=>{}); process.on("unhandledRejection",()=>{}); setInterval(()=>{},1000); console.log("waiting"); return context.task("wait",async()=>new Promise(()=>{}))(); }');
  const run = f.runtime.claim(f.runtime.prepare(f.request, f.version), 'owner', Date.now() + 30_000);
  const h = f.runtime.start({ request: f.request, run, programId: 'chain', authorize: () => {}, registration: {
    scope: run.scope, graphRunId: run.graphRunId, identity: run.identity, generation: run.generation, owner: 'owner', epoch: 0,
    workspace: { workspace_id: 'workspace', workspace_path: f.root }, authorize: () => {}, actions: [],
  } });
  await h.ready; await expect.poll(() => h.logs().stdout).toContain('waiting'); const ignoreKill = vi.spyOn(ChildProcess.prototype, 'kill').mockReturnValue(true);
  let pid: number | undefined;
  try {
    const stop = await h.stop(); expect(stop.worker.kind).toBe('exit_unconfirmed');
    if (stop.worker.kind !== 'exit_unconfirmed') throw new Error('expected unconfirmed worker'); pid = stop.worker.pid;
    process.kill(pid!, 'SIGKILL'); const actual = await h.finalExit; expect(actual.kind).toBe('exited');
    expect(f.runtime.observedExit(h.connection)).toEqual(actual); expect(await h.exit).toEqual(stop.worker);
  } finally { ignoreKill.mockRestore(); if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ } } }
});

it('keeps a database lifetime barrier after bounded stop reports pending host work', async () => {
  const f = fixture(`export async function run(ctx) { return await ctx.action({schemaVersion:1,kind:'worker_action',requestId:'one',scope:ctx.input.scope,graphRunId:ctx.binding.graphRunId,specHash:ctx.binding.identity.specHash,generation:ctx.binding.generation,epoch:0,nodeId:'workspace',effectSlot:'main',action:{kind:'workspace_create',repositoryRef:'repo',baseRevision:ctx.input.spec.input.baseRevision}}); }`);
  const runtime = new GraphRuntime({ ...f.runtimeOptions, drainTimeoutMs: 5 });
  let release = () => {}; const blocked = new Promise<void>(resolve => { release = resolve; }); let entered = false; let dbUsed = false;
  const run = runtime.claim(runtime.prepare(f.request, f.version), 'owner', Date.now() + 30000);
  const handle = runtime.start({ request: f.request, run, programId: 'chain', authorize: () => {}, registration: {
    scope: run.scope, graphRunId: run.graphRunId, identity: run.identity, generation: run.generation, owner: 'owner', epoch: 0,
    workspace: { workspace_id: 'workspace', workspace_path: f.root }, authorize: () => {}, actions: [],
  }, dispatch: async () => {
    entered = true; await blocked;
    // Represents broker persistence/release continuing after a bounded stop.
    dbUsed = !!f.db.prepare('SELECT graph_run_id FROM graph_runs WHERE graph_run_id=?').get(run.graphRunId);
    throw Error('HOST_OPERATION_RETIRED');
  } });
  void handle.result.catch(() => {});
  try {
    await expect.poll(() => entered).toBe(true);
    expect((await handle.stop()).actionsSettled).toBe(false); await runtime.close();
    let drained = false; const barrier = runtime.drainDatabaseUsers().then(() => { drained = true; });
    await new Promise(resolve => setTimeout(resolve, 30)); expect(drained).toBe(false); expect(dbUsed).toBe(false);
    release(); await barrier; expect(dbUsed).toBe(true); expect(drained).toBe(true);
  } finally { release(); await runtime.close(); await runtime.drainDatabaseUsers(); }
}, 10000);
