You are the independent Claude Opus 5 reviewer of the bounded G25 diagnostic foundation. Source-only read-only review. Do not run tools or edit. Your previous source review returned PASS, limited to this diagnostic slice, with N1 undefined PID JSON risk, N2 nullable PGID test assumption, N3 stale dist informational. Review only these final changes plus the cancellation test contract update. Return PASS or REQUEST_CHANGES with concrete source-backed findings. Do not assert you ran tests. No full G25/recovery/production admission.
The existing spawnFailed child.pid guard predated this work; do not credit us with adding it.
N1 confirmed workerCanonical interpolates undefined, new regression failed at JSON.parse before normalization and now passes. N2 tests accept null or positive safe integer.
Full suite before these changes had 3265 pass/2 fail; the two failures were old chain tests requiring immediate actionsSettled true and unknown after stubborn command cancellation. Actual retained DB/receipts show commands stopped after 1s KILL and ledger safely failed retrySafe:false. Broker command grace is now 2500ms so old guaranteed-unknown assumption is invalid. Updated tests wait bounded actual drainage, assert actual process-group stop receipt, matching PGID and PID disappearance, failed nonretryable and released lock. Fixture execs node (avoids intermediate shell) and installs SIGTERM handler and PID file BEFORE started marker. Opaque adapter unknown/held regression remains unchanged in review-findings.test. Targeted 5 tests passed; 66 unselected tests are not counted as acceptance. Full suite rerun pending.


FILE packages/cli/src/graph-process-journal.ts
import type Database from 'better-sqlite3';
import { GraphRunStore } from '@osstack/core';
import { GraphWorkerBinding, workerCanonical } from '@osstack/protocol';
import { observeGraphProcessIdentity, type GraphProcessObservation } from './graph-process-identity.js';
import type { GraphWorkerLaunch, GraphWorkerExitEvidence } from './graph-worker-manager.js';

type ProcessEvent = { kind: 'launched'; launch: GraphWorkerLaunch } | GraphWorkerExitEvidence;
export interface GraphWorkerProcessReport {
  binding: GraphWorkerBinding;
  intentRecorded: boolean;
  launch: GraphWorkerLaunch | null;
  observations: GraphWorkerExitEvidence[];
  leader: GraphProcessObservation;
  executors: { state: 'unknown'; reason: 'opaque_adapters_and_descendants_unproven' };
  recovery: 'held';
}
/** Append-only host observations, not recovery attestations. */
export class GraphProcessJournal {
  constructor(private readonly db: Database.Database) {}
  private binding(value: GraphWorkerBinding): GraphWorkerBinding {
    const binding = GraphWorkerBinding.parse(value);
    const run = new GraphRunStore(this.db).get(binding.scope, binding.graphRunId);
    if (!run || workerCanonical(run.identity) !== workerCanonical(binding.identity)) throw new Error('GRAPH_PROCESS_BINDING');
    return binding;
  }
  private intent(binding: GraphWorkerBinding): boolean {
    const row = this.db.prepare('SELECT owner, identity_json FROM graph_worker_launches WHERE graph_run_id = ? AND generation = ?')
      .get(binding.graphRunId, binding.generation) as { owner: string; identity_json: string } | undefined;
    if (!row) return false;
    if (row.owner !== binding.owner || row.identity_json !== workerCanonical(binding.identity)) throw new Error('GRAPH_PROCESS_BINDING');
    return true;
  }
  consume(value: GraphWorkerBinding): void {
    const binding = this.binding(value);
    if (this.intent(binding)) throw new Error('GRAPH_GENERATION_ALREADY_LAUNCHED');
    this.db.prepare('INSERT INTO graph_worker_launches(graph_run_id,generation,owner,identity_json,launched_at) VALUES (?,?,?,?,?)')
      .run(binding.graphRunId, binding.generation, binding.owner, workerCanonical(binding.identity), Date.now());
  }
  private append(value: GraphWorkerBinding, event: ProcessEvent): void {
    const binding = this.binding(value);
    if (!this.intent(binding)) throw new Error('GRAPH_PROCESS_INTENT_REQUIRED');
    // Optional host fields may be undefined; canonicalize their JSON representation.
    const eventJson = workerCanonical(JSON.parse(JSON.stringify(event)));
    this.db.prepare('INSERT INTO graph_worker_process_events(graph_run_id,generation,kind,event_json,observed_at) VALUES (?,?,?,?,?)')
      .run(binding.graphRunId, binding.generation, event.kind, eventJson, Date.now());
  }
  launched(binding: GraphWorkerBinding, launch: GraphWorkerLaunch): void {
    if (!Number.isSafeInteger(launch.pid) || launch.pid < 1 || launch.processIdentity.pid !== launch.pid
      || (launch.pgid !== null && (!Number.isSafeInteger(launch.pgid) || launch.pgid < 1))
      || (launch.processIdentity.pgid !== null && launch.processIdentity.pgid !== launch.pgid)) throw new Error('GRAPH_PROCESS_LAUNCH_IDENTITY');
    this.append(binding, { kind: 'launched', launch });
  }
  observed(binding: GraphWorkerBinding, evidence: GraphWorkerExitEvidence): void {
    if (evidence.kind !== 'exit_unconfirmed' && (evidence.graphRunId !== binding.graphRunId
      || evidence.generation !== binding.generation || evidence.owner !== binding.owner)) throw new Error('GRAPH_PROCESS_BINDING');
    this.append(binding, evidence);
  }
  observe(value: GraphWorkerBinding): GraphWorkerProcessReport {
    const binding = this.binding(value); const intentRecorded = this.intent(binding);
    const rows = this.db.prepare('SELECT event_json FROM graph_worker_process_events WHERE graph_run_id = ? AND generation = ? ORDER BY sequence')
      .all(binding.graphRunId, binding.generation) as { event_json: string }[];
    const events = rows.map(row => JSON.parse(row.event_json) as ProcessEvent);
    const launch = events.find((event): event is Extract<ProcessEvent, { kind: 'launched' }> => event.kind === 'launched')?.launch ?? null;
    const observations = events.filter((event): event is GraphWorkerExitEvidence => event.kind !== 'launched');
    const leader: GraphProcessObservation = launch ? observeGraphProcessIdentity(launch.processIdentity)
      : observations.some(event => event.kind === 'spawn_failed') ? { state: 'absent', reason: 'authenticated_no_child' }
      : { state: 'unknown', reason: intentRecorded ? 'launch_window_unobserved' : 'no_launch_intent' };
    return { binding, intentRecorded, launch, observations, leader,
      executors: { state: 'unknown', reason: 'opaque_adapters_and_descendants_unproven' }, recovery: 'held' };
  }
}


