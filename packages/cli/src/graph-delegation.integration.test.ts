import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { expect, it, vi } from 'vitest';
import { GraphActionBroker } from './graph-action-broker.js';
import type { AgentAdapter } from '@osstack/agents';
import { CapabilitySchema } from '@osstack/core';
import { GraphDelegationStatus, type StartGraphRequest } from '@osstack/protocol';
import { FrameDecoder, encodeFrame } from '@osstack/hermes-adapter';
import { startDaemon } from './daemon.js';
import type { GraphHostRegistration } from './graph-rpc.js';
import { handleGraphCommand } from './graph-command.js';
import { healthyAutonomyHealth } from './test-healthy-autonomy.js';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
type Reply = { ok: boolean; result?: unknown; error?: { code: string; message: string } };
async function fixture(external = false, bounded = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-delegation-'))); const repo = join(root, 'repo'); const home = join(root, 'home');
  await mkdir(repo); await mkdir(home); await mkdir(join(repo, '.osstack'));
  await writeFile(join(repo, '.osstack', 'policy.yaml'), 'schema_version: 1\nmode: execute\n');
  await writeFile(join(repo, 'answer'), '0\n'); git(repo, 'init', '-q'); git(repo, 'add', '.'); git(repo, '-c', 'user.name=Graph', '-c', 'user.email=graph@invalid', 'commit', '-qm', 'base');
  const scope = { schemaVersion: 1 as const, tenantId: 'local', principalId: 'host', workspaceId: 'registered' };
  let calls = 0; const stopped = new Set<string>();
  const writer: AgentAdapter = { id: 'writer', display_name: 'writer', cost_tier: 'low',
    capabilities: () => [CapabilitySchema.parse({ id: 'write', agent_id: 'writer', kind: 'code.write', description: 'write' })],
    isAvailable: async () => ({ available: true, last_checked_at: 0 }),
    invoke: async function* (task) {
      calls++; await writeFile(join(String(task.context?.['repo_path']), 'answer'), '1\n'); stopped.add(task.run_id);
      yield { event_id: task.run_id, run_id: task.run_id, session_id: task.session_id, seq: 1, created_at: Date.now() / 1000, type: 'done', terminal: true, payload: { status: 'completed', last_seq: 1, result_summary: 'written', usage: { tokens_in: 1, tokens_out: 1, duration_ms: 1 } } };
    }, confirmStopped: async id => ({ stopped: stopped.has(id), evidence: `closed:${id}` }) };
  const reviewer: AgentAdapter = { ...writer, id: 'reviewer', capabilities: () => [CapabilitySchema.parse({ id: 'review', agent_id: 'reviewer', kind: 'code.review', description: 'review' })],
    invoke: async function* (task) {
      const good = (await readFile(join(String(task.context?.['repo_path']), 'answer'), 'utf8')).trim() === '1'; stopped.add(task.run_id);
      yield { event_id: task.run_id, run_id: task.run_id, session_id: task.session_id, seq: 1, created_at: Date.now() / 1000, type: 'done', terminal: true,
        payload: { status: 'completed', last_seq: 1, result_summary: JSON.stringify({ schemaVersion: 1, verdict: good ? 'accept' : 'changes_requested', summary: 'inspected frozen candidate', findings: [] }), usage: { tokens_in: 1, tokens_out: 1, duration_ms: 1 } } };
    } };
  const acceptanceRegistry = [{ ref: 'tests', command: 'test "$(cat answer)" = 1', passExitCodes: [0], failExitCodes: [1] }];
  const registration: GraphHostRegistration = { id: 'local', scope, product: 'osstack', repositoryRef: 'repo', taskRef: 'task', inputArtifactRef: 'input', authorize: () => {},
    delivery: { repositoryPath: repo, task: 'Set answer to 1', writer: { identity: 'writer', adapter: writer, capabilityId: 'write' }, reviewer: { identity: 'reviewer', adapter: reviewer, capabilityId: 'review' },
      verifyReviewer: async () => {}, acceptanceRegistry } };
  await writeFile(join(home, 'graph-host.json'), JSON.stringify({ schemaVersion: 1, registration: { id: 'local', scope, repositoryRef: 'repo', repositoryPath: repo, taskRef: 'task', task: 'Set answer to 1', inputArtifactRef: 'input',
    writer: bounded ? { agentId: 'anthropic-bounded-writer', capabilityId: 'anthropic-bounded-writer.writer' } : { agentId: 'writer', capabilityId: 'write' },
    reviewer: bounded ? { agentId: 'anthropic-bounded-reviewer', capabilityId: 'anthropic-bounded-reviewer.reviewer' } : { agentId: 'reviewer', capabilityId: 'review' }, acceptanceRegistry,
    ...(bounded ? { boundedMessages: { model: 'fixture-model', files: ['answer'], acceptance: 'The answer file must contain 1 followed by a newline.' } } : {}),
    grant: { scope, expiresAt: Date.now() + 60000, operations: ['read', 'execute', 'cancel', 'resume'] } } }), { mode: 0o600 });
  let caller: string | null = 'bot';
  const previousHome = process.env['OSSTACK_HOME']; process.env['OSSTACK_HOME'] = home;
  const daemon = await startDaemon({ socketPath: `/tmp/gd-${randomUUID()}.sock`, adapters: [writer, reviewer], autonomyHealth: async () => healthyAutonomyHealth(),
    ...(external ? { graphRpc: { registrations: [{ ...registration, id: 'bot', product: 'osbot' }, { ...registration, id: 'tag', product: 'ostag' }], resolveCaller: () => caller } } : {}) });
  const rpc = async (method: string, params: unknown): Promise<Reply> => new Promise((resolve, reject) => {
    const socket = connect(daemon.socketPath); const decoder = new FrameDecoder();
    const timer = setTimeout(() => { socket.destroy(); reject(Error('RPC_TIMEOUT')); }, 10000);
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('connect', () => socket.write(encodeFrame({ id: 1, method, params })));
    socket.on('data', data => { const replies = decoder.push(data); if (replies.length) { clearTimeout(timer); socket.destroy(); resolve(replies[0] as Reply); } });
  });
  const request: StartGraphRequest = { schemaVersion: 1, kind: 'start', scope, idempotencyKey: 'one', inputArtifactRef: 'input', source: { product: external ? 'osbot' : 'osstack', requestId: 'business', parentRunId: 'parent' },
    spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only', input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: git(repo, 'rev-parse', 'HEAD'), acceptanceRef: 'tests' },
      limits: { maxEpochs: 1, maxBranchAttempts: 1, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 7, deadlineSeconds: 60, tokenReservationLimit: 49152 } } };
  const status = async (id: string) => { const response = await rpc('graph.status', { schemaVersion: 1, scope, graphRunId: id }); expect(response.ok, JSON.stringify(response)).toBe(true); return GraphDelegationStatus.parse(response.result); };
  const ready = async (id: string) => { let value = await status(id); const until = Date.now() + 20000;
    while (value.status !== 'ready' && Date.now() < until) { if (['failed', 'reconciliation_required'].includes(value.status)) throw Error(JSON.stringify(value)); await new Promise(resolve => setTimeout(resolve, 25)); value = await status(id); }
    expect(value.status).toBe('ready'); return value;
  };
  return { root, home, repo, rpc, request, ready, setCaller: (id: string | null) => { caller = id; }, calls: () => calls,
    close: async () => { await daemon.close(); if (previousHome === undefined) delete process.env['OSSTACK_HOME']; else process.env['OSSTACK_HOME'] = previousHome; await rm(root, { recursive: true, force: true }); } };
}
it('real daemon loads owner config and CLI run/status retain durable idempotency and stable conflict codes', async () => {
  const f = await fixture();
  try {
    const file = join(f.root, 'start.json'); await writeFile(file, JSON.stringify(f.request));
    let output = ''; const deps = { rpc: f.rpc, stdout: (value: string) => { output = value; }, stderr: (value: string) => { throw Error(value); } };
    expect(await handleGraphCommand(['run', '--request', file, '--json'], deps)).toBe(0);
    const initial = GraphDelegationStatus.parse(JSON.parse(output));
    const ready = await f.ready(initial.graphRunId);
    expect(await handleGraphCommand(['run', '--request', file, '--json'], deps)).toBe(0);
    expect(GraphDelegationStatus.parse(JSON.parse(output))).toEqual(ready); expect(f.calls()).toBe(1);
    const changed = { ...f.request, spec: { ...f.request.spec, limits: { ...f.request.spec.limits, deadlineSeconds: 59 } } };
    expect(await f.rpc('graph.start', changed)).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(await readFile(join(f.repo, 'answer'), 'utf8')).toBe('0\n');
  } finally { await f.close(); }
}, 30000);
it('simulated OSBot/OStag host bindings preserve parents, isolate source results and refuse unverified callers', async () => {
  const f = await fixture(true);
  try {
    const first = await f.rpc('graph.submit', f.request); expect(first.ok).toBe(true); const bot = GraphDelegationStatus.parse(first.result);
    await f.ready(bot.graphRunId);
    expect(await f.rpc('graph.submit', f.request)).toMatchObject({ ok: true, result: { graphRunId: bot.graphRunId } });
    f.setCaller('tag');
    expect(await f.rpc('graph.status', { schemaVersion: 1, scope: f.request.scope, graphRunId: bot.graphRunId })).toMatchObject({ ok: false, error: { code: 'RUN_MISMATCH' } });
    expect(await f.rpc('graph.start', f.request)).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    const tagRequest = { ...f.request, idempotencyKey: 'tag-one', source: { product: 'ostag', requestId: 'tag-request', parentRunId: bot.graphRunId } };
    const tag = GraphDelegationStatus.parse((await f.rpc('graph.submit', tagRequest)).result);
    const completed = await f.ready(tag.graphRunId); expect(completed.source.parentRunId).toBe(bot.graphRunId); expect(f.calls()).toBe(2);
    expect(completed.resultRef).toBeDefined(); f.setCaller(null);
    expect(await f.rpc('graph.result', { schemaVersion: 1, scope: f.request.scope, graphRunId: tag.graphRunId })).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    expect(await f.rpc('graph.reconcile', { schemaVersion: 1, kind: 'cancel', scope: f.request.scope, graphRunId: tag.graphRunId, expectedRevision: completed.revision, idempotencyKey: 'unauth' })).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
  } finally { await f.close(); }
}, 45000);

