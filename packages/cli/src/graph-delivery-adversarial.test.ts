import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentAdapter } from '@osstack/agents';
import { CapabilitySchema, openDb } from '@osstack/core';
import { FifoSemaphore } from '@osstack/autonomy';
import { GraphDelivery, type GraphDeliveryOptions } from './graph-delivery.js';
import { GovernedExecution } from './governed-execution.js';
import { GraphRuntime } from './graph-runtime.js';

async function fixture(mode: 'unknown-review' | 'unknown-writer' | 'overrun' | 'mutation' | 'foreign-owner' | 'revoked' | 'retry-preparation-denied' | 'setup' | 'renewal') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'g21-adversarial-'))); const repo = join(root, 'source'); await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q'); await writeFile(join(repo, 'answer'), '0\n'); git('add', '.');
  git('-c', 'user.name=G21', '-c', 'user.email=g21@invalid', 'commit', '-qm', 'base');
  const db = openDb({ path: join(root, 'control.sqlite') });
  const calls = { writer: 0, reviewer: 0, injected: 0 }; let allowed = true; let renewedWhileWriting = false;
  const stopped = new Set<string>();
  const adapter = (kind: 'writer' | 'reviewer'): AgentAdapter => ({ id: kind, display_name: kind, cost_tier: 'low',
    capabilities: () => [CapabilitySchema.parse({ id: kind, agent_id: kind, kind: kind === 'writer' ? 'code.write' : 'review.code', description: kind })],
    isAvailable: async () => ({ available: true, last_checked_at: 0 }),
    invoke: async function* (task) {
      calls[kind]++;
      if (kind === 'writer') await writeFile(join(String(task.context?.['repo_path']), 'answer'), '1\n');
      if (kind === 'writer' && mode === 'renewal') {
        // Compress the remaining lease window, not the original run deadline.
        // The real worker heartbeat must renew while its G04 invocation is pending.
        const expiry = Date.now() + 2200;
        db.prepare('UPDATE graph_runs SET lease_expires_at=?,revision=revision+1').run(expiry);
        await new Promise(resolve => setTimeout(resolve, 3000));
        renewedWhileWriting = (db.prepare('SELECT lease_expires_at FROM graph_runs').get() as { lease_expires_at: number }).lease_expires_at > expiry;
      }
      // Fault injection: replace authority while the actual G04 invocation is live.
      // The ordinary repair test separately proves the real G15 takeover path.
      if (kind === 'reviewer' && mode === 'foreign-owner') db.prepare("UPDATE graph_runs SET generation=generation+1, revision=revision+1, lease_owner='foreign-host'").run();
      if (kind === 'reviewer' && mode === 'revoked') allowed = false;
      stopped.add(task.run_id);
      yield { event_id: task.run_id, run_id: task.run_id, session_id: task.session_id, seq: 1, created_at: Date.now() / 1000, type: 'done', terminal: true,
        payload: { status: 'completed', last_seq: 0, result_summary: kind === 'writer' ? 'implemented' : mode === 'retry-preparation-denied' ? 'malformed' : JSON.stringify({ schemaVersion: 1, verdict: 'accept', summary: 'checked', findings: [] }),
          usage: { tokens_in: mode === 'overrun' && kind === 'writer' ? 300000 : 1, tokens_out: 1, duration_ms: 1 } } };
    }, confirmStopped: async id => ({ stopped: stopped.has(id) && !(mode === 'unknown-review' && kind === 'reviewer') && !(mode === 'unknown-writer' && kind === 'writer'), evidence: `fixture:${id}` }) });
  const admission = new GovernedExecution({ reads: new FifoSemaphore(2), writes: new FifoSemaphore(2), repositories: new Map(), checkHealth: async () => {} });
  const options: GraphDeliveryOptions = { db, root: join(root, 'delivery'), repositoryPath: repo, task: 'set answer to 1',
    writer: { identity: 'writer', adapter: adapter('writer'), capabilityId: 'writer' }, reviewer: { identity: 'reviewer', adapter: adapter('reviewer'), capabilityId: 'reviewer' },
    verifyReviewer: async pair => { if (pair.writerIdentity === pair.reviewerIdentity) throw Error('same identity'); },
    acceptanceRegistry: [{ ref: 'acceptance', command: 'test "$(cat answer)" = 1', passExitCodes: [0], failExitCodes: [1] }],
    acquire: input => {
      if (mode === 'retry-preparation-denied') {
        const key = input.runId.replace('graph-action:', '');
        const action = db.prepare('SELECT node_id,effect_slot FROM graph_actions WHERE effect_key=?').get(key) as { node_id: string; effect_slot: string } | undefined;
        if (action?.node_id === 'e0.prepare_review' && action.effect_slot === 'retry-2') throw Error('fixture preparation admission denied');
      }
      return admission.acquire(input);
    }, authorize: () => { if (!allowed) throw Error('authority revoked'); },
    request: { schemaVersion: 1, kind: 'start', scope: { schemaVersion: 1, tenantId: 't', principalId: 'p', workspaceId: 'w' }, idempotencyKey: 'adversarial', inputArtifactRef: 'input',
      source: { product: 'osstack', requestId: 'adversarial' }, spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only',
        input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: git('rev-parse', 'HEAD'), acceptanceRef: 'acceptance' },
        limits: { maxEpochs: 1, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 11, tokenReservationLimit: 200000, deadlineSeconds: 120 } } } };
  const host = new GraphDelivery(options);
  if (mode === 'mutation') {
    options.authorize = () => { throw Error('replaced callback'); };
    options.request.inputArtifactRef = 'replaced';
    options.writer.adapter.invoke = () => { calls.injected++; throw Error('injected'); };
    options.acceptanceRegistry[0]!.command = 'exit 7';
  }
  try {
    let result: Awaited<ReturnType<GraphDelivery['run']>> | undefined; let error: unknown;
    try { result = await host.run(); } catch (caught) { error = caught; }
    return { result, error, calls, renewedWhileWriting, run: host.current(), root,
      actions: db.prepare('SELECT node_id,state FROM graph_actions ORDER BY created_at,rowid').all() as Array<{ node_id: string; state: string }>,
      held: (db.prepare('SELECT count(*) AS n FROM graph_action_admissions WHERE released_at IS NULL').get() as { n: number }).n,
      joins: (db.prepare('SELECT count(*) AS n FROM graph_verification_joins').get() as { n: number }).n };
  } finally { db.close(); }
}