FILE packages/cli/src/graph-process-journal.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChildProcess } from 'node:child_process';
import { openDb } from '@osstack/core';
import { afterEach, expect, it, vi } from 'vitest';
import { processFixture } from './graph-process-fixture.js';
import { GraphRuntime } from './graph-runtime.js';
import { GraphProcessJournal } from './graph-process-journal.js';
import { GraphRecoveryStore } from '@osstack/core/graph-recovery';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(source?: string) {
  const root = mkdtempSync(join(tmpdir(), 'g25-journal-')); const f = processFixture(root, source);
  cleanup.push(async () => { await f.runtime.close(); await f.runtime.drainDatabaseUsers(); if (f.db.open) f.db.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}
it('passes an actual runtime no-child journal through the G15 canonical identity gate', async () => {
  const f = fixture();
  vi.spyOn(f.broker, 'register').mockImplementation(() => { throw Error('registration unavailable'); });
  const evidence = await f.runtime.start(f.start).finalExit;
  if (evidence.kind !== 'spawn_failed') throw Error('expected authenticated no-child');
  const store = new GraphRecoveryStore(f.db, () => {}); const now = Date.now(); const r = f.run;
  const snapshot = store.snapshot({ scope: r.scope, graphRunId: r.graphRunId, identity: r.identity,
    expectedGeneration: r.generation, expectedRevision: r.revision, expectedOwner: r.leaseOwner, now });
  const proof = { snapshotDigest: snapshot.digest, verifiedAt: now,
    worker: { kind: 'not_started' as const, graphRunId: evidence.graphRunId, generation: evidence.generation,
      owner: evidence.owner, confirmedAt: evidence.confirmedAt, evidenceRef: evidence.evidenceRef },
    executorEvidenceRef: 'registration-failed-before-executors', workspaceEvidenceRef: 'no-actions-admitted' };
  expect(store.commit(snapshot, { kind: 'takeover', receiptId: 'actual-no-child', owner: 'replacement', leaseExpiresAt: now + 30000 }, proof, now).run.generation).toBe(2);
});
it('persists intent before registration and no-child registration failure after consuming generation', async () => {
  const f = fixture();
  const register = vi.spyOn(f.broker, 'register').mockImplementation(() => {
    expect(f.runtime.observeWorkerProcess(f.binding)).toMatchObject({ intentRecorded: true, launch: null, leader: { state: 'unknown' } });
    throw new Error('consumed registration failure');
  });
  const handle = f.runtime.start(f.start);
  expect(f.runtime.observeWorkerProcess(f.binding).observations).toEqual([expect.objectContaining({ kind: 'spawn_failed', phase: 'registration' })]);
  expect(await handle.finalExit).toMatchObject({ kind: 'spawn_failed' }); register.mockRestore();
  const fresh = new GraphRuntime(f.options);
  try {
    const retry = fresh.start(f.start); expect(await retry.finalExit).toMatchObject({ kind: 'spawn_failed', error: expect.stringContaining('ALREADY_LAUNCHED') });
    expect(fresh.observeWorkerProcess(f.binding).observations).toHaveLength(1);
  } finally { await fresh.close(); await fresh.drainDatabaseUsers(); }
});
it('journals an actual failed OS spawn and never launches an already consumed generation', async () => {
  const f = fixture(); const runtime = new GraphRuntime({ ...f.options, workerOptions: { executable: '/g25-missing-executable' } });
  try {
    expect(await runtime.start(f.start).finalExit).toMatchObject({ kind: 'spawn_failed', phase: 'spawn' });
    expect(runtime.observeWorkerProcess(f.binding)).toMatchObject({ launch: null, leader: { state: 'absent', reason: 'authenticated_no_child' }, recovery: 'held' });
  } finally { await runtime.close(); await runtime.drainDatabaseUsers(); }
});
it('retains launch and true exit, rejects changed identity and protects immutable observations', async () => {
  const f = fixture(); const h = f.runtime.start(f.start); expect(await h.result).toBe(42); await h.finalExit;
  const report = new GraphRuntime(f.options).observeWorkerProcess(f.binding);
  expect(report.launch).toMatchObject({ pid: expect.any(Number) });
  const pgid = report.launch!.pgid;
  expect(pgid === null || (Number.isSafeInteger(pgid) && pgid > 0)).toBe(true);
  expect(report.observations).toEqual([expect.objectContaining({ kind: 'exited' })]);
  expect(report).toMatchObject({ executors: { state: 'unknown' }, recovery: 'held' });
  expect(() => f.runtime.observeWorkerProcess({ ...f.binding, identity: { ...f.binding.identity, compiledProgramDigest: 'f'.repeat(64) } })).toThrow('GRAPH_PROCESS_BINDING');
  expect(() => f.runtime.observeWorkerProcess({ ...f.binding, owner: 'impostor' })).toThrow('GRAPH_PROCESS_BINDING');
  expect(() => f.db.prepare('UPDATE graph_worker_process_events SET event_json = ?').run('{}')).toThrow('immutable');
  expect(() => f.db.prepare('DELETE FROM graph_worker_process_events').run()).toThrow('immutable');
});
it('keeps the pre-spawn crash window unknown and does not derive stop from lease expiry', () => {
  const f = fixture(); const journal = new GraphProcessJournal(f.db); journal.consume(f.binding);
  const now = vi.spyOn(Date, 'now').mockReturnValue(f.run.leaseExpiresAt! + 1);
  try {
  expect(f.runtime.observeWorkerProcess(f.binding)).toMatchObject({ intentRecorded: true, launch: null, leader: { state: 'unknown', reason: 'launch_window_unobserved' }, recovery: 'held' });
  } finally { now.mockRestore(); }
});
it('round-trips an unconfirmed observation without an assigned PID as valid JSON', () => {
  const f = fixture(); const journal = new GraphProcessJournal(f.db); journal.consume(f.binding);
  journal.observed(f.binding, { kind: 'exit_unconfirmed', pid: undefined, error: 'spawn observation unavailable' });
  const report = new GraphProcessJournal(f.db).observe(f.binding);
  expect(report.observations).toEqual([{ kind: 'exit_unconfirmed', error: 'spawn observation unavailable' }]);
  expect(report).toMatchObject({ leader: { state: 'unknown' }, executors: { state: 'unknown' }, recovery: 'held' });
});
it('persists timeout separately from actual late exit and keeps DB drainage pending', async () => {
  const f = fixture('export async function run(){process.on("SIGTERM",()=>{});console.log("running");while(true){}}');
  const handle = f.runtime.start(f.start); await handle.ready;
  await expect.poll(() => handle.logs().stdout).toContain('running');
  const ignoredKill = vi.spyOn(ChildProcess.prototype, 'kill').mockReturnValue(true);
  let pid: number | undefined;
  try {
    const bounded = await handle.stop(); expect(bounded.worker.kind).toBe('exit_unconfirmed');
    const report = f.runtime.observeWorkerProcess(f.binding); pid = report.launch!.pid;
    expect(report.observations.map(event => event.kind)).toEqual(['exit_unconfirmed']);
    await f.runtime.close(); let drained = false; const drainage = f.runtime.drainDatabaseUsers().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(drained).toBe(false);
    process.kill(pid, 'SIGKILL'); await handle.finalExit; await drainage;
    expect(new GraphProcessJournal(f.db).observe(f.binding).observations.map(event => event.kind)).toEqual(['exit_unconfirmed', 'exited']);
  } finally { ignoredKill.mockRestore(); if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
});

it('reopens consumed registration failure from SQLite without inferring that an intent-only launch stopped', async () => {
  const f = fixture(); const register = vi.spyOn(f.checkpoints, 'register').mockImplementation(() => { throw new Error('checkpoint registration failed'); });
  const handle = f.runtime.start(f.start); const exit = await handle.finalExit;
  register.mockRestore(); await f.runtime.close(); await f.runtime.drainDatabaseUsers();
  const path = f.db.name; f.db.close(); const reopened = openDb({ path });
  try {
    const report = new GraphProcessJournal(reopened).observe(f.binding);
    expect(report).toMatchObject({ intentRecorded: true, launch: null, leader: { state: 'absent', reason: 'authenticated_no_child' }, recovery: 'held' });
    expect(report.observations).toEqual([exit]);
  } finally { reopened.close(); }
});
it('refuses changed compiled program bytes on a fresh runtime before launching', async () => {
  const f = fixture(); const handle = f.runtime.start(f.start); await handle.finalExit;
  const fresh = new GraphRuntime(f.options);
  try {
    const identity = { ...f.run.identity, compiledProgramDigest: 'f'.repeat(64) };
    expect(() => fresh.start({ ...f.start, run: { ...f.run, identity }, registration: { ...f.start.registration, identity } })).toThrow('PROGRAM_IDENTITY_MISMATCH');
    expect(fresh.observeWorkerProcess(f.binding).observations).toHaveLength(1);
  } finally { await fresh.close(); await fresh.drainDatabaseUsers(); }
});


FILE packages/cli/src/graph-worker-manager.test.ts
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


FILE packages/protocol/src/graph-worker.ts
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { GraphScope, StartGraphRequest, GraphJsonValue } from './graph.js';

export const GRAPH_WORKER_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const GraphWorkerIdentity = z.object({
  executionModel: z.literal('langgraph-functional-v1'), durability: z.literal('sync'),
  engineVersion: id, checkpointVersion: id, templateVersion: id, registryVersion: id,
  compilerVersion: id, schemaVersion: id, compiledProgramDigest: digest, specHash: digest, inputDigest: digest,
}).strict();
export const GraphWorkerBinding = z.object({ scope: GraphScope, graphRunId: id,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), owner: id, identity: GraphWorkerIdentity }).strict();
export type GraphWorkerBinding = z.infer<typeof GraphWorkerBinding>;
export const GraphWorkerResume = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('continue') }).strict(),
  z.object({ kind: z.literal('interrupt'), value: GraphJsonValue }).strict(),
]);
export type GraphWorkerResume = z.infer<typeof GraphWorkerResume>;
const bound = { binding: GraphWorkerBinding };
export const GraphWorkerMessage = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('init'), ...bound, programId: id, source: z.string().min(1).max(131072),
    input: StartGraphRequest, resume: GraphWorkerResume.optional(),
    heartbeatMs: z.number().int().min(10).max(60000), maxInFlight: z.number().int().min(1).max(64),
    requestTimeoutMs: z.number().int().min(10).max(300000) }).strict(),
  z.object({ kind: z.literal('ready'), ...bound }).strict(),
  z.object({ kind: z.literal('heartbeat'), ...bound }).strict(),
  z.object({ kind: z.literal('cancel'), ...bound, reason: z.string().max(4096) }).strict(),
  z.object({ kind: z.literal('request'), ...bound, id, method: z.enum(['action', 'checkpoint']), payload: z.unknown() }).strict(),
  z.object({ kind: z.literal('response'), ...bound, id, ok: z.boolean(), payload: z.unknown().optional(), error: z.string().max(4096).optional() }).strict(),
  z.object({ kind: z.literal('done'), ...bound, ok: z.boolean(), value: GraphJsonValue.optional(), error: z.string().max(4096).optional() }).strict(),
]);
export type GraphWorkerMessage = z.infer<typeof GraphWorkerMessage>;
export function workerCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(workerCanonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${workerCanonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
export function freezeWorkerData<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freezeWorkerData); Object.freeze(value); }
  return value;
}
export function encodeWorkerFrame(value: unknown, maxBytes = GRAPH_WORKER_MAX_FRAME_BYTES): Buffer {
  const json = JSON.stringify(value); const size = Buffer.byteLength(json);
  if (size === 0 || size > maxBytes) throw new Error('WORKER_FRAME_LIMIT');
  const frame = Buffer.allocUnsafe(size + 4); frame.writeUInt32BE(size); frame.write(json, 4); return frame;
}
/** Never concatenates arbitrary incoming chunks. Only a checked length allocates a body. */
export class WorkerFrameDecoder {
  private readonly header = Buffer.alloc(4);
  private headerUsed = 0;
  private body: Buffer | undefined;
  private used = 0;
  private failed = false;
  constructor(private readonly receive: (value: unknown) => void, private readonly maxBytes = GRAPH_WORKER_MAX_FRAME_BYTES) {}
  get bufferedBytes(): number { return this.headerUsed + this.used; }
  push(chunk: Buffer): void {
    if (this.failed) throw new Error('WORKER_TRANSPORT_CLOSED');
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (!this.body) {
          const count = Math.min(4 - this.headerUsed, chunk.length - offset);
          chunk.copy(this.header, this.headerUsed, offset, offset + count); this.headerUsed += count; offset += count;
          if (this.headerUsed < 4) continue;
          const size = this.header.readUInt32BE(); this.headerUsed = 0;
          if (!size || size > this.maxBytes) throw new Error('WORKER_FRAME_LIMIT');
          this.body = Buffer.allocUnsafe(size); this.used = 0;
        }
        const count = Math.min(this.body.length - this.used, chunk.length - offset);
        chunk.copy(this.body, this.used, offset, offset + count); this.used += count; offset += count;
        if (this.used === this.body.length) {
          const body = this.body; this.body = undefined; this.used = 0;
          this.receive(JSON.parse(body.toString('utf8')));
        }
      }
    } catch (error) { this.failed = true; this.body = undefined; this.used = 0; this.headerUsed = 0; throw error; }
  }
}
/** Fail closed on a stalled peer; no additional userland send queue. */
export class WorkerFramedTransport {
  private closed = false;
  private readonly maxFrameBytes: number;
  private readonly maxBufferedBytes: number;
  constructor(private readonly readable: Readable, private readonly writable: Writable,
    receive: (value: unknown) => void, private readonly failure: (error: Error) => void,
    limits: { maxFrameBytes?: number; maxBufferedBytes?: number } = {}) {
    this.maxFrameBytes = limits.maxFrameBytes ?? GRAPH_WORKER_MAX_FRAME_BYTES;
    this.maxBufferedBytes = limits.maxBufferedBytes ?? this.maxFrameBytes * 2 + 8;
    const decoder = new WorkerFrameDecoder(value => { if (!this.closed) receive(value); }, this.maxFrameBytes);
    readable.on('data', (chunk: Buffer) => { try { decoder.push(chunk); } catch (error) { this.fail(error); } });
    readable.on('end', () => this.fail(new Error('WORKER_TRANSPORT_EOF')));
    readable.on('error', error => this.fail(error));
    writable.on('error', error => this.fail(error));
  }
  send(value: unknown): void {
    if (this.closed) throw new Error('WORKER_TRANSPORT_CLOSED');
    const frame = encodeWorkerFrame(value, this.maxFrameBytes);
    if (this.writable.writableLength + frame.length > this.maxBufferedBytes) throw new Error('WORKER_BACKPRESSURE');
    this.writable.write(frame, error => { if (error) this.fail(error); });
  }
  private fail(error: unknown): void {
    if (this.closed) return;
    this.close(); this.failure(error instanceof Error ? error : new Error(String(error)));
  }
  close(): void { this.closed = true; this.readable.destroy(); this.writable.destroy(); }
}


