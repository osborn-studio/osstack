import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { constants, openSync, fstatSync, readSync } from 'node:fs';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, openSync: vi.fn(fs.openSync), fstatSync: vi.fn(fs.fstatSync), readSync: vi.fn(fs.readSync) };
});
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
import { GraphActionStore, GraphRunStore, openDb } from '@osstack/core';
import { GraphAdmissionStore } from '@osstack/core/graph-recovery';
import { createContainedCommandExecutor, prepareContainedImage, type ContainedImageReceipt } from '@osstack/agents';
import { verificationCanonical } from '@osstack/graph/nodes/branch';
import { processFixture } from './graph-process-fixture.js';
import { GraphProcessJournal } from './graph-process-journal.js';
import { GraphReconciler } from './graph-reconciler.js';
import { reopenGraphContainedTests, type ReopenContainedTests } from './graph-contained-recovery.js';
import { sweepGraphQuiescence } from './graph-quiescence-sweep.js';
import { verifyJournaledGraphWorkerExit } from './graph-worker-exit-proof.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.mocked(openSync).mockReset(); vi.mocked(fstatSync).mockReset(); vi.mocked(readSync).mockReset(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'g25-reopen-'))); const f = processFixture(root); let db = f.db; let run = f.run;
  cleanup.push(async () => { await f.runtime.close(); await f.runtime.drainDatabaseUsers(); if (db.open) db.close(); rmSync(root, { recursive: true, force: true }); });
  const fence = () => ({ scope: run.scope, graphRunId: run.graphRunId, identity: run.identity, expectedGeneration: run.generation,
    expectedOwner: run.leaseOwner, expectedRevision: run.revision, now: Date.now() });
  const actions = new GraphActionStore(db);
  const reserved = actions.reserve(fence(), { epoch: 0, nodeId: 'tests', effectSlot: 'invoke', reservationTokens: 10,
    action: { kind: 'tests', candidateRevision: 'a'.repeat(40), commandSpecRef: 'accept', workspaceLeaseRef: 'lease' } });
  run = reserved.run; const effectKey = reserved.action.effectKey; const invocationId = 'fresh-host-invocation';
  new GraphAdmissionStore(db).hold(effectKey, Date.now());
  run = actions.markRunning(fence(), effectKey, `graph-execution:${effectKey}:${invocationId}`).run;
  const journalRoot = join(root, 'journal'); mkdirSync(journalRoot);
  const containers = new Map<string, { config: Record<string, unknown>; removed: boolean }>(); let lostDelete = false; let running = false;
  let canStop = true; let canRead = true; const calls: string[] = [];
  let host = { socketPath: join(root, 'docker.sock'), daemonId: 'daemon', baseImageId: 'sha256:' + 'b'.repeat(64) };
  let image: ContainedImageReceipt = { version: 1, daemonId: host.daemonId, baseImageId: host.baseImageId, imageId: host.baseImageId,
    contentDigest: 'c'.repeat(64), archiveDigest: 'd'.repeat(64), workingDirectory: '/osstack-candidate-00000000-0000-4000-8000-000000000000' };
  const real = process.env['G25_CONTAINED_CONFIG'];
  if (real) {
    host = JSON.parse(readFileSync(real, 'utf8')) as typeof host;
    image = await prepareContainedImage({ ...host, authorize: () => {} }, [{ path: 'file', mode: '100644', bytes: Buffer.from('candidate') }]);
  } else {
    const server = createServer(async (req, res) => {
      const path = req.url!; calls.push(`${req.method} ${path}`);
      if (path.endsWith('/info')) { res.end(JSON.stringify({ ID: host.daemonId, OSType: 'linux' })); return; }
      if (path.endsWith('/create')) { let body = ''; for await (const part of req) body += part;
        const id = containers.size === 0 ? 'e'.repeat(64) : sha(String(containers.size));
        containers.set(id, { config: JSON.parse(body) as Record<string, unknown>, removed: false }); res.writeHead(201).end(JSON.stringify({ Id: id })); return; }
      const id = /containers\/([a-f0-9]{64})/.exec(path)?.[1]; const container = id ? containers.get(id) : undefined;
      if (!container || container.removed) { res.writeHead(404).end(); return; }
      const config = container.config;
      if (req.method === 'DELETE') { container.removed = true; res.writeHead(lostDelete ? 500 : 204).end(); return; }
      if (path.endsWith('/start')) { res.writeHead(204).end(); return; }
      if (path.includes('/logs?')) { res.end(); return; }
      res.end(JSON.stringify({ Id: id, Image: image.imageId, Config: config!, HostConfig: { ...(config!['HostConfig'] as object), CapAdd: null }, Mounts: [], State: { Status: running ? 'running' : 'exited', Running: running, ExitCode: 0 } }));
    });
    await new Promise<void>(resolve => server.listen(host.socketPath, resolve));
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  }
  const options = { ...host, journalRoot, authorizeRead: () => { if (!canRead) throw Error('read revoked'); }, authorizeStop: () => { if (!canStop) throw Error('stop revoked'); } };
  const binding = { scope: run.scope, graphRunId: run.graphRunId, specHash: run.identity.specHash, epoch: 0, candidateRevision: 'a'.repeat(40), artifactDigest: 'f'.repeat(64), acceptanceRef: 'accept' };
  const command = 'exit 0';
  const identity = { version: 1 as const, scope: run.scope, graphRunId: run.graphRunId, generation: run.generation, effectKey, invocationId,
    candidateRevision: binding.candidateRevision, artifactDigest: binding.artifactDigest, command, image };
  const data = verificationCanonical(identity);
  const executorOptions = { ...host, journalRoot, imageId: image.imageId, workingDirectory: image.workingDirectory, command, bindingRef: sha(data), bindingData: data,
    authorize: (op: 'start' | 'stop' | 'read') => { if (op === 'stop') options.authorizeStop(); if (op === 'read') options.authorizeRead(); } };
  const executor = await createContainedCommandExecutor(executorOptions);
  const request = (): ReopenContainedTests => ({ fence: fence(), effectKey, binding, command, contentDigest: image.contentDigest });
  return { root, options, identity, calls, request, executor, invocationId, get db() { return db; }, fence,
    addOpaque: (held: boolean, settled: boolean) => {
      const a = new GraphActionStore(db); const reserved = a.reserve(fence(), { epoch: 0, nodeId: 'opaque', effectSlot: 'main', reservationTokens: 1,
        action: { kind: 'workspace_create', repositoryRef: 'repo', baseRevision: 'a'.repeat(40) } }); run = reserved.run;
      const key = reserved.action.effectKey;
      if (held) new GraphAdmissionStore(db).hold(key, Date.now());
      if (settled) { run = a.recordOutcome(fence(), key, { state: 'failed', evidenceRef: 'fixture-denied', actualTokens: 0, error: 'denied', retrySafe: false }).run;
        if (held) new GraphAdmissionStore(db).released(key, Date.now()); }
      return key;
    },
    addContained: async () => {
      const a = new GraphActionStore(db); const reserved = a.reserve(fence(), { epoch: 0, nodeId: 'tests-2', effectSlot: 'invoke', reservationTokens: 10, action: { kind: 'tests', candidateRevision: binding.candidateRevision, commandSpecRef: binding.acceptanceRef, workspaceLeaseRef: 'lease-2' } });
      run = reserved.run; const key = reserved.action.effectKey; const invocation = 'second-invocation'; new GraphAdmissionStore(db).hold(key, Date.now());
      run = a.markRunning(fence(), key, `graph-execution:${key}:${invocation}`).run;
      const second = { ...identity, effectKey: key, invocationId: invocation }; const data = verificationCanonical(second);
      const executor = await createContainedCommandExecutor({ ...executorOptions, bindingRef: sha(data), bindingData: data });
      return { request: () => ({ fence: fence(), effectKey: key, binding, command, contentDigest: image.contentDigest }),
        execute: () => executor.execute(invocation, new AbortController().signal) };
    },
    observeWorkerExit: async () => { const h = f.runtime.start({ ...f.start, run }); await h.result; await h.finalExit;
      run = new GraphRunStore(db).get(run.scope, run.graphRunId)!; },
    path: (name: string) => join(journalRoot, sha(invocationId), name),
    execute: () => executor.execute(invocationId, new AbortController().signal),
    reopen: (input = request()) => reopenGraphContainedTests(db, options, input),
    child: async (operation: 'stop' | 'confirmStopped' | 'captureQuiescence') => {
      const helper = process.env['G25_REOPEN_CHILD']; if (!helper) return;
      const inputPath = join(root, 'child-input.json'); writeFileSync(inputPath, JSON.stringify({ dbPath: join(root, 'state.db'), options, request: request(), operation }));
      const child = spawn(process.execPath, [helper, inputPath], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject(operation === 'captureQuiescence'
        ? { scope: 'contained-invocation', held: true, state: 'unknown', rechecked: true }
        : { stopped: true, held: true, state: 'unknown' });
    },
    restart: () => { db.close(); db = openDb({ path: join(root, 'state.db') }); },
    revokeRead: () => { canRead = false; }, stopGrant: (allowed: boolean) => { canStop = allowed; }, loseDelete: () => { lostDelete = true; }, keepRunning: () => { running = true; },
    release: () => new GraphAdmissionStore(db).released(effectKey, Date.now()),
    uncertain: () => { run = new GraphActionStore(db).markUncertain(fence(), effectKey, { state: 'unknown', evidenceRef: 'host-lost', observedTokens: 3 }).run; },
    action: () => new GraphActionStore(db).get(fence(), effectKey).action,
    held: () => (db.prepare('SELECT released_at FROM graph_action_admissions WHERE effect_key=?').get(effectKey) as { released_at: number | null }).released_at,
    changeRevision: () => { run = new GraphRunStore(db).renewLease({ ...fence(), leaseExpiresAt: Date.now() + 60000 }); },
  };
}
it('reopens held unknown action after DB restart and lease expiry without outcome inference or replay', async () => {
  const f = await fixture(); const actual = await f.execute(); f.uncertain(); f.restart();
  const input = f.request(); input.fence.now += 60000;
  const opened = await f.reopen(input);
  expect(opened.identity).toEqual(f.identity); expect(Object.keys(opened).sort()).toEqual(['captureQuiescence', 'confirmStopped', 'identity', 'stop']);
  await f.child('confirmStopped');
  expect(await opened.confirmStopped()).toEqual({ stopped: true, evidence: actual.evidence });
  expect(await opened.stop()).toEqual({ stopped: true, evidence: actual.evidence });
  expect(f.action()).toMatchObject({ state: 'unknown', outcome: null, observedTokens: 3 }); expect(f.held()).toBeNull();
  if (!process.env['G25_CONTAINED_CONFIG']) expect(f.calls.filter(c => c.includes('/create'))).toHaveLength(1);
});