it('actual daemon and CLI reconcile a registered no-child failure while new admission is disabled', async () => {
  const f = await fixture();
  const failure = vi.spyOn(GraphActionBroker.prototype, 'register').mockImplementation(() => { throw Error('injected registration failure'); });
  try {
    const started = GraphDelegationStatus.parse((await f.rpc('graph.start', f.request)).result);
    const params = { schemaVersion: 1, scope: f.request.scope, graphRunId: started.graphRunId };
    await expect.poll(async () => GraphDelegationStatus.parse((await f.rpc('graph.status', params)).result).status, { timeout: 10000 }).toBe('reconciliation_required');
    failure.mockRestore();
    const configPath = join(f.home, 'graph-host.json'); const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.admissionEnabled = false; await writeFile(configPath, JSON.stringify(config));
    const before = GraphDelegationStatus.parse((await f.rpc('graph.status', params)).result);
    const request = { ...params, kind: 'cancel', expectedRevision: before.revision, idempotencyKey: 'settle' };
    const file = join(f.root, 'cancel.json'); await writeFile(file, JSON.stringify(request));
    let output = ''; const deps = { rpc: f.rpc, stdout: (value: string) => { output = value; } };
    expect(await handleGraphCommand(['reconcile', '--request', file, '--json'], deps)).toBe(0);
    expect(GraphDelegationStatus.parse(JSON.parse(output)).status).toBe('cancelled');
    expect(await f.rpc('graph.reconcile', request)).toMatchObject({ ok: true, result: { status: 'cancelled' } });
    expect(f.calls()).toBe(0);
  } finally { failure.mockRestore(); await f.close(); }
}, 30000);