FILE packages/cli/src/graph-chain.integration.test.ts
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


FILE scripts/fixtures/graph-chain-host.ts
// Dedicated C5 trusted test host. Bundle with esbuild; never shipped as CLI/RPC.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { FifoSemaphore, inspectRepoWriteLock, releaseReconciledRepoWriteLock } from '@osstack/autonomy';
import { openDb, GraphRunStore, GraphCheckpointStore, GraphActionStore, resolveRepositoryScope } from '@osstack/core';
import { GraphArtifactStore } from '@osstack/core/graph-artifacts';
import { createWorktree, quarantineGraphWorktree, type WorktreeHandle } from '@osstack/agents';
import { ExecutionPlan } from '@osstack/loop';
import { startDaemon } from '../../packages/cli/src/daemon.js';
import { GraphRuntime } from '../../packages/cli/src/graph-runtime.js';
import { GraphCheckpointService } from '../../packages/cli/src/graph-checkpoint-service.js';
import type { StartGraphRequest } from '@osstack/protocol';
import { GraphActionBroker, type GraphActionEvidence, type GraphWorkerRegistration } from '../../packages/cli/src/graph-action-broker.js';
import { GovernedExecution } from '../../packages/cli/src/governed-execution.js';
import { healthyAutonomyHealth } from '../../packages/cli/src/test-healthy-autonomy.js';