describe('contained proof bridge', () => {
it('reopens distinct physical/isolation proofs after SQLite restart and rechecks without I/O in a transaction', async () => {
  const f = await fixture(); const result = await f.execute(); f.uncertain(); f.restart();
  const proof = await (await f.reopen()).captureQuiescence();
  expect(proof.executorEvidenceRef).toBe(result.evidence); expect(proof.isolationEvidenceRef).toMatch(/^docker-isolated:[a-f0-9]{64}$/);
  expect(proof.effectKey).toBe(f.request().effectKey); expect(Object.isFrozen(proof)).toBe(true);
  expect(proof.recheck).toThrow('TRANSACTION_REQUIRED'); const before = f.calls.length;
  expect(f.db.transaction(() => proof.recheck()).immediate()).toBeUndefined(); expect(f.calls).toHaveLength(before);
  await f.child('captureQuiescence'); expect(f.held()).toBeNull(); expect(f.action().state).toBe('unknown');
});
it.each(['isolation', 'stop', 'binding', 'grant', 'release', 'other-action'])('rejects %s drift at final transaction recheck', async mode => {
  const f = await fixture(); await f.execute(); const proof = await (await f.reopen()).captureQuiescence();
  if (mode === 'isolation') rmSync(f.path('isolated.json'));
  else if (mode === 'stop') rmSync(f.path('stopped.json'));
  else if (mode === 'binding') writeFileSync(f.path('binding.json'), '{}');
  else if (mode === 'grant') f.revokeRead();
  else if (mode === 'release') f.release();
  else f.addOpaque(true, true);
  const before = f.calls.length; expect(() => f.db.transaction(() => proof.recheck()).immediate()).toThrow(); expect(f.calls).toHaveLength(before);
});
it.each(['valid', 'revoked', 'isolation-lost', 'release-drift'])('uses the host closure inside actual G15 without inferring business outcome: %s', async mode => {
  const f = await fixture(); await f.execute(); f.uncertain(); await f.observeWorkerExit();
  const input = f.request(); const binding = { scope: input.fence.scope, graphRunId: input.fence.graphRunId, identity: input.fence.identity,
    generation: input.fence.expectedGeneration, owner: input.fence.expectedOwner! };
  const reconciler = new GraphReconciler(f.db); const connection = {};
  let captured: Awaited<ReturnType<Awaited<ReturnType<typeof f.reopen>>['captureQuiescence']>> | undefined;
  const verifyWorker = () => verifyJournaledGraphWorkerExit(f.db, binding);
  // This trusted fixture runs a fixed no-descendants program and exactly one
  // contained action. Production hosts must independently cover all other producers.
  reconciler.register(connection, { binding,
    authorize: () => { if (f.db.inTransaction) {
      if (mode === 'revoked') f.revokeRead(); else if (mode === 'isolation-lost') rmSync(f.path('isolated.json'), { force: true });
      else if (mode === 'release-drift') f.release();
    } },
    stopWorker: async () => undefined, verifyWorker: async () => verifyWorker(),
    verifyQuiescence: async () => { captured = await (await f.reopen(input)).captureQuiescence();
      return { executorEvidenceRef: captured.executorEvidenceRef, workspaceEvidenceRef: captured.isolationEvidenceRef }; },
    verifyOutcome: async () => ({ outcome: 'unknown', evidenceRef: 'fixture-missing-business-envelope', observedTokens: 3 }),
    recheck: (_snapshot, proof) => { expect(f.db.inTransaction).toBe(true); expect(verifyWorker()).toEqual(proof.worker); captured!.recheck(); },
    release: async () => { throw Error('unknown outcome cannot release'); },
  });
  try {
    const result = reconciler.reconcile(connection, { kind: 'effect', fence: input.fence, effectKey: input.effectKey, receiptId: 'contained-bridge' });
    if (mode === 'valid') { const done = await result; expect(done.exit).toBe('unknown');
      expect(done.result.record.proof.workspaceEvidenceRef).toBe(captured!.isolationEvidenceRef);
      expect(done.result.record.proof.workspaceEvidenceRef).not.toBe(done.result.record.proof.worker.evidenceRef);
      expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 1 }); }
    else { await expect(result).rejects.toThrow(); expect(f.db.prepare('SELECT count(*) n FROM graph_recovery_decisions').get()).toEqual({ n: 0 }); }
    expect(f.held()).toBeNull(); expect(f.db.prepare('SELECT state FROM graph_actions WHERE effect_key=?').get(input.effectKey)).toEqual({ state: 'unknown' });
  } finally { reconciler.unregister(connection); }
});
it('does not retrofit isolation onto a removed legacy invocation or create a new executor', async () => {
  const f = await fixture(); await f.execute(); rmSync(f.path('isolated.json')); const opened = await f.reopen();
  expect((await opened.confirmStopped()).stopped).toBe(true);
  const before = f.calls.length; await expect(opened.captureQuiescence()).rejects.toThrow(); expect(f.calls).toHaveLength(before); expect(f.held()).toBeNull();
});
});
it.each(['generation', 'invocationId', 'effectKey', 'candidateRevision', 'artifactDigest', 'daemon', 'base', 'image', 'command', 'scope'])('rejects substituted %s binding before any daemon operation', async field => {
  const f = await fixture(); await f.execute(); const data = structuredClone(f.identity);
  if (field === 'generation') data.generation++;
  else if (field === 'invocationId') data.invocationId = 'other';
  else if (field === 'effectKey') data.effectKey = '1'.repeat(64);
  else if (field === 'candidateRevision') data.candidateRevision = '1'.repeat(40);
  else if (field === 'artifactDigest') data.artifactDigest = '1'.repeat(64);
  else if (field === 'daemon') data.image.daemonId = 'other';
  else if (field === 'base') data.image.baseImageId = 'sha256:' + '1'.repeat(64);
  else if (field === 'image') data.image.imageId = 'sha256:' + '1'.repeat(64);
  else if (field === 'command') data.command = 'exit 1';
  else data.scope.tenantId = 'other';
  const canonical = verificationCanonical(data); writeFileSync(f.path('binding.json'), JSON.stringify({ version: 1, bindingRef: sha(canonical), data: canonical }));
  const before = f.calls.length;
  if (field === 'image') { const opened = await f.reopen(); expect(await opened.confirmStopped()).toEqual({ stopped: false }); await expect(opened.stop()).rejects.toThrow('BINDING'); }
  else await expect(f.reopen()).rejects.toThrow();
  expect(f.calls).toHaveLength(before); expect(f.held()).toBeNull();
});
it.each(['missing', 'digest', 'noncanonical', 'oversize', 'symlink'])('rejects %s binding journal without daemon calls', async mode => {
  const f = await fixture(); await f.execute(); const path = f.path('binding.json');
  if (mode === 'missing') rmSync(path);
  else if (mode === 'digest') writeFileSync(path, JSON.stringify({ version: 1, bindingRef: '0'.repeat(64), data: verificationCanonical(f.identity) }));
  else if (mode === 'noncanonical') { const data = JSON.stringify(f.identity, null, 2); writeFileSync(path, JSON.stringify({ version: 1, bindingRef: sha(data), data })); }
  else if (mode === 'oversize') writeFileSync(path, ' '.repeat(65537));
  else { const target = join(f.root, 'copy'); writeFileSync(target, readFileSync(path)); rmSync(path); symlinkSync(target, path); }
  const before = f.calls.length; await expect(f.reopen()).rejects.toThrow(); expect(f.calls).toHaveLength(before);
});
describe('bounded binding journal reads', () => {
  it.each(['reopen', 'transaction'])('rejects a real FIFO without waiting for a writer at %s', async stage => {
    const f = await fixture(); await f.execute(); f.uncertain();
    const proof = stage === 'transaction' ? await (await f.reopen()).captureQuiescence() : undefined;
    const path = f.path('binding.json'); rmSync(path); execFileSync('mkfifo', [path]);
    // The guard makes a regression fail rather than wedging the Vitest process.
    // With the flag present the real OS open/fstat still run against the FIFO.
    vi.mocked(openSync).mockImplementation((file, flags, mode) => {
      if (file === path && (typeof flags !== 'number' || !(flags & constants.O_NONBLOCK))) throw Error('TEST_BLOCKING_FIFO_OPEN');
      return actualFs.openSync(file, flags, mode);
    });
    const before = f.calls.length;
    if (proof) expect(() => f.db.transaction(() => proof.recheck()).immediate()).toThrow('CONTAINED_JOURNAL_INVALID');
    else await expect(f.reopen()).rejects.toThrow('CONTAINED_JOURNAL_INVALID');
    expect(f.calls).toHaveLength(before); expect(f.held()).toBeNull(); expect(f.action().state).toBe('unknown');
    expect(f.db.inTransaction).toBe(false);
  });
  it.each(['reopen', 'transaction'])('rejects growth beyond the limit after fstat at %s', async stage => {
    const f = await fixture(); await f.execute(); f.uncertain();
    const proof = stage === 'transaction' ? await (await f.reopen()).captureQuiescence() : undefined;
    const path = f.path('binding.json'); const original = readFileSync(path); let fd: number | undefined; let grew = false;
    vi.mocked(openSync).mockImplementation((file, flags, mode) => {
      const opened = actualFs.openSync(file, flags, mode); if (file === path) fd = opened; return opened;
    });
    vi.mocked(fstatSync).mockImplementation((file, options) => {
      const stat = actualFs.fstatSync(file, options);
      if (file === fd) {
        if (!grew) { grew = true; writeFileSync(path, Buffer.concat([original, Buffer.alloc(65537 - original.length, 32)])); }
        // Keep stat small on later rechecks too: only the actual read cap can
        // reject this valid JSON followed by whitespace, not a subsequent stat.
        stat.size = typeof stat.size === 'bigint' ? BigInt(original.length) : original.length;
      }
      return stat;
    });
    const before = f.calls.length;
    if (proof) expect(() => f.db.transaction(() => proof.recheck()).immediate()).toThrow('CONTAINED_JOURNAL_INVALID');
    else await expect(f.reopen()).rejects.toThrow('CONTAINED_JOURNAL_INVALID');
    expect(grew).toBe(true); expect(f.calls).toHaveLength(before); expect(f.held()).toBeNull(); expect(f.action().state).toBe('unknown');
    expect(() => actualFs.fstatSync(fd!)).toThrow(); expect(f.db.inTransaction).toBe(false);
  });
  it('accepts the exact byte limit even with short reads', async () => {
    const f = await fixture(); await f.execute(); const path = f.path('binding.json'); const bytes = readFileSync(path);
    writeFileSync(path, Buffer.concat([bytes, Buffer.alloc(65536 - bytes.length, 32)]));
    let fd: number | undefined; let reads = 0;
    vi.mocked(openSync).mockImplementation((file, flags, mode) => {
      const opened = actualFs.openSync(file, flags, mode); if (file === path) fd = opened; return opened;
    });
    vi.mocked(readSync).mockImplementation(((file: number, buffer: Buffer, offset: number, length: number, position: number) => {
      if (file === fd) { reads++; length = Math.min(length, 97); }
      return actualFs.readSync(file, buffer, offset, length, position);
    }) as typeof readSync);
    expect((await f.reopen()).identity).toEqual(f.identity); expect(reads).toBeGreaterThan(675);
    expect(() => actualFs.fstatSync(fd!)).toThrow(); expect(f.held()).toBeNull();
  });
  it('closes the binding descriptor when a read fails', async () => {
    const f = await fixture(); await f.execute(); const path = f.path('binding.json'); let fd: number | undefined;
    vi.mocked(openSync).mockImplementation((file, flags, mode) => {
      const opened = actualFs.openSync(file, flags, mode); if (file === path) fd = opened; return opened;
    });
    vi.mocked(readSync).mockImplementation(((file: number, buffer: Buffer, offset: number, length: number, position: number) => {
      if (file === fd) throw Error('TEST_READ_FAILURE'); return actualFs.readSync(file, buffer, offset, length, position);
    }) as typeof readSync);
    const before = f.calls.length; await expect(f.reopen()).rejects.toThrow('TEST_READ_FAILURE');
    expect(f.calls).toHaveLength(before); expect(() => actualFs.fstatSync(fd!)).toThrow(); expect(f.held()).toBeNull();
  });
});
it.each(['scope', 'epoch', 'revision', 'owner', 'program', 'command', 'content'])('rejects incorrect trusted request %s', async field => {
  const f = await fixture(); await f.execute(); const input = f.request();
  if (field === 'scope') input.fence.scope = { ...input.fence.scope, principalId: 'other' };
  else if (field === 'epoch') input.binding = { ...input.binding, epoch: 1 };
  else if (field === 'revision') input.fence.expectedRevision++;
  else if (field === 'owner') input.fence.expectedOwner = 'other';
  else if (field === 'program') input.fence.identity = { ...input.fence.identity, compiledProgramDigest: '1'.repeat(64) };
  else if (field === 'command') input.command = 'exit 1';
  else input.contentDigest = '0'.repeat(64);
  await expect(f.reopen(input)).rejects.toThrow();
});
it.each(['read', 'stop', 'released', 'revision', 'binding'])('rechecks %s after reopen before any later effects', async mode => {
  const f = await fixture(); await f.execute(); const opened = await f.reopen();
  if (mode === 'read') f.revokeRead(); else if (mode === 'stop') f.stopGrant(false); else if (mode === 'released') f.release();
  else if (mode === 'revision') f.changeRevision(); else writeFileSync(f.path('binding.json'), '{}');
  const before = f.calls.length; await expect(opened.stop()).rejects.toThrow(); expect(f.calls).toHaveLength(before);
});
it('snapshots caller options, request and returned identity and rejects async grants', async () => {
  const f = await fixture(); await f.execute(); const input = f.request(); const pending = f.reopen(input);
  input.command = 'forged'; f.options.authorizeRead = () => { throw Error('replacement'); };
  const opened = await pending; opened.identity.image.imageId = 'forged'; expect((await opened.confirmStopped()).stopped).toBe(true);
  f.options.authorizeRead = async () => {}; await expect(f.reopen()).rejects.toThrow('AUTHORITY_MUST_BE_SYNC');
});
it('missing stop receipt leaves physical and business outcome unknown after restart', async () => {
  const f = await fixture(); await f.execute(); rmSync(f.path('stopped.json')); f.uncertain(); f.restart(); const opened = await f.reopen();
  expect(await opened.confirmStopped()).toEqual({ stopped: false }); await expect(opened.stop()).rejects.toThrow('SCOPE_UNCONFIRMED');
  expect(f.action().state).toBe('unknown'); expect(f.held()).toBeNull();
});
it('fresh host stops an exactly journaled orphan after old stop permission failed', async () => {
  const f = await fixture(); f.stopGrant(false); await expect(f.execute()).rejects.toThrow('stop revoked');
  f.uncertain(); f.restart(); f.stopGrant(true); await f.child('stop'); const opened = await f.reopen();
  if (!process.env['G25_REOPEN_CHILD']) expect(await opened.confirmStopped()).toEqual({ stopped: false }); expect((await opened.stop()).stopped).toBe(true);
  expect((await opened.confirmStopped()).stopped).toBe(true); expect(f.action().state).toBe('unknown'); expect(f.held()).toBeNull();
  if (!process.env['G25_CONTAINED_CONFIG']) expect(f.calls.filter(c => c.startsWith('DELETE'))).toHaveLength(1);
});
it.runIf(!process.env['G25_CONTAINED_CONFIG'])('lost delete ACK remains unknown after reopening without repeated deletion', async () => {
  const f = await fixture(); f.loseDelete(); await expect(f.execute()).rejects.toThrow(); f.uncertain(); f.restart(); const opened = await f.reopen();
  const before = f.calls.filter(c => c.startsWith('DELETE')).length;
  expect(await opened.confirmStopped()).toEqual({ stopped: false }); await expect(opened.stop()).rejects.toThrow();
  expect(f.calls.filter(c => c.startsWith('DELETE'))).toHaveLength(before); expect(f.held()).toBeNull();
});

