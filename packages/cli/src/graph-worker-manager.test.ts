import { createHash } from 'node:crypto';
import { ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { computeGraphInputDigest, workerCanonical, type StartGraphRequest, type GraphWorkerBinding } from '@osstack/protocol';
import { GraphWorkerManager, type GraphWorkerStart, type GraphWorkerHandle } from './graph-worker-manager.js';

const handles: GraphWorkerHandle[] = []; const dirs: string[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(h => h.stop())); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture(source = 'export async function run(ctx) { console.log("isolated output"); return {task:ctx.input.spec.input.taskRef}; }', options: ConstructorParameters<typeof GraphWorkerManager>[0] = { programs: [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'g14-')); dirs.push(dir);
  const modulePath = join(dir, 'program.mjs'); writeFileSync(modulePath, source);
  const digest = createHash('sha256').update(source).digest('hex');
  const input: StartGraphRequest = { schemaVersion: 1, kind: 'start', scope: { schemaVersion: 1, tenantId: 't', principalId: 'p', workspaceId: 'w' }, idempotencyKey: 'key', inputArtifactRef: 'input', source: { product: 'osstack', requestId: 'source' },
    spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only', input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: 'a'.repeat(40), acceptanceRef: 'accept' }, limits: { maxEpochs: 1, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 10, deadlineSeconds: 300, tokenReservationLimit: 100 } } };
  const binding: GraphWorkerBinding = { scope: input.scope, graphRunId: 'run', generation: 1, owner: 'owner', identity: { executionModel: 'langgraph-functional-v1', durability: 'sync', engineVersion: '1.4.15', checkpointVersion: '1.1.5', templateVersion: '1', registryVersion: '1', compilerVersion: '1', schemaVersion: '1', compiledProgramDigest: digest, inputDigest: computeGraphInputDigest(input), specHash: createHash('sha256').update(`osstack.graph.spec.v1\n${workerCanonical(input.spec)}`).digest('hex') } };
  const manager = new GraphWorkerManager({ heartbeatTimeoutMs: 1500, shutdownTimeoutMs: 100, terminationTimeoutMs: 200, ...options, programs: [{ id: 'test', modulePath, digest }] });
  const requests: unknown[] = [];
  const start: GraphWorkerStart = { binding, programId: 'test', input, authorize: () => ({ leaseExpiresAt: Date.now() + 5000 }), register: () => {}, action: async () => { throw new Error('no action'); }, checkpoint: async (_connection, request) => {
    requests.push(request);
    if (request.kind === 'get') return { kind: 'get', tuple: null };
    if (request.kind === 'put') return { kind: 'put', checkpointId: request.checkpointId };
    if (request.kind === 'writes') return { kind: 'writes' };
    return { kind: 'list', tuples: [] };
  } };
  const launch = (value = start) => { const h = manager.start(value); handles.push(h); return h; };
  return { dir, modulePath, manager, binding, input, start, launch, requests };
}
it('handshakes asynchronously, executes Functional+remote sync checkpoints and isolates bounded logs', async () => {
  const f = fixture(); let registered = false;
  const h = f.launch({ ...f.start, register: connection => { registered = true; expect(connection).toBeDefined(); } });
  expect(registered).toBe(true); let ready = false; void h.ready.then(() => { ready = true; }); expect(ready).toBe(false);
  await h.ready; expect(await h.result).toEqual({ task: 'task' });
  const exit = await h.exit; expect(exit.kind).toBe('exited'); expect(h.logs().stdout).toContain('isolated output');
  expect(f.requests.some(r => (r as {kind:string}).kind === 'put')).toBe(true);
});
it('reserves each run synchronously and requires verified exit before replacement', async () => {
  const f = fixture('export async function run() { await new Promise(()=>{}); }'); const h = f.launch();
  expect(() => f.launch()).toThrow('WORKER_ALREADY_ACTIVE');
  expect(() => f.launch({ ...f.start, binding: { ...f.binding, generation: 2 } })).toThrow('WORKER_ALREADY_ACTIVE');
  await h.ready; expect((await h.stop()).kind).toBe('exited');
  expect(() => f.launch()).toThrow('STALE_GENERATION');
  const next = f.launch({ ...f.start, binding: { ...f.binding, generation: 2 } }); await next.ready;
});
it.each(['async', 'exit'])('rejects %s durability before spawning', durability => {
  const f = fixture(); expect(() => f.launch({ ...f.start, binding: { ...f.binding, identity: { ...f.binding.identity, durability } } as GraphWorkerBinding })).toThrow();
});
it('rejects immutable input and program identity mismatch before child launch', () => {
  const f = fixture(); expect(() => f.launch({ ...f.start, input: { ...f.input, inputArtifactRef: 'changed' } })).toThrow('INPUT_IDENTITY');
  expect(() => f.launch({ ...f.start, binding: { ...f.binding, identity: { ...f.binding.identity, compiledProgramDigest: '0'.repeat(64) } } })).toThrow('PROGRAM_IDENTITY');
});
it('executes snapshotted bytes even when the original trusted module is changed', async () => {
  const f = fixture(); writeFileSync(f.modulePath, 'throw new Error("changed")');
  const h = f.launch(); expect(await h.result).toEqual({ task: 'task' });
});
it('settles spawn failures and early exits without unhandled rejections', async () => {
  const f = fixture(undefined, { programs: [], executable: '/does-not-exist-g14' }); const h = f.launch();
  await expect(h.ready).rejects.toThrow(); await expect(h.result).rejects.toThrow(); expect(await h.exit).toMatchObject({ kind: 'spawn_failed', graphRunId: f.binding.graphRunId, generation: 1, owner: 'owner', confirmedAt: expect.any(Number), evidenceRef: expect.stringMatching(/^worker-not-started:/) });
  const early = fixture('process.exit(9); export async function run() {}').launch();
  await expect(early.ready).rejects.toThrow(); await expect(early.result).rejects.toThrow(); expect((await early.exit).kind).toBe('exited');
});
it('revocation aborts the injected broker and rejects later checkpoints without releasing its resources', async () => {
  const f = fixture('export async function run(ctx) { return ctx.action({schemaVersion:1,kind:"worker_action",requestId:"action",scope:ctx.input.scope,graphRunId:"run",specHash:ctx.binding.identity.specHash,generation:ctx.binding.generation,epoch:0,nodeId:"implement",effectSlot:"invocation",action:{kind:"implement",inputArtifactRef:"input",workspaceLeaseRef:"workspace"}}); }');
  let signal: AbortSignal | undefined; let resolveAction!: () => void; let release = false;
  const started = new Promise<void>(r => { resolveAction = r; });
  const h = f.launch({ ...f.start, action: async (_c, _r, options) => { signal = options.signal; resolveAction(); await new Promise(()=>{}); release = true; throw new Error('unreachable'); } });
  await started; h.cancel('host cancellation'); expect(signal?.aborted).toBe(true); expect((await h.exit).kind).toBe('exited'); expect(release).toBe(false);
});
it('expires leases and terminates an unresponsive child with actual exit evidence', async () => {
  const f = fixture('export async function run() { process.on("SIGTERM",()=>{}); while(true) {} }');
  const h = f.launch(); await h.ready; const exit = await h.exit;
  expect(exit.kind).toBe('exited'); if (exit.kind === 'exited') expect(exit.signal).toBe('SIGKILL');
  await expect(h.result).rejects.toThrow('HEARTBEAT');
});
it('rejects expired authority before any worker is started', () => {
  const f = fixture(); expect(() => f.launch({ ...f.start, authorize: () => ({ leaseExpiresAt: Date.now() - 1 }) })).toThrow('LEASE_EXPIRED');
});
it('does not equate invoke rejection to worker exit or await inherited log pipes', async () => {
  const f = fixture('export async function run(){ const {spawn}=await import("node:child_process"); spawn(process.execPath,["-e","setTimeout(()=>{},1500)"],{stdio:["ignore",1,2]}); throw new Error("invoke failed"); }');
  const h = f.launch(); await h.ready; await expect(h.result).rejects.toThrow('invoke failed');
  const at = Date.now(); expect((await h.exit).kind).toBe('exited'); expect(Date.now() - at).toBeLessThan(1000);
});

function rawWorker(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'g14-wire-')); dirs.push(dir);
  const path = join(dir, 'worker.mjs');
  writeFileSync(path, `import {Socket} from 'node:net';
    const socket=new Socket({fd:3,readable:true,writable:true}); let bytes=Buffer.alloc(0); let init;
    const send=m=>{const b=Buffer.from(JSON.stringify(m));const h=Buffer.alloc(4);h.writeUInt32BE(b.length);socket.write(Buffer.concat([h,b]));};
    const request=id=>({kind:'request',binding:init.binding,id:String(id),method:'checkpoint',payload:{kind:'get',threadId:init.binding.graphRunId,namespace:''}});
    socket.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);while(bytes.length>=4&&bytes.length>=4+bytes.readUInt32BE()){const n=bytes.readUInt32BE();const m=JSON.parse(bytes.subarray(4,4+n));bytes=bytes.subarray(4+n);if(m.kind==='init'){init=m;${body}}}});
    socket.on('error',()=>{});`);
  return path;
}
it.each(['graphRunId','generation','owner','scope','identity'])('rejects real child handshake with wrong %s', async key => {
  const change = key === 'generation' ? '2' : key === 'scope' ? '{...init.binding.scope,tenantId:"other"}' : key === 'identity' ? '{...init.binding.identity,compilerVersion:"2"}' : '"other"';
  const f = fixture(undefined, { programs: [], workerEntry: rawWorker(`send({kind:'ready',binding:{...init.binding,${key}:${change}}});`) });
  const h = f.launch(); await expect(h.ready).rejects.toThrow('WORKER_IDENTITY'); expect((await h.exit).kind).toBe('exited'); expect(f.requests).toHaveLength(0);
});
it('rejects a real oversize IPC header without dispatching any request', async () => {
  const f = fixture(undefined, { programs: [], workerEntry: rawWorker('const h=Buffer.alloc(4);h.writeUInt32BE(0xffffffff);socket.write(h);') });
  const h = f.launch(); await expect(h.ready).rejects.toThrow('WORKER_FRAME_LIMIT'); expect((await h.exit).kind).toBe('exited'); expect(f.requests).toHaveLength(0);
});
it('bounds host outstanding callbacks even when a child ignores client backpressure', async () => {
  const f = fixture(undefined, { programs: [], maxInFlight: 2, workerEntry: rawWorker("send({kind:'ready',binding:init.binding});send(request(1));send(request(2));send(request(3));") });
  let calls = 0;
  const h = f.launch({ ...f.start, checkpoint: async () => { calls++; return new Promise(()=>{}); } });
  await h.ready; await expect(h.result).rejects.toThrow('WORKER_BACKPRESSURE'); await h.exit; expect(calls).toBe(2);
});
it('done leaves exit pending until the OS observes termination', async () => {
  const f = fixture(undefined, { programs: [], workerEntry: rawWorker("process.on('SIGTERM',()=>{});send({kind:'ready',binding:init.binding});send({kind:'done',binding:init.binding,ok:true,value:42});") });
  const h = f.launch(); expect(await h.result).toBe(42);
  let exited = false; void h.exit.then(() => { exited = true; });
  await new Promise(r => setTimeout(r, 25)); expect(exited).toBe(false);
  const evidence = await h.exit; expect(evidence.kind).toBe('exited'); if (evidence.kind === 'exited') expect(evidence.signal).toBe('SIGKILL');
});
it('revokes a running lease and old callbacks cannot respond through a replacement connection', async () => {
  const f = fixture(undefined, { programs: [], workerEntry: rawWorker("send({kind:'ready',binding:init.binding});send(request(1));setInterval(()=>{try{send(request(2));}catch{}},60);") });
  let expiry = Date.now() + 5000; let finishOld!: (value: {kind:'get';tuple:null}) => void; let oldCalls = 0;
  let began!: () => void; const started = new Promise<void>(r => { began = r; });
  const old = f.launch({ ...f.start, authorize: () => ({ leaseExpiresAt: expiry }), checkpoint: async () => { oldCalls++; began(); return new Promise(resolve => { finishOld = resolve; }); } });
  await started; expiry = Date.now() - 1;
  await expect(old.result).rejects.toThrow(/LEASE_EXPIRED/); await old.exit; expect(oldCalls).toBe(1);
  let nextCalls = 0; const next = f.launch({ ...f.start, binding: { ...f.binding, generation: 2 }, checkpoint: async () => { nextCalls++; return { kind: 'get', tuple: null }; } });
  await next.ready; finishOld({ kind: 'get', tuple: null });
  await new Promise(r => setTimeout(r, 20)); expect(nextCalls).toBe(1); expect(oldCalls).toBe(1);
});
it('caps each log stream independently and does not pass a DB home or node injection environment', async () => {
  const f = fixture('export async function run(){console.log("x".repeat(100000));console.error("y".repeat(100000));return {home:process.env.OSSTACK_HOME??null,nodeOptions:process.env.NODE_OPTIONS??null};}', { programs: [], maxLogBytes: 128 });
  const h = f.launch(); expect(await h.result).toEqual({ home: null, nodeOptions: null }); await h.exit;
  expect(Buffer.byteLength(h.logs().stdout)).toBeLessThanOrEqual(128); expect(Buffer.byteLength(h.logs().stderr)).toBeLessThanOrEqual(128);
  expect(h.logs().stdout).toContain('xxxx'); expect(h.logs().stderr).toContain('yyyy');
});
it('rejects async authority and asynchronous registration without unhandled rejection', async () => {
  const f = fixture();
  expect(() => f.launch({ ...f.start, authorize: (async () => { throw new Error('bad authority'); }) as unknown as GraphWorkerStart['authorize'] })).toThrow('WORKER_AUTHORITY_MUST_BE_SYNC');
  const h = f.launch({ ...f.start, register: async () => { throw new Error('bad registration'); } });
  await expect(h.ready).rejects.toThrow('WORKER_REGISTER_MUST_BE_SYNC'); expect((await h.exit).kind).toBe('spawn_failed');
});
it('waits for the remote final checkpoint acknowledgement before resolving the program', async () => {
  const f = fixture(); let puts = 0; let acknowledge!: () => void; let blocked!: () => void;
  const waiting = new Promise<void>(r => { blocked = r; });
  const h = f.launch({ ...f.start, checkpoint: async (connection, request) => {
    if (request.kind === 'put' && ++puts === 2) { blocked(); await new Promise<void>(r => { acknowledge = r; }); }
    return f.start.checkpoint(connection, request);
  } });
  let resolved = false; void h.result.then(() => { resolved = true; });
  await waiting; expect(resolved).toBe(false); acknowledge(); expect(await h.result).toEqual({ task: 'task' });
});
it('bounds the handshake even if a child emits heartbeats without becoming ready', async () => {
  const f = fixture(undefined, { programs: [], startupTimeoutMs: 80,
    workerEntry: rawWorker("setInterval(()=>send({kind:'heartbeat',binding:init.binding}),10);") });
  const h = f.launch(); await expect(h.ready).rejects.toThrow('WORKER_STARTUP_TIMEOUT'); expect((await h.exit).kind).toBe('exited');
});
it('allows startup grace before requiring heartbeats', async () => {
  const f = fixture(undefined, { programs: [], heartbeatTimeoutMs: 50, startupTimeoutMs: 2000,
    workerEntry: rawWorker("setTimeout(()=>{send({kind:'ready',binding:init.binding});setInterval(()=>send({kind:'heartbeat',binding:init.binding}),10);},200);") });
  const h = f.launch(); await expect(h.ready).resolves.toBeUndefined();
});
it('does not apply a checkpoint RPC timeout to a healthy long-running governed action', async () => {
  const f = fixture('export async function run(ctx) { return ctx.action({schemaVersion:1,kind:"worker_action",requestId:"action",scope:ctx.input.scope,graphRunId:"run",specHash:ctx.binding.identity.specHash,generation:ctx.binding.generation,epoch:0,nodeId:"implement",effectSlot:"invocation",action:{kind:"implement",inputArtifactRef:"input",workspaceLeaseRef:"workspace"}}); }', { programs: [], requestTimeoutMs: 50 });
  const h = f.launch({ ...f.start, action: async (_connection, request, { signal }) => {
    await new Promise(done => setTimeout(done, 300)); expect(signal.aborted).toBe(false);
    return { schemaVersion: 1, kind: 'worker_action_response', requestId: request.requestId, generation: request.generation,
      effect: { schemaVersion: 1, scope: request.scope, graphRunId: request.graphRunId, specHash: request.specHash, epoch: request.epoch, nodeId: request.nodeId, effectSlot: request.effectSlot, logicalAttempt: 1 },
      outcome: { state: 'confirmed', result: { schemaVersion: 1, kind: 'implementation_complete', workspaceLeaseRef: 'workspace', receiptRef: 'receipt' } } };
  } });
  expect(await h.result).toMatchObject({ outcome: { state: 'confirmed' } });
});
it('preserves actual late OS exit evidence after the bounded stop result was unconfirmed', async () => {
  const f = fixture(undefined, { programs: [], shutdownTimeoutMs: 10, terminationTimeoutMs: 10,
    workerEntry: rawWorker("process.on('SIGTERM',()=>{});setInterval(()=>{},1000);send({kind:'ready',binding:init.binding});") });
  const h = f.launch(); await h.ready;
  const ignoredKill = vi.spyOn(ChildProcess.prototype, 'kill').mockReturnValue(true);
  let pid: number | undefined;
  try {
    const bounded = await h.stop(); expect(bounded.kind).toBe('exit_unconfirmed');
    if (bounded.kind !== 'exit_unconfirmed') throw new Error('expected bounded failure');
    pid = bounded.pid;
    let final = false; void h.finalExit.then(() => { final = true; });
    await new Promise(done => setTimeout(done, 20)); expect(final).toBe(false);
    process.kill(pid!, 'SIGKILL');
    expect(await h.finalExit).toMatchObject({ kind: 'exited', pid, signal: 'SIGKILL' });
    expect(await h.exit).toEqual(bounded);
  } finally { ignoredKill.mockRestore(); if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
});
it('records the authenticated child identity before its program receives init', async () => {
  const f = fixture(); let launch: unknown;
  const h = f.launch({ ...f.start, lifecycle: {
    launched: identity => { launch = identity; expect(f.requests).toHaveLength(0); },
    observed: () => {},
  }, checkpoint: async (connection, request) => { expect(launch).toBeDefined(); return f.start.checkpoint(connection, request); } });
  expect(await h.result).toEqual({ task: 'task' }); await h.finalExit;
  expect(launch).toMatchObject({ pid: expect.any(Number), processIdentity: { pid: expect.any(Number) } });
  const pgid = (launch as { pgid: number | null }).pgid;
  expect(pgid === null || (Number.isSafeInteger(pgid) && pgid > 0)).toBe(true);
});
it('never sends init if durable launch recording fails', async () => {
  const f = fixture(); const observations: unknown[] = [];
  const h = f.launch({ ...f.start, lifecycle: { launched: () => { throw new Error('disk failure'); }, observed: event => { observations.push(event); } } });
  await expect(h.ready).rejects.toThrow('disk failure'); await h.finalExit;
  expect(f.requests).toHaveLength(0); expect(observations).toEqual([expect.objectContaining({ kind: 'exited' })]);
});
it('records consumed registration failure synchronously without pretending a child was launched', async () => {
  const f = fixture(); const observations: unknown[] = [];
  const h = f.launch({ ...f.start, register: () => { throw new Error('registration failed'); }, lifecycle: {
    launched: () => { throw new Error('unexpected child'); }, observed: event => { observations.push(event); },
  } });
  expect(observations).toEqual([expect.objectContaining({ kind: 'spawn_failed', phase: 'registration' })]);
  expect(await h.finalExit).toEqual(observations[0]);
});
it('never classifies a post-spawn kill error as no-child even before durable launch recording', async () => {
  const f = fixture(); const observations: unknown[] = [];
  const original = ChildProcess.prototype.kill;
  const kill = vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(function (this: ChildProcess, signal) {
    this.emit('error', new Error('post-spawn kill error')); return original.call(this, signal);
  });
  try {
    const h = f.launch({ ...f.start, lifecycle: {
      launched: () => { throw Error('launch record unavailable'); }, observed: event => { observations.push(event); },
    } });
    await expect(h.ready).rejects.toThrow('launch record unavailable');
    expect(await h.finalExit).toMatchObject({ kind: 'exited' });
    expect(observations).toEqual([expect.objectContaining({ kind: 'exited' })]);
  } finally { kill.mockRestore(); }
});
it('surfaces failed exit journaling even after the successful program result has settled', async () => {
  const f = fixture();
  const h = f.launch({ ...f.start, lifecycle: { launched: () => {}, observed: () => { throw Error('disk write failed'); } } });
  expect(await h.result).toEqual({ task: 'task' });
  expect(await h.finalExit).toMatchObject({ kind: 'exited', journalError: expect.stringContaining('disk write failed') });
});