const root = resolve(process.argv[2]!);
const assemblyOnly = process.argv[3] === 'assembly';
const home = process.env['OSSTACK_HOME'];
if (!home || !isAbsolute(home) || home === join(homedir(), '.osstack')) throw new Error('G17_EXPLICIT_TEST_HOME_REQUIRED');
const repo = join(root, 'repo'); const external = join(root, 'external.log'); const reentries = join(root, 'reentries.log');
const durable = (path: string, value: unknown) => { writeFileSync(path, JSON.stringify(value)); const fd = openSync(path, 'r'); fsyncSync(fd); closeSync(fd); };
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
if (!existsSync(repo)) {
  execFileSync('git', ['init', '-q', repo]); mkdirSync(join(repo, '.osstack'));
  writeFileSync(join(repo, '.osstack/policy.yaml'), 'schema_version: 1\nmode: execute\n');
  writeFileSync(join(repo, 'file.txt'), 'before\n'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base');
}
const base = git('rev-parse', 'HEAD'); const canonical = await resolveRepositoryScope(repo);
const source = `
export async function run(context) {
  process.on('SIGTERM', () => {});
  process.on('unhandledRejection', () => {});
  setInterval(() => {}, 1000);
  const fs = await import('node:fs');
  const invoke = async (nodeId, action) => {
    fs.appendFileSync(${JSON.stringify(reentries)}, nodeId + ':' + context.binding.generation + '\\n');
    const b = context.binding;
    const response = await context.action({schemaVersion:1,kind:'worker_action',requestId:nodeId+':'+b.generation,
      scope:b.scope,graphRunId:b.graphRunId,specHash:b.identity.specHash,generation:b.generation,epoch:0,nodeId,effectSlot:'invoke',action});
    if(response.kind !== 'worker_action_response' || response.outcome.state !== 'confirmed') throw new Error(JSON.stringify(response));
    return response.outcome.result;
  };
  await context.task('implement', async () => invoke('implement', {kind:'implement',inputArtifactRef:'input',workspaceLeaseRef:'workspace'}))();
  return await context.task('freeze', async () => invoke('freeze', {kind:'freeze',workspaceLeaseRef:'workspace',receiptRef:'implementation-receipt'}))();
}`;
const modulePath = join(root, 'program.mjs'); writeFileSync(modulePath, source);
const programs = [{ id: 'c5-chain', modulePath, digest: createHash('sha256').update(source).digest('hex') }];
const version = { executionModel: 'langgraph-functional-v1' as const, durability: 'sync' as const, engineVersion: '1.4.15', checkpointVersion: '1.1.5', templateVersion: '1', registryVersion: '1', compilerVersion: '1', schemaVersion: '1', compiledProgramDigest: programs[0]!.digest };
const request: StartGraphRequest = { schemaVersion: 1 as const, kind: 'start' as const, scope: { schemaVersion: 1 as const, tenantId: 'tenant', principalId: 'principal', workspaceId: 'workspace' }, idempotencyKey: `c5:${root}`, inputArtifactRef: 'input', source: { product: 'osstack' as const, requestId: 'request' }, spec: { schemaVersion: 1 as const, template: 'code-delivery-v1' as const, publication: 'artifact_only' as const, input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: base, acceptanceRef: 'acceptance' }, limits: { maxEpochs: 1, maxBranchAttempts: 3, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 5, deadlineSeconds: Number(process.argv[4] ?? 120), tokenReservationLimit: 100 } } };
const send = (value: unknown) => { process.send?.(value); };
let fault = ''; let held: (() => void) | undefined;
const checkpointExecute = GraphCheckpointService.prototype.execute;
// Test-only wrapper at the actual durable service boundary, no alternate saver.
GraphCheckpointService.prototype.execute = async function(connection, value) {
  const wire = value as { kind: string; writes?: Array<{channel: string; value: string}>; checkpoint?: string };
  appendFileSync(join(root, 'checkpoint-trace.jsonl'), JSON.stringify(value) + '\n');
  const boundary = ['before-final', 'after-final'].includes(fault) && wire.kind === 'put' && wire.checkpoint?.includes('candidate_ready');
  if (!boundary) return checkpointExecute.call(this, connection, value);
  const point = fault; fault = '';
  const committed = point === 'after-final' ? await checkpointExecute.call(this, connection, value) : undefined;
  await new Promise<void>(done => { held = done; send({ event: 'boundary', point }); });
  if (committed) return committed;
  return checkpointExecute.call(this, connection, value);
};
const brokerHandle = GraphActionBroker.prototype.handle;
GraphActionBroker.prototype.handle = async function(connection, value, options) {
  const response = await brokerHandle.call(this, connection, value, options);
  if (fault === 'before-return' && response.kind === 'worker_action_response' && response.outcome.state === 'confirmed'
    && response.outcome.result.kind === 'implementation_complete') {
    fault = ''; await new Promise<void>(done => { held = done; send({ event: 'boundary', point: 'before-return' }); });
  }
  return response;
};
const daemon = assemblyOnly ? undefined : await startDaemon({ socketPath: join(root, 'daemon.sock'), adapters: [], autonomyHealth: async () => healthyAutonomyHealth() });
const db = openDb({ path: daemon?.dbPath ?? join(root, 'state.db') });
const runs = new GraphRunStore(db); const artifacts = new GraphArtifactStore(join(root, 'artifacts'));
const admission = new GovernedExecution({ reads: new FifoSemaphore(2), writes: new FifoSemaphore(1), repositories: new Map(), checkHealth: async () => {} });
const broker = daemon ? await daemon.graphActionBroker() : new GraphActionBroker(db, { acquire: admission.acquire.bind(admission) });
const configuration = { programs, workerOptions: { workerEntry: resolve('packages/graph/dist/worker-entry.js'), shutdownTimeoutMs: 30, terminationTimeoutMs: 30 }, drainTimeoutMs: 1000 };
const runtime = daemon ? await daemon.graphRuntime(configuration) : new GraphRuntime({ ...configuration, db, broker,
  checkpoints: new GraphCheckpointService({ runs, checkpoints: new GraphCheckpointStore(db), bindings: new Map() }) });