describe('graph quiescence sweep', () => {
it('sweeps actual worker and contained executor after reopening the ledger, without settling or releasing', async () => {
  const f = await fixture(); await f.execute(); f.uncertain(); await f.observeWorkerExit(); f.restart();
  const { fence, ...registration } = f.request();
  const options = { authorize: () => {}, contained: { options: f.options, registrations: [registration] } };
  const request = { fence, mode: 'inspect' as const };
  const report = await sweepGraphQuiescence(f.db, options, request);
  if (process.env['G25_SWEEP_CHILD']) {
    const path = join(f.root, 'sweep-child-input.json'); writeFileSync(path, JSON.stringify({ dbPath: f.db.name, options, request }));
    const child = spawn(process.execPath, [process.env['G25_SWEEP_CHILD'], path], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, signal: AbortSignal.timeout(10000) });
    let stdout = ''; let stderr = ''; child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; });
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    expect(code, stderr).toBe(0); expect(JSON.parse(stdout)).toEqual(report);
  }
  expect(report).toMatchObject({ allInventoriedExecutorsStopped: true, recoveryAuthorized: false, workspaceStatus: 'unproven', executors: [{ status: 'stopped' }] });
  expect(f.action().state).toBe('unknown'); expect(f.held()).toBeNull();
});

