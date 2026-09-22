import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { changesetPolicyDigest } from '@osstack/agents/experimental/changeset';
import { applyGraphChangeset, type GraphApplyPort } from './graph-apply-changeset.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'graph-applier-'))); roots.push(root);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: root, encoding: 'utf8', env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git('init', '-q'); mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/a.ts'), 'old'); writeFileSync(join(root, 'remove.txt'), 'gone'); writeFileSync(join(root, 'keep.txt'), 'keep');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
  const policy = { exactPaths: ['src/a.ts', 'remove.txt', 'docs/new.md'], directoryPrefixes: [], denyPaths: [], denyPrefixes: [] };
  const binding = { runId: 'run', effectKey: 'e'.repeat(64), generation: 1, baseRevision: git('rev-parse', 'HEAD'), treeRevision: git('rev-parse', 'HEAD^{tree}'), profileDigest: 'a'.repeat(64), grantDigest: 'b'.repeat(64), programDigest: 'c'.repeat(64), policyDigest: changesetPolicyDigest(policy) };
  const manifest = { schemaVersion: 1, binding, entries: [{ path: 'src/a.ts', state: 'present', content: 'old', sha256: sha('old'), mode: '100644' }, { path: 'remove.txt', state: 'present', content: 'gone', sha256: sha('gone'), mode: '100644' }, { path: 'docs/new.md', state: 'absent' }] };
  const proposal = { kind: 'propose', changes: [{ kind: 'replace', path: 'src/a.ts', expectedSha256: sha('old'), content: 'new' }, { kind: 'delete', path: 'remove.txt', expectedSha256: sha('gone') }, { kind: 'create', path: 'docs/new.md', content: 'hello' }] };
  const journal = vi.fn(() => 'journal'); const complete = vi.fn(() => undefined); const quarantine = vi.fn<GraphApplyPort['quarantine']>(() => undefined);
  const port: GraphApplyPort = { authorize: () => undefined, journal, begin: () => true, complete, quarantine };
  return { root, git, binding, manifest, policy, proposal, port, journal, complete, quarantine,
    apply: () => applyGraphChangeset({ workspace: root, binding, manifest, policy, proposal }, port) };
}
it('applies create/replace/delete and proves the same full tree as Git, without staging', () => {
  const f = fixture(); const index = readFileSync(join(f.root, '.git/index')); const result = f.apply();
  expect(result.kind).toBe('applied'); expect(readFileSync(join(f.root, 'src/a.ts'), 'utf8')).toBe('new');
  expect(readFileSync(join(f.root, 'docs/new.md'), 'utf8')).toBe('hello'); expect(existsSync(join(f.root, 'remove.txt'))).toBe(false);
  expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
  f.git('add', '-A'); expect(result.treeRevision).toBe(f.git('write-tree')); expect(f.complete).toHaveBeenCalledOnce();
});
it('does not write when the durable one-shot gate refuses a replay', () => {
  const f = fixture(); f.port.begin = () => false; expect(f.apply().kind).toBe('not_authorized');
  expect(readFileSync(join(f.root, 'src/a.ts'), 'utf8')).toBe('old'); expect(existsSync(join(f.root, 'docs'))).toBe(false); expect(f.complete).not.toHaveBeenCalled();
});
it.each(['untracked', 'modified', 'mode', 'hardlink', 'symlink', 'alias'])('rejects %s before durable apply admission', kind => {
  const f = fixture();
  if (kind === 'untracked') writeFileSync(join(f.root, 'extra'), 'x');
  if (kind === 'modified') writeFileSync(join(f.root, 'keep.txt'), 'changed');
  if (kind === 'mode') chmodSync(join(f.root, 'keep.txt'), 0o755);
  if (kind === 'hardlink') linkSync(join(f.root, 'keep.txt'), join(f.root, 'linked'));
  if (kind === 'symlink') symlinkSync('keep.txt', join(f.root, 'linked'));
  if (kind === 'alias') { mkdirSync(join(f.root, 'DOCS')); writeFileSync(join(f.root, 'DOCS/other'), 'x'); f.git('add', '.'); f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'alias'); f.binding.treeRevision = f.git('rev-parse', 'HEAD^{tree}'); }
  expect(() => f.apply()).toThrow(); expect(f.journal).not.toHaveBeenCalled(); expect(readFileSync(join(f.root, 'src/a.ts'), 'utf8')).toBe('old');
});
it('rejects a staged index that differs from the bound tree', () => {
  const f = fixture(); writeFileSync(join(f.root, 'keep.txt'), 'staged'); f.git('add', '.'); writeFileSync(join(f.root, 'keep.txt'), 'keep');
  expect(() => f.apply()).toThrow(); expect(f.journal).not.toHaveBeenCalled();
});
it('retains partial writes in quarantine when authority is revoked after a file boundary', () => {
  const f = fixture(); f.port.authorize = () => { if (existsSync(join(f.root, 'docs/new.md'))) throw Error('revoked'); };
  const result = f.apply(); expect(result.kind).toBe('quarantined'); expect(f.quarantine).toHaveBeenCalledOnce(); expect(f.complete).not.toHaveBeenCalled();
  expect(readFileSync(join(f.root, 'src/a.ts'), 'utf8')).toBe('old'); expect(readFileSync(join(f.root, 'docs/new.md'), 'utf8')).toBe('hello');
});
it('does not claim success when completion loses its ACK', () => {
  const f = fixture(); f.port.complete = () => { throw Error('lost ACK'); }; expect(f.apply().kind).toBe('quarantined');
  expect(f.quarantine).toHaveBeenCalledOnce(); expect(readFileSync(join(f.root, 'src/a.ts'), 'utf8')).toBe('new');
});
it('rejects asynchronous authority before any journal or write', () => {
  const f = fixture(); f.port.authorize = () => Promise.resolve(); expect(() => f.apply()).toThrow('APPLY_AUTHORITY'); expect(f.journal).not.toHaveBeenCalled();
});
it('preserves executable mode and ignores malicious clean filter configuration', () => {
  const f = fixture(); chmodSync(join(f.root, 'src/a.ts'), 0o755); writeFileSync(join(f.root, '.gitattributes'), 'src/a.ts filter=evil\n'); f.git('add', '.'); f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'exec');
  f.binding.treeRevision = f.git('rev-parse', 'HEAD^{tree}'); f.manifest.entries[0]!.mode = '100755';
  f.git('config', 'filter.evil.clean', 'touch FILTER_EXECUTED; cat'); const result = f.apply(); expect(result.kind).toBe('applied'); expect(existsSync(join(f.root, 'FILTER_EXECUTED'))).toBe(false);
  f.git('config', '--unset', 'filter.evil.clean'); f.git('add', '-A'); expect(result.treeRevision).toBe(f.git('write-tree'));
});
it('uses the owner execute bit for Git mode, not group or other execute bits', () => {
  const f = fixture(); chmodSync(join(f.root, 'keep.txt'), 0o654);
  expect(f.apply().kind).toBe('applied');
});
it('reports uncertain persistence separately when quarantine itself cannot commit', () => {
  const f = fixture(); f.port.complete = () => { throw Error('completion'); }; f.port.quarantine = () => { throw Error('DB unavailable'); };
  expect(f.apply().kind).toBe('reconciliation_required');
});
it('retains bounded failure phase and completed change count without exposing error text', () => {
  const f = fixture(); f.port.authorize = () => { if (existsSync(join(f.root, 'docs/new.md'))) throw Object.assign(Error('secret error text'), { code: 'EACCES' }); };
  expect(f.apply().kind).toBe('quarantined');
  expect(f.quarantine.mock.calls[0]?.[0]).toMatchObject({ failure: { code: 'EACCES', completedChanges: 1, phase: 'verify' } });
  expect(JSON.stringify(f.quarantine.mock.calls)).not.toContain('secret error text');
});
it.each(['unmanifested', 'surrogate', 'alias'])('validates %s before the filesystem boundary', which => {
  const f = fixture();
  if (which === 'unmanifested') f.proposal.changes.push({ kind: 'create', path: 'keep.txt', content: 'bad' });
  if (which === 'surrogate') f.proposal.changes[0]!.content = '\ud800';
  if (which === 'alias') { f.policy.exactPaths.push('DOCS/other.md'); f.binding.policyDigest = changesetPolicyDigest(f.policy); f.manifest.entries.push({ path: 'DOCS/other.md', state: 'absent' }); f.proposal.changes.push({ kind: 'create', path: 'DOCS/other.md', content: 'bad' }); }
  expect(() => f.apply()).toThrow(); expect(f.journal).not.toHaveBeenCalled();
});
it('supports a registered linked worktree without mutating its shared index or original checkout', () => {
  const f = fixture(); const parent = realpathSync(mkdtempSync(join(tmpdir(), 'graph-linked-'))); roots.push(parent); const workspace = join(parent, 'candidate');
  f.git('worktree', 'add', '--detach', workspace, 'HEAD');
  const result = applyGraphChangeset({ workspace, binding: f.binding, manifest: f.manifest, policy: f.policy, proposal: f.proposal }, f.port);
  expect(result.kind).toBe('applied'); expect(readFileSync(join(f.root, 'src/a.ts'), 'utf8')).toBe('old'); expect(readFileSync(join(workspace, 'src/a.ts'), 'utf8')).toBe('new');
});
it('does not hide gitignored files from its preimage proof', () => {
  const f = fixture(); writeFileSync(join(f.root, '.gitignore'), 'ignored\n'); f.git('add', '.gitignore'); f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'ignore');
  f.binding.treeRevision = f.git('rev-parse', 'HEAD^{tree}'); writeFileSync(join(f.root, 'ignored'), 'unexpected');
  expect(() => f.apply()).toThrow('APPLY_TREE_MISMATCH'); expect(f.journal).not.toHaveBeenCalled();
});