let run = runtime.prepare(request, version);
const worktreeFile = join(root, 'worktree.json');
const worktree: WorktreeHandle = existsSync(worktreeFile) ? JSON.parse(readFileSync(worktreeFile, 'utf8')) : await createWorktree({
  repoPath: repo, runId: run.graphRunId, rootPath: join(root, 'worktrees'), baseRef: base,
  graphRetention: { runId: run.graphRunId, scopeKey: createHash('sha256').update(JSON.stringify(run.scope)).digest('hex'), generation: 1, workspaceLeaseRef: 'workspace' },
});
durable(worktreeFile, worktree);
const workspace = worktree.worktreePath;
let handle: ReturnType<GraphRuntime['start']> | undefined;
let stopped: Awaited<ReturnType<ReturnType<GraphRuntime['start']>['stop']>> | undefined;
let verdictMode = 'applied'; let releaseFails = false;
const receiptPath = join(root, 'implementation.json');
const receipt = (): GraphActionEvidence => JSON.parse(readFileSync(receiptPath, 'utf8'));
const assertProducer = () => {
  const r = receipt();
  if (!r.command?.termination?.stop_confirmed || !Number.isInteger(r.command.termination.pgid)) throw new Error('G04_STOP_UNPROVEN');
  const row = db.prepare("SELECT execution_ref FROM graph_actions WHERE graph_run_id = ? AND node_id = 'implement'").get(run.graphRunId) as { execution_ref: string } | undefined;
  if (!r.candidate?.execution?.run_id || !row?.execution_ref?.endsWith(':' + r.candidate.execution.run_id)
    || r.candidate.workspace.workspace_path !== workspace || r.candidate.workspace.workspace_id !== run.scope.workspaceId) throw new Error('G04_RECEIPT_IDENTITY');
  return r;
};
const registration = (): GraphWorkerRegistration => ({ scope: run.scope, graphRunId: run.graphRunId, identity: run.identity, generation: run.generation, owner: run.leaseOwner!, epoch: 0,
  workspace: { workspace_id: 'workspace', workspace_path: workspace }, authorize: () => {}, actions: [
    { nodeId: 'implement', effectSlot: 'invoke', tokenReservation: 0, action: { kind: 'implement' as const, inputArtifactRef: 'input', workspaceLeaseRef: 'workspace' },
      execution: { kind: 'command' as const, command: fault === 'unknown-not-applied' ? 'true' : fault.startsWith('cancel') ? `exec node -e 'const fs=require("fs");${fault === 'cancel-stubborn' ? 'process.on("SIGTERM",()=>{});' : ''}fs.writeFileSync(${JSON.stringify(join(root, 'command.pid'))},String(process.pid));fs.appendFileSync(${JSON.stringify(external)},"started\\n");setInterval(()=>{},1000)'` : `node -e 'const fs=require("fs");fs.appendFileSync(${JSON.stringify(external)},"once\\n");fs.writeFileSync("file.txt","after\\n")'`,
        plan: ExecutionPlan.parse({ plan_id: 'plan', agent_id: 'local-command', task: { task_id: 'task', capability: 'code.write', prompt: 'change', source: 'manual' }, stop_condition: { type: 'tests_pass' } }) },
      persist: async (evidence: GraphActionEvidence) => { durable(receiptPath, evidence); if (fault === 'hold-persist') { fault = ''; await new Promise<void>(done => { held = done; send({ event: 'boundary', point: 'persist' }); }); } if (fault.startsWith('unknown')) throw new Error('TEST_LOST_PERSIST_RESULT');
        return { evidenceRef: 'implementation-receipt', actualTokens: 0, result: { schemaVersion: 1 as const, kind: 'implementation_complete' as const, workspaceLeaseRef: 'workspace', receiptRef: 'implementation-receipt' } }; } },
    { nodeId: 'freeze', effectSlot: 'invoke', tokenReservation: 0, action: { kind: 'freeze' as const, workspaceLeaseRef: 'workspace', receiptRef: 'implementation-receipt' },
      execution: { kind: 'freeze' as const, store: artifacts, input: { artifactId: `candidate:${run.graphRunId}`, scope: run.scope, runId: run.graphRunId, generation: run.generation, owner: run.leaseOwner!, workspaceLeaseRef: 'workspace', repoId: canonical.repoId, commonDir: canonical.commonDir, worktreePath: workspace, baseRevision: base, implementationReceiptRef: 'implementation-receipt', producerStopEvidenceRef: 'g04-stopped' },
        authority: { verifyLease: async (_input, lease) => { if (!('assertActive' in lease) || typeof lease.assertActive !== 'function') throw new Error('LEASE_REQUIRED'); await lease.assertActive(); },
          verifyImplementationReceipt: async () => { assertProducer(); const row = db.prepare("SELECT state, execution_ref FROM graph_actions WHERE graph_run_id = ? AND node_id = 'implement'").get(run.graphRunId) as { state: string; execution_ref: string } | undefined;
            if (row?.state !== 'confirmed' || !assertProducer().candidate?.execution?.run_id || !row.execution_ref?.endsWith(':' + assertProducer().candidate!.execution!.run_id)) throw new Error('IMPLEMENTATION_RECEIPT_MISMATCH'); },
          verifyProducersStopped: async () => { assertProducer(); } } },
      persist: async (evidence: GraphActionEvidence) => ({ evidenceRef: 'frozen-receipt', actualTokens: 0, result: evidence.frozenCandidate! }) },
  ] });
const current = () => runs.get(run.scope, run.graphRunId)!;
const fence = () => { const r = current(); return { scope: r.scope, graphRunId: r.graphRunId, identity: r.identity, expectedGeneration: r.generation, expectedRevision: r.revision, expectedOwner: r.leaseOwner, now: Date.now() }; };
const inspect = async () => ({ run: current(), actions: db.prepare('SELECT node_id,state,execution_ref,outcome_json FROM graph_actions WHERE graph_run_id = ? ORDER BY created_at').all(run.graphRunId),
  budget: (() => { const row = db.prepare('SELECT effect_key FROM graph_actions WHERE graph_run_id = ? LIMIT 1').get(run.graphRunId) as { effect_key: string } | undefined; return row ? new GraphActionStore(db).get(fence(), row.effect_key).budget : { actionStarts: 0 }; })(),
  external: existsSync(external) ? readFileSync(external, 'utf8') : '', reentries: existsSync(reentries) ? readFileSync(reentries, 'utf8') : '',
  finalCheckpoints: db.prepare("SELECT count(*) AS n FROM graph_checkpoints WHERE graph_run_id = ? AND checkpoint LIKE '%candidate_ready%'").get(run.graphRunId),
  checkpoints: db.prepare('SELECT count(*) AS n FROM graph_checkpoints WHERE graph_run_id = ?').get(run.graphRunId),
  writes: db.prepare('SELECT channel,value FROM graph_checkpoint_writes WHERE graph_run_id = ?').all(run.graphRunId),
  lock: await inspectRepoWriteLock(join(canonical.commonDir, 'osstack/writer-locks'), canonical.repoId), stopped });
