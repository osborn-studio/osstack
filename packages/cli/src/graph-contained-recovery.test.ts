import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { GraphActionStore, GraphRunStore, openDb } from '@osstack/core';
import { GraphAdmissionStore } from '@osstack/core/graph-recovery';
import { createContainedCommandExecutor, prepareContainedImage, type ContainedImageReceipt } from '@osstack/agents';
import { verificationCanonical } from '@osstack/graph/nodes/branch';
import { processFixture } from './graph-process-fixture.js';
import { reopenGraphContainedTests, type ReopenContainedTests } from './graph-contained-recovery.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'g25-reopen-')); const f = processFixture(root); let db = f.db; let run = f.run;
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
  let removed = false; let config: Record<string, unknown>; let lostDelete = false; let running = false;
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
      if (path.endsWith('/create')) { let body = ''; for await (const part of req) body += part; config = JSON.parse(body) as typeof config; res.writeHead(201).end(JSON.stringify({ Id: 'e'.repeat(64) })); return; }
      if (req.method === 'DELETE') { removed = true; res.writeHead(lostDelete ? 500 : 204).end(); return; }
      if (removed) { res.writeHead(404).end(); return; }
      if (path.endsWith('/start')) { res.writeHead(204).end(); return; }
      if (path.includes('/logs?')) { res.end(); return; }
      res.end(JSON.stringify({ Id: 'e'.repeat(64), Image: image.imageId, Config: config!, HostConfig: { ...(config!['HostConfig'] as object), CapAdd: null }, Mounts: [], State: { Status: running ? 'running' : 'exited', Running: running, ExitCode: 0 } }));
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
  return { root, options, identity, calls, request, executor, invocationId, path: (name: string) => join(journalRoot, sha(invocationId), name),
    execute: () => executor.execute(invocationId, new AbortController().signal),
    reopen: (input = request()) => reopenGraphContainedTests(db, options, input),
    child: async (operation: 'stop' | 'confirmStopped') => {
      const helper = process.env['G25_REOPEN_CHILD']; if (!helper) return;
      const inputPath = join(root, 'child-input.json'); writeFileSync(inputPath, JSON.stringify({ dbPath: join(root, 'state.db'), options, request: request(), operation }));
      const child = spawn(process.execPath, [helper, inputPath], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      expect(code, stderr).toBe(0); expect(JSON.parse(stdout)).toMatchObject({ stopped: true, held: true, state: 'unknown' });
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
  expect(opened.identity).toEqual(f.identity); expect(Object.keys(opened).sort()).toEqual(['confirmStopped', 'identity', 'stop']);
  await f.child('confirmStopped');
  expect(await opened.confirmStopped()).toEqual({ stopped: true, evidence: actual.evidence });
  expect(await opened.stop()).toEqual({ stopped: true, evidence: actual.evidence });
  expect(f.action()).toMatchObject({ state: 'unknown', outcome: null, observedTokens: 3 }); expect(f.held()).toBeNull();
  if (!process.env['G25_CONTAINED_CONFIG']) expect(f.calls.filter(c => c.includes('/create'))).toHaveLength(1);
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
