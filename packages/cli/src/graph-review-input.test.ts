import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { changesetPolicyDigest } from '@osstack/agents/experimental/changeset';
import { buildGraphReviewInput } from './graph-review-input.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'graph-review-input-'))); roots.push(root);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd: root, encoding: 'utf8', env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git('init', '-q'); writeFileSync(join(root, 'code.ts'), 'old'); writeFileSync(join(root, 'removed.txt'), 'deleted evidence');
  const commit = () => { git('add', '-A'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  const base = commit(); writeFileSync(join(root, 'code.ts'), 'first implementation'); unlinkSync(join(root, 'removed.txt')); const previous = commit();
  writeFileSync(join(root, 'test.ts'), 'repair test'); const candidate = commit();
  const pathPolicy = { exactPaths: ['code.ts', 'removed.txt', 'test.ts'], directoryPrefixes: [], denyPaths: [] as string[], denyPrefixes: [] };
  const input = { pathPolicy, repository: root, runBaseRevision: base, invocationBaseRevision: previous, candidateRevision: candidate, acceptanceRef: 'tests', inputPolicyDigest: changesetPolicyDigest(pathPolicy) };
  return { root, git, commit, input, build: () => buildGraphReviewInput(input, () => undefined) };
}
it('includes cumulative modifications, deleted before bytes and created after bytes across repair epochs', () => {
  const f = fixture(); const result = f.build();
  expect(result.manifest.changes.map(c => [c.path, c.kind])).toEqual([['code.ts', 'modified'], ['removed.txt', 'deleted'], ['test.ts', 'added']]);
  expect(result.manifest.changes[0]).toMatchObject({ before: { content: 'old' }, after: { content: 'first implementation' } });
  expect(result.manifest.changes[1]).toMatchObject({ before: { content: 'deleted evidence' }, after: null });
  expect(result.manifest.incrementalChanges.map(c => c.path)).toEqual(['test.ts']); expect(result.context).toContain('deleted evidence');
  expect(f.build().manifestDigest).toBe(result.manifestDigest);
});
it('reads frozen objects even when working files contain attacker-controlled different bytes', () => {
  const f = fixture(); writeFileSync(join(f.root, 'code.ts'), 'do not show me');
  const index = readFileSync(join(f.root, '.git/index')); expect(f.build().context).not.toContain('do not show me'); expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
});
it('fails context_incomplete rather than truncating an oversized changed file', () => {
  const f = fixture(); writeFileSync(join(f.root, 'test.ts'), 'x'.repeat(16385)); f.input.candidateRevision = f.commit();
  expect(() => f.build()).toThrow('GRAPH_REVIEW_CONTEXT_INCOMPLETE');
});
it('fails on binary changed evidence and on unrelated or reversed ancestry', () => {
  const f = fixture(); writeFileSync(join(f.root, 'test.ts'), Buffer.from([0, 255])); f.input.candidateRevision = f.commit();
  expect(() => f.build()).toThrow('GRAPH_REVIEW_CONTEXT_INCOMPLETE');
  f.input.candidateRevision = f.input.runBaseRevision; expect(() => f.build()).toThrow('GRAPH_REVIEW_LINEAGE');
});
it('refuses asynchronous authority before accessing Git', () => {
  const f = fixture(); expect(() => buildGraphReviewInput(f.input, () => Promise.resolve())).toThrow('GRAPH_REVIEW_AUTHORITY');
});
it('preserves a UTF-8 BOM as evidence content rather than silently dropping it', () => {
  const f = fixture(); writeFileSync(join(f.root, 'test.ts'), '\ufeffBOM'); f.input.candidateRevision = f.commit();
  expect(f.build().manifest.changes.find(c => c.path === 'test.ts')?.after?.content).toBe('\ufeffBOM');
});
it('rejects a canonical subdirectory instead of discovering and reading its parent repository', () => {
  const f = fixture(); const subdirectory = join(f.root, '.git');
  expect(() => buildGraphReviewInput({ ...f.input, repository: subdirectory }, () => undefined)).toThrow('GRAPH_REVIEW_ROOT');
});
it('includes the complete incremental evidence for a repair that restores the original task bytes', () => {
  const f = fixture(); writeFileSync(join(f.root, 'code.ts'), 'old'); f.input.candidateRevision = f.commit();
  const manifest = f.build().manifest;
  expect(manifest.changes.some(c => c.path === 'code.ts')).toBe(false);
  expect(manifest.incrementalChanges)
    .toContainEqual(expect.objectContaining({ path: 'code.ts', before: expect.objectContaining({ content: 'first implementation' }), after: expect.objectContaining({ content: 'old' }) }));
});
it('rejects a policy digest that does not authenticate the disclosure rules', () => {
  const f = fixture(); f.input.inputPolicyDigest = 'b'.repeat(64); expect(() => f.build()).toThrow('GRAPH_REVIEW_POLICY');
});
it('enforces deny rules before returning any content, even with a valid policy digest', () => {
  const f = fixture(); f.input.pathPolicy.denyPaths.push('removed.txt'); f.input.inputPolicyDigest = changesetPolicyDigest(f.input.pathPolicy);
  expect(() => f.build()).toThrow('GRAPH_REVIEW_POLICY');
});
it('includes deletion evidence for a transient file absent from both original and final trees', () => {
  const f = fixture(); f.input.pathPolicy.exactPaths.push('transient.txt'); f.input.inputPolicyDigest = changesetPolicyDigest(f.input.pathPolicy);
  writeFileSync(join(f.root, 'transient.txt'), 'transient evidence'); f.input.invocationBaseRevision = f.commit();
  unlinkSync(join(f.root, 'transient.txt')); f.input.candidateRevision = f.commit();
  const result = f.build(); expect(result.manifest.changes.some(c => c.path === 'transient.txt')).toBe(false);
  expect(result.manifest.incrementalChanges).toContainEqual(expect.objectContaining({ path: 'transient.txt', kind: 'deleted', before: expect.objectContaining({ content: 'transient evidence' }), after: null }));
});
it('accepts the exact file byte bound and empty content but rejects invalid UTF-8', () => {
  const f = fixture(); writeFileSync(join(f.root, 'test.ts'), 'x'.repeat(16384)); f.input.candidateRevision = f.commit(); expect(f.build().manifest.changes.find(c => c.path === 'test.ts')?.after?.bytes).toBe(16384);
  writeFileSync(join(f.root, 'test.ts'), ''); f.input.candidateRevision = f.commit(); expect(f.build().manifest.changes.find(c => c.path === 'test.ts')?.after?.content).toBe('');
  writeFileSync(join(f.root, 'test.ts'), Buffer.from([0xc3, 0x28])); f.input.candidateRevision = f.commit(); expect(() => f.build()).toThrow('GRAPH_REVIEW_CONTEXT_INCOMPLETE');
});
it('returns no manifest if disclosure authority is revoked during Git reads', () => {
  const f = fixture(); let checks = 0;
  expect(() => buildGraphReviewInput(f.input, () => { if (++checks === 14) throw Error('revoked'); })).toThrow(); expect(checks).toBe(14);
});