function recovery() {
  const key = {}; const fixed = current();
  const verifyWorker = async () => {
    const exit = stopped?.worker;
    if (!exit || exit.kind !== 'exited' || !stopped?.actionsSettled || exit.graphRunId !== fixed.graphRunId || exit.generation !== fixed.generation || exit.owner !== fixed.leaseOwner) throw new Error('NO_OBSERVED_EXIT');
    // Same daemon uses its supervisor receipt; restart uses durable host receipt
    // produced only after the prior daemon supervisor actually observed OS exit.
    if (handle && JSON.stringify(runtime.observedExit(handle.connection)) !== JSON.stringify(exit)) throw new Error('EXIT_RECEIPT_MISMATCH');
    return { kind: 'stopped' as const, graphRunId: exit.graphRunId, generation: exit.generation, owner: exit.owner, confirmedAt: exit.confirmedAt, evidenceRef: exit.evidenceRef };
  };
  runtime.reconciler.register(key, { binding: { scope: fixed.scope, graphRunId: fixed.graphRunId, identity: fixed.identity, generation: fixed.generation, owner: fixed.leaseOwner }, authorize: () => {},
    stopWorker: async () => stopped, verifyWorker,
    verifyQuiescence: async () => { assertProducer(); await quarantineGraphWorktree(worktree, 'C5 recovery: preserve original producer workspace'); durable(join(root, 'quarantine.json'), { repo: canonical.repoId, runId: fixed.graphRunId, workspace, retained: true });
      return { executorEvidenceRef: 'g04-stopped', workspaceEvidenceRef: 'retained-test-workspace' }; },
    verifyOutcome: async () => { if (verdictMode === 'not_applied' && (existsSync(external) || readFileSync(join(workspace, 'file.txt'), 'utf8') !== 'before\n')) throw new Error('ABSENCE_UNPROVEN');
      if (verdictMode === 'applied' && (!existsSync(external) || readFileSync(external, 'utf8') !== 'once\n')) throw new Error('APPLIED_UNPROVEN');
      return verdictMode === 'unknown' ? { outcome: 'unknown', evidenceRef: 'still-unknown', observedTokens: 0 }
      : verdictMode === 'not_applied' ? { outcome: 'not_applied', evidenceRef: 'verified-absent', actualTokens: 0, error: null }
      : { outcome: 'applied', evidenceRef: 'implementation-receipt', actualTokens: 0, result: { schemaVersion: 1, kind: 'implementation_complete', workspaceLeaseRef: 'workspace', receiptRef: 'implementation-receipt' } }; },
    recheck: () => { assertProducer(); if (!stopped?.actionsSettled || stopped.worker.kind !== 'exited') throw new Error('NOT_QUIESCENT'); },
    release: async (result, reverify) => { if (releaseFails) throw new Error('TEST_RELEASE_FAILURE');
      if (result.action) {
        const effectKey = result.action.effectKey;
        const released = await broker.releaseReconciled(effectKey, reverify);
        if (!released) {
          const rootDir = join(canonical.commonDir, 'osstack/writer-locks');
          const owner = await inspectRepoWriteLock(rootDir, canonical.repoId);
          if (owner) {
            if (owner.autonomy_run_id !== `graph-action:${effectKey}`) throw new Error('RETAINED_LOCK_IDENTITY');
            await releaseReconciledRepoWriteLock({ root_dir: rootDir, repo_id: canonical.repoId, expectedOwner: owner,
              verifyQuiescent: async () => { await reverify(); } });
          }
        }
      } },
  }); return key;
}
if (existsSync(join(root, 'stopped.json'))) {
  const prior = JSON.parse(readFileSync(join(root, 'stopped.json'), 'utf8'));
  if (JSON.stringify(prior.scope) !== JSON.stringify(run.scope) || JSON.stringify(prior.identity) !== JSON.stringify(run.identity)) throw new Error('PRIOR_HOST_RECEIPT_IDENTITY');
  try { process.kill(prior.daemonPid, 0); throw new Error('PRIOR_DAEMON_STILL_ALIVE'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  stopped = { worker: prior.worker, actionsSettled: prior.actionsSettled };
}
send({ event: 'ready', pid: process.pid, run, dbPath: db.name });
process.on('message', async (message: any) => {
  try {
    let value: unknown;
    if (message.op === 'start') {
      fault = message.fault ?? ''; if (run.generation === 0) run = runtime.claim(run, `owner:${process.pid}`, Date.now() + 60_000);
      handle = runtime.start({ request, run, programId: 'c5-chain', registration: registration(), authorize: () => {}, ...(run.generation > 1 ? { resume: { kind: 'continue' as const } } : {}) });
      void handle.result.then(result => send({ event: 'result', result }), error => send({ event: 'result-error', error: String(error), logs: handle?.logs() }));
      await handle.ready; value = { run };
    } else if (message.op === 'stop') {
      const stopPromise = handle!.stop(); if (message.releaseHold !== false) { held?.(); held = undefined; } stopped = await stopPromise; durable(join(root, 'stopped.json'), { ...stopped, daemonPid: process.pid, scope: run.scope, identity: run.identity }); value = { ...stopped, logs: handle!.logs() };
    } else if (message.op === 'release-hold') { held?.(); held = undefined; value = true; }
    else if (message.op === 'inspect') value = await inspect();
    else if (message.op === 'singleton') { if (!daemon) throw new Error('daemon required'); value = await daemon.graphRuntime(configuration); }
    else if (message.op === 'old-action') { value = await broker.handle(handle!.connection, { schemaVersion: 1, kind: 'worker_action', requestId: 'old', scope: run.scope, graphRunId: run.graphRunId, specHash: run.identity.specHash, generation: handle!.binding.generation, epoch: 0, nodeId: 'implement', effectSlot: 'invoke', action: { kind: 'implement', inputArtifactRef: 'input', workspaceLeaseRef: 'workspace' } }); }
    else if (message.op === 'takeover') { const result = await runtime.reconciler.reconcile(recovery(), { kind: 'takeover', fence: fence(), receiptId: `takeover:${run.generation}`, owner: `owner:${process.pid}:${run.generation + 1}`, leaseExpiresAt: Date.now() + 60_000 }); run = result.result.run; value = result; }
    else if (message.op === 'reconcile') { verdictMode = message.verdict; releaseFails = message.releaseFails ?? false;
      const action = db.prepare("SELECT effect_key FROM graph_actions WHERE graph_run_id = ? AND node_id = 'implement'").get(run.graphRunId) as { effect_key: string };
      value = await runtime.reconciler.reconcile(recovery(), { kind: 'effect', fence: fence(), receiptId: message.receiptId, effectKey: action.effect_key }); }
    else if (message.op === 'verify') { const row = db.prepare("SELECT outcome_json FROM graph_actions WHERE graph_run_id = ? AND node_id = 'freeze'").get(run.graphRunId) as { outcome_json: string };
      const result = JSON.parse(row.outcome_json).result; const manifest = await artifacts.verify(result.artifactDigest); const restored = await artifacts.restore(result.artifactDigest, { rootPath: root, directoryName: `restored-${Date.now()}` });
      value = { manifest, restored, content: readFileSync(join(restored.worktreePath, 'file.txt'), 'utf8') }; }
    else if (message.op === 'close') { await runtime.close(); if (daemon) await daemon.close(); db.close(); send({ id: message.id, value: true }); process.exit(0); }
    else throw new Error('unknown fixture command');
    send({ id: message.id, value });
  } catch (error) { send({ id: message.id, error: String(error), stack: (error as Error).stack }); }
});


FILE packages/cli/src/graph-review-findings.test.ts
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDb, CapabilitySchema } from '@osstack/core';
import { GraphDelegationStatus, type StartGraphRequest } from '@osstack/protocol';
import { FifoSemaphore } from '@osstack/autonomy';
import { GraphRpcService, type GraphHostRegistration } from './graph-rpc.js';
import { GraphDelivery } from './graph-delivery.js';
import { makeRepositoryPolicyGate } from './repository-policy.js';
import { GovernedExecution } from './governed-execution.js';
import type { AgentAdapter } from '@osstack/agents';
const quoteShell = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
async function fixture(mode: 'success' | 'review' | 'tests' | 'tests-slow-stop' | 'unknown' = 'success') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'g22-rpc-'))); const repo = join(root, 'source'); await mkdir(repo);
  git(repo, 'init', '-q'); await writeFile(join(repo, 'answer'), '0\n'); git(repo, 'add', '.'); git(repo, '-c', 'user.name=G22', '-c', 'user.email=g22@invalid', 'commit', '-qm', 'base');
  const db = openDb({ path: join(root, 'control.sqlite') }); let writes = 0; let reviewStarted = false; let granted = true; let abortObserved = false;
  const stopped = new Set<string>();
  const writer: AgentAdapter = { id: 'writer', display_name: 'writer', cost_tier: 'low',
    capabilities: () => [CapabilitySchema.parse({ id: 'write', agent_id: 'writer', kind: 'code.write', description: 'write' })],
    isAvailable: async () => ({ available: true, last_checked_at: 0 }),
    invoke: async function* (task) {
      writes++;
      await writeFile(join(String(task.context?.['repo_path']), 'answer'), '1\n');
      stopped.add(task.run_id);
      yield { event_id: task.run_id, run_id: task.run_id, session_id: task.session_id, seq: 1, created_at: Date.now() / 1000, type: 'done', terminal: true,
        payload: { status: 'completed', last_seq: 0, result_summary: 'implemented', usage: { tokens_in: 1, tokens_out: 1, duration_ms: 1 } } };
    }, confirmStopped: async id => ({ stopped: stopped.has(id), evidence: `finite:${id}` }) };
  const reviewer: AgentAdapter = { ...writer, id: 'reviewer', capabilities: () => [CapabilitySchema.parse({ id: 'review', agent_id: 'reviewer', kind: 'review.code', description: 'review' })],
    invoke: async function* (task, signal) {
      const good = (await readFile(join(String(task.context?.['repo_path']), 'answer'), 'utf8')).trim() === '1';
      reviewStarted = true;
      if (mode === 'review' || mode === 'unknown') {
        await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
        abortObserved = true;
      }
      if (mode !== 'unknown') stopped.add(task.run_id);
      yield { event_id: task.run_id, run_id: task.run_id, session_id: task.session_id, seq: 1, created_at: Date.now() / 1000, type: 'done', terminal: true,
        payload: { status: signal.aborted ? 'failed' : 'completed', last_seq: 0, result_summary: JSON.stringify({ schemaVersion: 1, verdict: good ? 'accept' : 'changes_requested', summary: 'actual candidate', findings: good ? [] : ['answer must be 1'] }), usage: { tokens_in: 1, tokens_out: 1, duration_ms: 1 } } };
    } };
  const request: StartGraphRequest = { schemaVersion: 1, kind: 'start', scope: { schemaVersion: 1, tenantId: 't', principalId: 'p', workspaceId: 'w' },
    idempotencyKey: 'public-key', inputArtifactRef: 'input', source: { product: 'osstack', requestId: 'request', parentRunId: 'parent' },
    spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only', input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: git(repo, 'rev-parse', 'HEAD'), acceptanceRef: 'acceptance' },
      limits: { maxEpochs: 2, maxBranchAttempts: 1, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 14, tokenReservationLimit: 200000, deadlineSeconds: 120 } } };
  const registration: GraphHostRegistration = { id: 'local', scope: request.scope, product: 'osstack', repositoryRef: 'repo', taskRef: 'task', inputArtifactRef: 'input',
    authorize: operation => { if (!granted && operation !== 'read' && operation !== 'cancel') throw Error('GRANT_EXPIRED'); },
    delivery: { repositoryPath: repo, task: 'Set answer to 1', writer: { identity: 'writer', adapter: writer, capabilityId: 'write' }, reviewer: { identity: 'reviewer', adapter: reviewer, capabilityId: 'review' },
      verifyReviewer: async proof => { if (proof.writerIdentity === proof.reviewerIdentity) throw Error('independence'); },
      acceptanceRegistry: [{ ref: 'acceptance', command: mode.startsWith('tests') ? `exec ${quoteShell(process.execPath)} -e ${quoteShell(`process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),${mode === 'tests-slow-stop' ? 150 : 0}));require('node:fs').writeFileSync(${JSON.stringify(join(root, 'command-started'))},'ready');setInterval(()=>{},1000)`)}` : 'test "$(cat answer)" = 1', passExitCodes: [0], failExitCodes: [1] }] } };
  const connection = {};
  const admission = new GovernedExecution({ reads: new FifoSemaphore(2), writes: new FifoSemaphore(2), repositories: new Map(), checkHealth: async () => {} });
  const options = { db, root: join(root, 'delivery'), registrations: [registration], resolveCaller: (key: object) => key === connection ? 'local' : null, acquire: admission.acquire.bind(admission) };
  const service = new GraphRpcService(options);
  const start = async () => GraphDelegationStatus.parse(await service.handle(connection, 'graph.start', request));
  const status = async (id: string, host = service) => GraphDelegationStatus.parse(await host.handle(connection, 'graph.status', { schemaVersion: 1, scope: request.scope, graphRunId: id }));
  const until = async (id: string, predicate: (s: ReturnType<typeof GraphDelegationStatus.parse>) => boolean) => {
    const deadline = Date.now() + 20000;
    for (;;) { const value = await status(id); if (predicate(value)) return value;
      if (Date.now() > deadline) throw Error(`TIMEOUT: ${JSON.stringify(value)}`); await new Promise(resolve => setTimeout(resolve, 15)); }
  };
  return { root, db, request, registration, connection, service, start, status, until, options, writer, reviewer,
    writes: () => writes, reviewStarted: () => reviewStarted, abortObserved: () => abortObserved, grant: (value: boolean) => { granted = value; },
    close: async () => { await service.close(); db.close(); } };
}

