import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { GraphActionStore, createScratchDirSync } from '@osstack/core';
import { GraphAdmissionStore } from '@osstack/core/graph-recovery';
import { canonicalJson } from '@osstack/protocol/source';
import { createContainedCommandExecutor, type ContainedImageReceipt } from '@osstack/agents';
import { verificationCanonical } from '@osstack/graph/nodes/branch';
import { processFixture } from './graph-process-fixture.js';
import { registerContainedTests } from './graph-contained-tests.js';
import { reopenGraphContainedTests } from './graph-contained-recovery.js';

// Graph journals written before the neutral extraction must keep their exact bytes and still reopen.
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const image: ContainedImageReceipt = { version: 1, daemonId: 'daemon', baseImageId: 'sha256:' + 'b'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64),
  contentDigest: 'c'.repeat(64), archiveDigest: 'd'.repeat(64), workingDirectory: '/osstack-candidate-00000000-0000-4000-8000-000000000000' };
async function engine(label: string) {
  const dir = createScratchDirSync('tests', label); const root = realpathSync(dir); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const containers = new Map<string, { config: Record<string, unknown>; removed: boolean }>(); const calls: string[] = [];
  const socketPath = join(dir, 'docker.sock');
  const server = createServer(async (req, res) => {
    const path = req.url!; calls.push(`${req.method} ${path}`);
    if (path.endsWith('/info')) { res.end(JSON.stringify({ ID: image.daemonId, OSType: 'linux' })); return; }
    if (path.endsWith('/create')) { let body = ''; for await (const part of req) body += part;
      const id = sha(String(containers.size)); containers.set(id, { config: JSON.parse(body) as Record<string, unknown>, removed: false }); res.writeHead(201).end(JSON.stringify({ Id: id })); return; }
    const id = /containers\/([a-f0-9]{64})/.exec(path)?.[1]; const container = id ? containers.get(id) : undefined;
    if (!container || container.removed) { res.writeHead(404).end(); return; }
    if (req.method === 'DELETE') { container.removed = true; res.writeHead(204).end(); return; }
    if (path.endsWith('/start')) { res.writeHead(204).end(); return; }
    if (path.includes('/logs?')) { res.end(); return; }
    res.end(JSON.stringify({ Id: id, Image: image.imageId, Config: container.config, HostConfig: { ...(container.config['HostConfig'] as object), CapAdd: null }, Mounts: [], State: { Status: 'exited', Running: false, ExitCode: 0 } }));
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const journalRoot = join(root, 'journal'); mkdirSync(journalRoot);
  return { root, calls, journalRoot, host: { socketPath, daemonId: image.daemonId, baseImageId: image.baseImageId } };
}
const binding = (scope: { schemaVersion: 1; tenantId: string; principalId: string; workspaceId: string }, graphRunId: string, specHash: string) =>
  ({ scope, graphRunId, specHash, epoch: 0, candidateRevision: 'a'.repeat(40), artifactDigest: 'f'.repeat(64), acceptanceRef: 'accept' });
/** The identity bytes main wrote before this change, spelled out rather than derived from current code. */
const legacyIdentity = (o: { scope: { schemaVersion: 1; tenantId: string; principalId: string; workspaceId: string }; graphRunId: string; generation: number; effectKey: string; invocationId: string; command: string }) =>
  `{"artifactDigest":"${'f'.repeat(64)}","candidateRevision":"${'a'.repeat(40)}","command":${JSON.stringify(o.command)},"effectKey":${JSON.stringify(o.effectKey)},"generation":${o.generation},`
  + `"graphRunId":${JSON.stringify(o.graphRunId)},"image":{"archiveDigest":"${image.archiveDigest}","baseImageId":"${image.baseImageId}","contentDigest":"${image.contentDigest}","daemonId":"${image.daemonId}",`
  + `"imageId":"${image.imageId}","version":1,"workingDirectory":"${image.workingDirectory}"},"invocationId":${JSON.stringify(o.invocationId)},`
  + `"scope":{"principalId":${JSON.stringify(o.scope.principalId)},"schemaVersion":1,"tenantId":${JSON.stringify(o.scope.tenantId)},"workspaceId":${JSON.stringify(o.scope.workspaceId)}},"version":1}`;

it('writes the pre-extraction Graph journal identity byte-for-byte', async () => {
  const e = await engine('graph-compat-write'); const scope = { schemaVersion: 1 as const, tenantId: 't', principalId: 'p', workspaceId: 'w' };
  const invocation = { scope, graphRunId: 'run-1', generation: 3, effectKey: 'effect-1', invocationId: 'inv-1' };
  const { registration, verify } = registerContainedTests({ ...e.host, journalRoot: e.journalRoot, authorizeRead: () => {}, authorizeStop: () => {} }, image, binding(scope, 'run-1', 'a'.repeat(64)), 'exit 0');
  const evidence = await registration.execute(invocation, new AbortController().signal, () => {});
  const expected = legacyIdentity({ ...invocation, command: 'exit 0' });
  const journal = JSON.parse(readFileSync(join(e.journalRoot, sha('inv-1'), 'binding.json'), 'utf8')) as { version: number; bindingRef: string; data: string };
  expect(journal).toEqual({ version: 1, bindingRef: sha(expected), data: expected });
  expect(verificationCanonical(evidence.identity)).toBe(expected); expect(canonicalJson(evidence.identity)).toBe(expected);
  expect(() => verify(evidence)).not.toThrow();
  const forged = structuredClone(evidence); forged.result.exitCode = 1; expect(() => verify(forged)).toThrow('CONTAINED_ACTUAL_INVOCATION_REQUIRED');
  await expect(registration.execute({ ...invocation, invocationId: 'inv-2', scope: { ...scope, tenantId: 'other' } }, new AbortController().signal, () => {})).rejects.toThrow('CONTAINED_INVOCATION_BINDING');
  await expect(registration.execute({ ...invocation, invocationId: 'inv-3', graphRunId: 'run-2' }, new AbortController().signal, () => {})).rejects.toThrow('CONTAINED_INVOCATION_BINDING');
});

it('reopens a Graph journal written in the pre-extraction shape', async () => {
  const e = await engine('graph-compat-reopen'); const f = processFixture(e.root); let run = f.run;
  cleanup.push(async () => { await f.runtime.close(); await f.runtime.drainDatabaseUsers(); if (f.db.open) f.db.close(); });
  const fence = () => ({ scope: run.scope, graphRunId: run.graphRunId, identity: run.identity, expectedGeneration: run.generation, expectedOwner: run.leaseOwner, expectedRevision: run.revision, now: Date.now() });
  const actions = new GraphActionStore(f.db);
  const reserved = actions.reserve(fence(), { epoch: 0, nodeId: 'tests', effectSlot: 'invoke', reservationTokens: 10,
    action: { kind: 'tests', candidateRevision: 'a'.repeat(40), commandSpecRef: 'accept', workspaceLeaseRef: 'lease' } });
  run = reserved.run; const effectKey = reserved.action.effectKey; const invocationId = 'legacy-invocation'; const command = 'exit 0';
  new GraphAdmissionStore(f.db).hold(effectKey, Date.now());
  run = actions.markRunning(fence(), effectKey, `graph-execution:${effectKey}:${invocationId}`).run;
  const data = legacyIdentity({ scope: run.scope as never, graphRunId: run.graphRunId, generation: run.generation, effectKey, invocationId, command });
  // Exactly the executor options the pre-extraction registerContainedTests passed.
  const legacy = await createContainedCommandExecutor({ ...e.host, journalRoot: e.journalRoot, imageId: image.imageId, workingDirectory: image.workingDirectory, command, bindingRef: sha(data), bindingData: data, authorize: () => {} });
  const result = await legacy.execute(invocationId, new AbortController().signal);
  run = actions.markUncertain(fence(), effectKey, { state: 'unknown', evidenceRef: 'host-lost', observedTokens: 3 }).run;
  const options = { ...e.host, journalRoot: e.journalRoot, authorizeRead: () => {}, authorizeStop: () => {} };
  const opened = await reopenGraphContainedTests(f.db, options, { fence: fence(), effectKey, binding: binding(run.scope as never, run.graphRunId, run.identity.specHash), command, contentDigest: image.contentDigest });
  expect(verificationCanonical(opened.identity)).toBe(data); expect(Object.keys(opened).sort()).toEqual(['captureQuiescence', 'confirmStopped', 'identity', 'stop']);
  expect(await opened.confirmStopped()).toEqual({ stopped: true, evidence: result.evidence });
  const proof = await opened.captureQuiescence(); expect(proof.effectKey).toBe(effectKey); expect(Object.isFrozen(proof)).toBe(true);
  expect(proof.executorEvidenceRef).toBe(result.evidence); expect(proof.recheck).toThrow('TRANSACTION_REQUIRED');
  expect(e.calls.filter(c => c.includes('/create'))).toHaveLength(1);
});