function sweepInput(f: Awaited<ReturnType<typeof fixture>>) {
  const { fence, ...registration } = f.request();
  return { options: { authorize: () => {}, contained: { options: f.options, registrations: [registration] } }, request: { fence, mode: 'inspect' as const } };
}
it('sweeps two distinct contained invocations without re-execution and binds each physical receipt', async () => {
  const f = await fixture(); const second = await f.addContained(); const firstResult = await f.execute(); const secondResult = await second.execute();
  await f.observeWorkerExit(); const input = sweepInput(f); const { fence: _fence, ...registration } = second.request(); input.options.contained.registrations.push(registration);
  const report = await sweepGraphQuiescence(f.db, input.options, input.request);
  expect(report.allInventoriedExecutorsStopped).toBe(true); expect(report.executors).toHaveLength(2);
  expect(report.executors.map(e => e.evidenceRef).sort()).toEqual([firstResult.evidence, secondResult.evidence].sort());
  expect(new Set(report.executors.map(e => e.evidenceRef)).size).toBe(2);
  if (!process.env['G25_CONTAINED_CONFIG']) expect(f.calls.filter(c => c.includes('/create'))).toHaveLength(2);
});
it.each([false, true])('does not omit released or missing-admission historical obligations (held=%s)', async held => {
  const f = await fixture(); const key = f.addOpaque(held, true); await f.execute(); await f.observeWorkerExit();
  const input = sweepInput(f); const report = await sweepGraphQuiescence(f.db, input.options, input.request);
  expect(report.allInventoriedExecutorsStopped).toBe(false); expect(report.executors).toHaveLength(2);
  expect(report.executors.find(e => e.effectKey === key)).toMatchObject({ status: 'unproven', reason: held ? 'EXECUTOR_VERIFIER_UNAVAILABLE' : 'ADMISSION_MISSING' });
});
it('can inspect a released contained action but cannot reacquire cleanup authority', async () => {
  const f = await fixture(); await f.execute(); f.release(); await f.observeWorkerExit();
  const input = sweepInput(f); expect((await sweepGraphQuiescence(f.db, input.options, { ...input.request, mode: 'stop_contained' })).allInventoriedExecutorsStopped).toBe(true);
  const opened = await reopenGraphContainedTests(f.db, f.options, f.request(), 'read_only'); const before = f.calls.length;
  await expect(opened.stop()).rejects.toThrow('INSPECTION_CANNOT_STOP'); expect(f.calls).toHaveLength(before);
  await expect(f.reopen()).rejects.toThrow('LEDGER_BINDING');
});
it.each(['inspect', 'stop_contained'] as const)('never substitutes container absence for a deleted receipt in %s mode', async mode => {
  const f = await fixture(); await f.execute(); rmSync(f.path('stopped.json')); f.release(); await f.observeWorkerExit();
  const input = sweepInput(f); const before = f.calls.filter(c => c.startsWith('DELETE')).length;
  const report = await sweepGraphQuiescence(f.db, input.options, { ...input.request, mode });
  expect(report.allInventoriedExecutorsStopped).toBe(false); expect(report.executors[0]!.status).toBe('unproven');
  expect(f.calls.filter(c => c.startsWith('DELETE'))).toHaveLength(before);
});
it('requires explicit stop mode and current stop grant for an orphan; never releases its ledger hold', async () => {
  const f = await fixture(); f.stopGrant(false); await expect(f.execute()).rejects.toThrow(); await f.observeWorkerExit();
  const input = sweepInput(f); expect((await sweepGraphQuiescence(f.db, input.options, input.request)).allInventoriedExecutorsStopped).toBe(false);
  expect((await sweepGraphQuiescence(f.db, input.options, { ...input.request, mode: 'stop_contained' })).allInventoriedExecutorsStopped).toBe(false);
  f.stopGrant(true); expect((await sweepGraphQuiescence(f.db, input.options, { ...input.request, mode: 'stop_contained' })).allInventoriedExecutorsStopped).toBe(true);
  expect(f.held()).toBeNull(); expect(f.action().state).toBe('running');
});
it('requires old and current generation exit evidence before any container read or stop', async () => {
  const f = await fixture(); await f.execute(); await f.observeWorkerExit();
  const r = f.request().fence; const now = Date.now();
  // Inject a concurrent replacement retaining an old action; both generations need proof.
  const old = verifyJournaledGraphWorkerExit(f.db, { scope: r.scope, graphRunId: r.graphRunId, identity: r.identity, generation: 1, owner: r.expectedOwner! });
  f.db.prepare('INSERT INTO graph_worker_leases(graph_run_id,generation,owner,acquired_at,expires_at,stopped_worker_json) VALUES(?,2,?,?,?,?)').run(r.graphRunId, 'new-owner', now, now + 60000, JSON.stringify(old));
  f.db.prepare("UPDATE graph_runs SET generation=2,lease_owner='new-owner',revision=revision+1 WHERE graph_run_id=?").run(r.graphRunId);
  const input = sweepInput(f); const current = new GraphRunStore(f.db).get(r.scope, r.graphRunId)!;
  input.request.fence = { ...r, expectedGeneration: 2, expectedOwner: 'new-owner', expectedRevision: current.revision, now: Date.now() };
  const before = f.calls.length; const report = await sweepGraphQuiescence(f.db, input.options, { ...input.request, mode: 'stop_contained' });
  expect(report.workers.map(w => [w.generation, w.status])).toEqual([[1, 'stopped'], [2, 'unproven']]);
  expect(report.allInventoriedExecutorsStopped).toBe(false); expect(f.calls).toHaveLength(before);
});
it.each([false, true])('includes an actionless intermediate generation (durable no-start=%s)', async noStart => {
  const f = await fixture(); await f.execute(); await f.observeWorkerExit();
  const r = f.request().fence; const now = Date.now(); const journal = new GraphProcessJournal(f.db);
  for (const generation of [2, 3]) {
    const owner = `owner-${generation}`;
    f.db.prepare('INSERT INTO graph_worker_leases VALUES(?,?,?,?,?,?)').run(r.graphRunId, generation, owner, now, now + 60000, '{}');
    const binding = { scope: r.scope, graphRunId: r.graphRunId, identity: r.identity, generation, owner };
    journal.consume(binding);
    if (generation === 3 || noStart) journal.observed(binding, { kind: 'spawn_failed', graphRunId: r.graphRunId, generation, owner,
      confirmedAt: Date.now(), evidenceRef: 'worker-not-started:00000000-0000-0000-0000-000000000000', phase: 'registration', error: 'failed' });
  }
  f.db.prepare("UPDATE graph_runs SET generation=3,lease_owner='owner-3',revision=revision+1 WHERE graph_run_id=?").run(r.graphRunId);
  const input = sweepInput(f); const current = new GraphRunStore(f.db).get(r.scope, r.graphRunId)!;
  input.request.fence = { ...r, expectedGeneration: 3, expectedOwner: 'owner-3', expectedRevision: current.revision, now: Date.now() };
  const before = f.calls.length; const report = await sweepGraphQuiescence(f.db, input.options, { ...input.request, mode: 'stop_contained' });
  expect(report.workers.map(w => [w.generation, w.status])).toEqual([[1, 'stopped'], [2, noStart ? 'not_started' : 'unproven'], [3, 'not_started']]);
  expect(report.allInventoriedExecutorsStopped).toBe(noStart);
  if (!noStart) expect(f.calls).toHaveLength(before);
  expect(report.recoveryAuthorized).toBe(false); expect(f.held()).toBeNull();
});
it.each(['release', 'revision', 'grant'])('rejects %s drift inside executor authorization before subsequent physical operations', async mode => {
  const f = await fixture(); await f.execute(); await f.observeWorkerExit(); const input = sweepInput(f); let allowed = true;
  input.options.authorize = () => { if (!allowed) throw Error('run grant revoked'); };
  let once = false; f.options.authorizeRead = () => { if (!once) { once = true; if (mode === 'release') f.release(); else if (mode === 'revision') f.changeRevision(); else allowed = false; } };
  const before = f.calls.length; await expect(sweepGraphQuiescence(f.db, input.options, { ...input.request, mode: 'stop_contained' })).rejects.toThrow();
  expect(f.calls).toHaveLength(before);
});
it.each(['duplicate', 'extra', 'async'])('rejects %s registration/authority before daemon access', async mode => {
  const f = await fixture(); await f.execute(); await f.observeWorkerExit(); const input = sweepInput(f);
  if (mode === 'duplicate') input.options.contained.registrations.push(input.options.contained.registrations[0]!);
  else if (mode === 'extra') input.options.contained.registrations.push({ ...input.options.contained.registrations[0]!, effectKey: '0'.repeat(64) });
  else input.options.authorize = async () => {};
  const before = f.calls.length; await expect(sweepGraphQuiescence(f.db, input.options, input.request)).rejects.toThrow(); expect(f.calls).toHaveLength(before);
});
it('captures trusted registrations and guards, and reports absent registries as unproven', async () => {
  const f = await fixture(); await f.execute(); await f.observeWorkerExit(); const input = sweepInput(f);
  const pending = sweepGraphQuiescence(f.db, input.options, input.request);
  input.options.contained.registrations[0]!.command = 'injected'; input.options.authorize = () => { throw Error('replacement'); };
  input.request.fence.expectedOwner = 'other';
  expect((await pending).allInventoriedExecutorsStopped).toBe(true);
  const report = await sweepGraphQuiescence(f.db, { authorize: () => {} }, { fence: f.fence(), mode: 'inspect' });
  expect(report.allInventoriedExecutorsStopped).toBe(false); expect(report.executors[0]!.reason).toBe('EXECUTOR_VERIFIER_UNAVAILABLE');
});