it.each(['review', 'tests', 'tests-slow-stop', 'unknown'] as const)('settles stopped %s cancellation with revoked execute, holding only unproven stop', async mode => {
  const f = await fixture(mode);
  try {
    const run = await f.start();
    if (mode.startsWith('tests')) {
      const deadline = Date.now() + 15000;
      for (;;) { try { await readFile(join(f.root, 'command-started')); break; } catch { if (Date.now() > deadline) throw Error('command did not start'); await new Promise(resolve => setTimeout(resolve, 15)); } }
    } else await f.until(run.graphRunId, () => f.reviewStarted());
    f.grant(false);
    const before = await f.status(run.graphRunId);
    await f.service.handle(f.connection, 'graph.cancel', { schemaVersion: 1, kind: 'cancel', scope: f.request.scope, idempotencyKey: 'cancel', graphRunId: run.graphRunId, expectedRevision: before.revision });
    await f.service.close();
    const branch = mode.startsWith('tests') ? 'tests' : 'review';
    const row = f.db.prepare('SELECT state, outcome_json FROM graph_actions WHERE node_id=?').get(`e0.${branch}`) as { state: string; outcome_json: string };
    expect(row.state).toBe(mode === 'unknown' ? 'unknown' : 'failed');
    expect(f.db.prepare('SELECT status FROM graph_runs').get()).toEqual({ status: mode === 'unknown' ? 'cancel_pending' : 'cancelled' });
    expect(f.db.prepare('SELECT count(*) n FROM graph_action_admissions WHERE released_at IS NULL').get()).toEqual({ n: mode === 'unknown' ? 1 : 0 });
    if (mode !== 'unknown') {
      const outcome = JSON.parse(row.outcome_json);
      expect(outcome).toMatchObject({ state: 'failed', retrySafe: false, evidenceRef: expect.stringMatching(/^graph-verification:/) });
      const evidence = JSON.parse(await readFile(join(f.root, 'delivery', run.graphRunId, 'verification', 'evidence', outcome.evidenceRef.slice('graph-verification:'.length) + '.json'), 'utf8'));
      expect(evidence.verificationFailure).toMatchObject({ retrySafe: false });
      expect(evidence.report).toBeUndefined();
      expect(evidence.evidence.stopped).toBe(true);
      expect(f.db.prepare('SELECT count(*) n FROM graph_verification_joins').get()).toEqual({ n: 0 });
    }
  } finally { await f.close(); }
}, 30000);

