import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { GraphActionStore, GraphRunStore, openDb } from '@osstack/core';
import { GraphAdmissionStore } from '@osstack/core/graph-recovery';
import { GraphInvocationEvidenceStore } from '@osstack/core/graph-invocation-evidence';
import { changesetPolicyDigest } from '@osstack/agents/experimental/changeset';
import { GraphChangesetInvocationHost } from '../../packages/cli/src/graph-changeset-invocation.js';
import { GraphChangesetApplyHost } from '../../packages/cli/src/graph-changeset-apply-host.js';
const [root, point, mode] = process.argv.slice(2); if (!root || !point) throw Error('args');
const workspace = join(root, 'workspace');
const db = openDb({ path: join(root, 'state.db') }); db.pragma('synchronous = FULL');
const runs = new GraphRunStore(db); const actions = new GraphActionStore(db);
const store = new GraphInvocationEvidenceStore(join(root, 'evidence'));
const metadataPath = join(root, 'metadata.json');
if (mode === 'resume') {
  const data = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const run = runs.get(data.fence.scope, data.fence.graphRunId)!;
  try {
    const result = new GraphChangesetApplyHost(db, store, { verify: () => undefined }).apply(data.input,
      { ...data.fence, expectedRevision: run.revision, now: Date.now() });
    process.stdout.write(JSON.stringify(result));
  } catch { process.stdout.write('refused'); }
  db.close();
} else {
  fs.mkdirSync(workspace); const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd: workspace, encoding: 'utf8', env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git('init', '-q'); fs.writeFileSync(join(workspace, 'b-delete.txt'), 'delete'); fs.writeFileSync(join(workspace, 'c-replace.txt'), 'old'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
  const scope = { schemaVersion: 1 as const, tenantId: 't', principalId: 'p', workspaceId: 'w' }; const now = Date.now();
  let run = runs.create({ schemaVersion: 1, kind: 'start', scope, idempotencyKey: 'start', inputArtifactRef: 'input', source: { product: 'osstack', requestId: 'r' },
    spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only', input: { taskRef: 't', repositoryRef: 'repo', baseRevision: git('rev-parse', 'HEAD'), acceptanceRef: 'a' },
      limits: { maxEpochs: 2, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 10, deadlineSeconds: 600, tokenReservationLimit: 2000 } } },
    { executionModel: 'langgraph-functional-v1', durability: 'sync', engineVersion: '1', checkpointVersion: '1', templateVersion: '1', registryVersion: '1', compilerVersion: '1', schemaVersion: '1', compiledProgramDigest: 'b'.repeat(64) }, now);
  const fence = () => ({ scope, graphRunId: run.graphRunId, expectedGeneration: run.generation, expectedOwner: run.leaseOwner,
    expectedRevision: runs.get(scope, run.graphRunId)!.revision, identity: run.identity, now: Date.now() });
  run = runs.acquireLease({ ...fence(), owner: 'worker', leaseExpiresAt: now + 600000 });
  const admission = actions.reserve(fence(), { epoch: 0, nodeId: 'implement', effectSlot: 'invoke', reservationTokens: 1100,
    action: { kind: 'implement', inputArtifactRef: 'input', workspaceLeaseRef: 'workspace' } }); run = admission.run;
  const key = admission.action.effectKey; new GraphAdmissionStore(db).hold(key, now);
  const policy = { exactPaths: ['a-create.txt', 'b-delete.txt', 'c-replace.txt'], directoryPrefixes: [], denyPaths: [], denyPrefixes: [] };
  const binding = { runId: run.graphRunId, effectKey: key, generation: run.generation, baseRevision: git('rev-parse', 'HEAD'), treeRevision: git('rev-parse', 'HEAD^{tree}'),
    profileDigest: 'd'.repeat(64), grantDigest: 'e'.repeat(64), programDigest: 'b'.repeat(64), policyDigest: changesetPolicyDigest(policy) };
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const manifest = { schemaVersion: 1, binding, entries: [{ path: 'a-create.txt', state: 'absent' },
    { path: 'b-delete.txt', state: 'present', content: 'delete', sha256: sha('delete'), mode: '100644' },
    { path: 'c-replace.txt', state: 'present', content: 'old', sha256: sha('old'), mode: '100644' }] };
  const proposal = { kind: 'propose', changes: [{ kind: 'create', path: 'a-create.txt', content: 'new' },
    { kind: 'delete', path: 'b-delete.txt', expectedSha256: sha('delete') }, { kind: 'replace', path: 'c-replace.txt', expectedSha256: sha('old'), content: 'replacement' }] };
  const host = new GraphChangesetInvocationHost(db, store, { verify: () => undefined, client: { provider: 'anthropic', model: 'fixture', apiKey: 'fixture',
    fetch: async () => new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: 'fixture', stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(proposal) }], usage: { input_tokens: 10, output_tokens: 10 } })) } });
  const invoked = await host.invoke({ task: 'test', binding, manifest, policy, inputTokenUpperBound: 1000, maxOutputTokens: 100, tokenBoundEvidenceRef: 'fixture' }, fence(), 'execution');
  if (invoked.kind !== 'recorded') throw Error('fixture invocation');
  const input = { workspace, binding, manifest, policy, proposal };
  fs.writeFileSync(metadataPath, JSON.stringify({ input, fence: fence(), key }));
  const kill = () => process.kill(process.pid, 'SIGKILL');
  const begin = GraphActionStore.prototype.beginApply;
  GraphActionStore.prototype.beginApply = function (...args) { if (point === 'before_gate') kill(); const result = begin.apply(this, args); if (point === 'after_gate') kill(); return result; };
  const complete = GraphActionStore.prototype.completeApply;
  GraphActionStore.prototype.completeApply = function (...args) { if (point === 'before_complete') kill(); const result = complete.apply(this, args); if (point === 'after_complete') kill(); return result; };
  let latestMutation: string | null = null;
  const physicalFds = new Set<number>(); const originalOpen = fs.openSync;
  fs.openSync = (...args) => { const fd = originalOpen(...args); if (String(args[0]).startsWith(workspace + '/') && String(args[0]).includes('.osstack-apply-')) physicalFds.add(fd); return fd; };
  const originalClose = fs.closeSync; fs.closeSync = fd => { physicalFds.delete(fd); originalClose(fd); };
  const originalSync = fs.fsyncSync; fs.fsyncSync = fd => {
    const info = fs.fstatSync(fd);
    const window = info.isDirectory() && latestMutation ? `${latestMutation}_dirsync` : info.isFile() && physicalFds.has(fd) ? 'file_sync' : null;
    if (window && point === `before_${window}`) kill(); originalSync(fd); if (window && point === `after_${window}`) kill();
  };
  const rename = fs.renameSync; fs.renameSync = (...args) => {
    const dest = String(args[1]); const op = dest === join(workspace, 'a-create.txt') ? 'create' : dest === join(workspace, 'c-replace.txt') ? 'replace' : null;
    if (op && point === `before_${op}`) kill(); rename(...args); if (op) latestMutation = op; if (op && point === `after_${op}`) kill();
  };
  const unlink = fs.unlinkSync; fs.unlinkSync = (...args) => {
    const target = String(args[0]) === join(workspace, 'b-delete.txt'); if (target && point === 'before_delete') kill(); unlink(...args); if (target) latestMutation = 'delete'; if (target && point === 'after_delete') kill();
  };
  syncBuiltinESMExports();
  new GraphChangesetApplyHost(db, store, { verify: () => undefined }).apply(input, fence());
  throw Error('crash point not reached');
}