it.each(['release', 'worker-journal'])('rejects %s drift after daemon I/O before further cleanup', async mode => {
  const f = await fixture(); await f.execute(); await f.observeWorkerExit(); const input = sweepInput(f); let reads = 0;
  f.options.authorizeRead = () => { if (++reads === 3) {
    if (mode === 'release') f.release();
    else f.db.prepare('INSERT INTO graph_worker_process_events(graph_run_id,generation,kind,event_json,observed_at) VALUES(?,?,?,?,?)')
      .run(input.request.fence.graphRunId, 1, 'exit_unconfirmed', JSON.stringify({ kind: 'exit_unconfirmed', error: 'contradictory late event' }), Date.now());
  } };
  const before = f.calls.filter(c => c.startsWith('DELETE')).length;
  await expect(sweepGraphQuiescence(f.db, input.options, { ...input.request, mode: 'stop_contained' })).rejects.toThrow('QUIESCENCE_SWEEP_CHANGED');
  expect(reads).toBeGreaterThanOrEqual(3); expect(f.calls.filter(c => c.startsWith('DELETE'))).toHaveLength(before);
});
it('keeps a substituted trusted manifest unproven before Docker calls', async () => {
  const f = await fixture(); await f.execute(); await f.observeWorkerExit(); const input = sweepInput(f);
  input.options.contained.registrations[0]!.binding.candidateRevision = '0'.repeat(40);
  const before = f.calls.length; const report = await sweepGraphQuiescence(f.db, input.options, { ...input.request, mode: 'stop_contained' });
  expect(report.allInventoriedExecutorsStopped).toBe(false); expect(report.executors[0]!.reason).toContain('LEDGER_BINDING'); expect(f.calls).toHaveLength(before);
});
it('does not access Docker when the actual worker exit was never journaled', async () => {
  const f = await fixture(); f.stopGrant(false); await expect(f.execute()).rejects.toThrow(); f.stopGrant(true);
  const input = sweepInput(f); const before = f.calls.length;
  const report = await sweepGraphQuiescence(f.db, input.options, { ...input.request, mode: 'stop_contained' });
  expect(report.allInventoriedExecutorsStopped).toBe(false); expect(report.executors[0]!.reason).toBe('WORKER_EXIT_UNPROVEN'); expect(f.calls).toHaveLength(before);
  await f.executor.stop(f.invocationId);
});

});