it.each(['revoked', 'untracked', 'newer'] as const)('uses current source policy (%s) beyond workspace creation and writer availability', async mode => {
  const f = await fixture(); const repo = f.registration.delivery.repositoryPath;
  const policy = join(repo, '.osstack', 'policy.yaml'); await mkdir(join(repo, '.osstack'));
  const setPolicy = (value: string) => writeFile(policy, `schema_version: 1\nmode: ${value}\n`);
  await setPolicy('execute');
  if (mode === 'revoked') { git(repo, 'add', '.osstack/policy.yaml'); git(repo, '-c', 'user.name=test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'policy'); f.request.spec.input.baseRevision = git(repo, 'rev-parse', 'HEAD'); }
  if (mode === 'newer') { git(repo, 'add', '.osstack/policy.yaml'); git(repo, '-c', 'user.name=test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'newer policy'); }
  let release!: () => void; let available!: () => void;
  const waiting = new Promise<void>(resolve => { available = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.writer.isAvailable = async () => { available(); await barrier; return { available: true, last_checked_at: 0 }; };
  const checked: string[] = [];
  const host = new GraphDelivery({ ...f.registration.delivery, db: f.db, root: join(f.root, 'direct'), request: f.request, acquire: f.options.acquire, authorize: () => f.registration.authorize(),
    authorizePolicy: async ({ policyRoot, workspacePath }: { policyRoot: string; workspacePath: string }) => {
      expect(policyRoot).toBe(repo); checked.push(workspacePath);
      const source = await makeRepositoryPolicyGate(policyRoot, true)({ workspacePath: policyRoot });
      const workspace = await makeRepositoryPolicyGate(workspacePath, false)({ workspacePath });
      if (!source.allow || !workspace.allow) throw Error('POLICY_DENIED');
    } });
  try {
    const pending = host.run();
    await waiting;
    expect(f.db.prepare("SELECT state FROM graph_actions WHERE node_id='e0.workspace'").get()).toEqual({ state: 'confirmed' });
    if (mode === 'revoked') await setPolicy('observe');
    release(); await pending;
    expect(f.writes()).toBe(mode === 'revoked' ? 0 : 1);
    expect(host.current().status).toBe(mode === 'revoked' ? 'failed' : 'ready');
    expect(checked).toContain(join(f.root, 'direct', 'writer-0'));
    expect(f.db.prepare('SELECT count(*) n FROM graph_action_admissions WHERE released_at IS NULL').get()).toEqual({ n: 0 });
  } finally { release(); await f.close(); }
}, 30000);


BROKER lines450-570
        verifyLease: async (input, actualLease) => {
          if (actualLease !== lease) throw new Error("freeze lease identity mismatch");
          check(); await lease.assertActive!(); check();
          const decision: unknown = await execution.authority.verifyLease(input, actualLease);
          if (decision !== undefined) throw new Error("invalid freeze authority");
          check();
        } });
      return { status: "completed", frozenCandidate };
    }
    if (execution.kind === "workspace") {
      await verifyWorkspace();
      await this.options.authorizePolicy?.(action.workspace.workspace_path);
      beforeEffect(`workspace:${randomUUID()}`);
      const result = await execution.handler({ workspace: action.workspace, signal, lease: lease! });
      if (result?.stopped !== true || !["completed", "failed"].includes(result.status)) throw new Error("workspace outcome unconfirmed");
      return { status: result.status, workspace: result.evidence };
    }
    const commandTerminationGraceMs = 1000; const commandKillGraceMs = 1000;
    let threw = false; let command: CommandResult | undefined; let commandPending: Promise<CommandResult> | undefined; let invocationRunId: string | undefined;
    const original = execution.kind === "adapter" ? execution.adapter : undefined;
    const capabilities = execution.kind === "adapter" ? execution.adapter.capabilities().filter(cap => cap.id === execution.capabilityId) : [CapabilitySchema.parse({ id: "registered-command.write", kind: "code.write", agent_id: "registered-command", description: "Registered command" })];
    const policy = this.options.authorizePolicy;
    const cumulativeUsage: Record<string, number> = { tokens_in: 0, tokens_out: 0 };
    const wrapper: AgentAdapter = {
      id: original?.id ?? "registered-command", display_name: "Governed graph action", cost_tier: "low",
      capabilities: () => capabilities, isAvailable: original?.isAvailable ?? (async () => ({ available: true, last_checked_at: 0 })),
      invoke: (task, invocationSignal) => {
        return (async function* () {
          await verifyWorkspace();
          await policy?.(action.workspace.workspace_path);
          if (invocationSignal.aborted) throw new Denied("POLICY_DENIED", "execution cancelled before invocation");
          beforeEffect(task.run_id); invocationRunId = task.run_id;
          try {
            if (original) {
              for await (const event of original.invoke(task, invocationSignal)) {
                const payload: unknown = event.type === "usage.updated" || event.type === "usage.final" ? event.payload
                  : event.type === "done" && event.payload && typeof event.payload === "object" ? (event.payload as { usage?: unknown }).usage : undefined;
                if (payload !== undefined) {
                  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid adapter usage payload");
                  const usage = payload as Record<string, unknown>;
                  let tokens = 0;
                  for (const field of ["tokens_in", "tokens_out"]) {
                    const amount = usage[field];
                    if (amount !== undefined) {
                      if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) throw new Error("invalid adapter token usage");
                      cumulativeUsage[field] = Math.max(cumulativeUsage[field]!, amount);
                    }
                  }
                  // Providers may send input/output counters in separate events.
                  // Retain each cumulative maximum instead of only max(event sum).
                  tokens = cumulativeUsage["tokens_in"]! + cumulativeUsage["tokens_out"]!;
                  if (!Number.isSafeInteger(tokens)) throw new Error("invalid adapter total usage");
                  observeTokens(tokens);
                  const cost = usage["cost_usd"];
                  if (cost !== undefined && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) throw new Error("invalid adapter cost usage");
                }
                yield event;
              }
              return;
            }
            if (execution.kind !== "command") throw new Error("invalid execution registration");
            // runShellCommand starts synchronously before its returned promise; no
            // untrusted await separates the fence above from the actual spawn.
            commandPending = runShellCommand(execution.command, { cwd: action.workspace.workspace_path, timeoutMs: 120_000,
              terminationGraceMs: commandTerminationGraceMs, killGraceMs: commandKillGraceMs,
              outputLimit: 16_000, ...(invocationSignal ? { signal: invocationSignal } : {}) });
            command = await commandPending;
            yield { event_id: randomUUID(), run_id: task.run_id, session_id: task.session_id, seq: 1, type: "done" as const,
              created_at: Date.now() / 1000, terminal: true, payload: { status: command.exitCode === 0 ? "completed" : "failed", last_seq: 0 } };
          } catch (error) { threw = true; throw error; }
        })();
      },
      confirmStopped: async runId => {
        if (original?.confirmStopped) return original.confirmStopped(runId);
        // Command cancellation can request confirmation before termination settles.
        // G04 bounds this wait; only the shell's process-group proof can confirm it.
        const stoppedCommand = command ?? await commandPending;
        return { stopped: stoppedCommand?.termination?.stop_confirmed === true, evidence: stoppedCommand?.termination?.evidence ?? "no trusted stop receipt" };
      },
    };
    const candidate = await executeCandidateImplementation({ plan: { ...execution.plan, agent_id: wrapper.id }, workspace: action.workspace,
      adapters: [wrapper], signal,
      // Command confirmation includes TERM/KILL grace, process-group probes and
      // pipe drainage. The outer adapter must not time out after only 50ms.
      cancellationGraceMs: execution.kind === "command" ? commandTerminationGraceMs + commandKillGraceMs + 500 : 50,
      authorize: async () => { this.authorize(binding); this.fence(binding); await policy?.(action.workspace.workspace_path); this.authorize(binding); this.fence(binding); return { allow: true }; } });
    if (!invocationRunId) throw new Denied("POLICY_DENIED", candidate.reason ?? "candidate preflight refused");
    if (threw || candidate.status === "execution_unconfirmed" || candidate.execution?.failure_code) throw new Error("adapter result or execution unconfirmed");
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([wrapper.confirmStopped!(invocationRunId),
      new Promise<{ stopped: false }>(resolve => { stopTimer = setTimeout(() => resolve({ stopped: false }), 1000); })])
      .finally(() => { if (stopTimer) clearTimeout(stopTimer); });
    if (stopped.stopped !== true || !stopped.evidence?.trim()) throw new Error("external stop unconfirmed");
    const usage = candidate.execution;
    if ([usage?.tokens_in, usage?.tokens_out].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) throw new Error("invalid adapter usage");
    return { status: candidate.status === "implementation_complete" ? "completed" : "failed", stopped: true, candidate, ...(command ? { command } : {}) };
  }
}