it.each(['unknown-review', 'unknown-writer'] as const)('retains %s uncertainty without retry, repair or ready publication', async mode => {
  const f = await fixture(mode);
  expect(f.run.status).toBe('reconciliation_required'); expect(f.joins).toBe(0); expect(f.held).toBeGreaterThan(0);
  expect(f.calls.writer).toBe(1); expect(f.calls.reviewer).toBe(mode === 'unknown-review' ? 1 : 0);
  expect(f.actions.some(a => ['unknown', 'running', 'cancel_pending'].includes(a.state))).toBe(true);
  expect(f.result?.route.kind).not.toBe('ready');
}, 30_000);

it('stops before freeze after actual token overrun and preserves charged action evidence', async () => {
  const f = await fixture('overrun'); expect(f.run.status).toBe('failed'); expect(f.calls).toEqual({ writer: 1, reviewer: 0, injected: 0 });
  expect(f.actions).toEqual([{ node_id: 'e0.workspace', state: 'confirmed' }, { node_id: 'e0.implement', state: 'confirmed' }]);
  expect(f.held).toBe(0); expect(f.joins).toBe(0); expect(f.result?.route.kind).not.toBe('ready');
}, 30_000);

it('captures business inputs, executors, commands and authority before asynchronous execution', async () => {
  const f = await fixture('mutation'); expect(f.error).toBeUndefined(); expect(f.result?.route.kind).toBe('ready');
  expect(f.run.inputArtifactRef).toBe('input'); expect(f.calls).toEqual({ writer: 1, reviewer: 1, injected: 0 });
}, 30_000);

it.each(['foreign-owner', 'revoked'] as const)('cannot project state after %s invalidates its authority', async mode => {
  const f = await fixture(mode); expect(f.result?.route.kind).not.toBe('ready'); expect(f.joins).toBe(0);
  expect(f.run.status).toBe('running');
  if (mode === 'foreign-owner') { expect(f.run.leaseOwner).toBe('foreign-host'); expect(f.run.generation).toBe(2); }
  expect(f.calls.writer).toBe(1); expect(f.calls.reviewer).toBe(1);
}, 30_000);

it('returns an explicit stop when preparation admission prevents an otherwise retryable branch', async () => {
  const f = await fixture('retry-preparation-denied');
  expect(f.result?.route).toMatchObject({ kind: 'stop', reason: 'retry_dispatch_incomplete' });
  expect(f.run.status).toBe('failed'); expect(f.joins).toBe(0); expect(f.held).toBe(0); expect(f.calls.reviewer).toBe(1);
  expect(f.actions.some(a => a.node_id === 'e0.tests' && a.state === 'confirmed')).toBe(true);
  expect(f.actions.filter(a => a.node_id === 'e0.prepare_review').map(a => a.state)).toEqual(['confirmed', 'failed']);
}, 30_000);

it('closes its runtime without projecting an unowned run when setup acquisition fails', async () => {
  const claim = vi.spyOn(GraphRuntime.prototype, 'claim').mockImplementation(() => { throw Error('fixture claim denied'); });
  const close = vi.spyOn(GraphRuntime.prototype, 'close');
  try {
    const f = await fixture('setup'); expect(String(f.error)).toContain('fixture claim denied');
    expect(f.run.generation).toBe(0); expect(f.run.leaseOwner).toBeNull(); expect(f.actions).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
  } finally { claim.mockRestore(); close.mockRestore(); }
});

it('renews the owned lease during an actual pending writer invocation and still completes', async () => {
  const f = await fixture('renewal'); expect(f.renewedWhileWriting).toBe(true); expect(f.result?.route.kind).toBe('ready');
  expect(f.run.generation).toBe(1); expect(f.run.spec!.limits.deadlineSeconds).toBe(120);
}, 30_000);