it('actual daemon lazily enrolls bounded owner config and CLI reaches ready with fixture provider responses', async () => {
  const snapshots: string[] = [];
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-only');
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)); const file = JSON.parse(request.messages[0].content).files[0];
    snapshots.push(file.content);
    const output = snapshots.length === 1 ? { edit: { path: 'answer', beforeSha256: file.sha256, content: '1\n' } }
      : { schemaVersion: 1, verdict: 'accept', summary: 'Checked supplied candidate', findings: [] };
    return new Response(JSON.stringify({ id: `msg-${snapshots.length}`, type: 'message', role: 'assistant', model: request.model, stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(output) }], usage: { input_tokens: 10, output_tokens: 10 } }));
  });
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture(false, true);
    const path = join(f.root, 'start.json'); await writeFile(path, JSON.stringify(f.request));
    let output = '';
    expect(await handleGraphCommand(['run', '--request', path, '--json'], { rpc: f.rpc, stdout: text => { output = text; } })).toBe(0);
    const run = GraphDelegationStatus.parse(JSON.parse(output)); await f.ready(run.graphRunId);
    expect(snapshots).toEqual(['0\n', '1\n']); expect(f.calls()).toBe(0);
    expect(await readFile(join(f.repo, 'answer'), 'utf8')).toBe('0\n');
  } finally { await f?.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
}, 30000);
