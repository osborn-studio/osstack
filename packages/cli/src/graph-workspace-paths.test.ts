import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createScratchDirSync } from '@osstack/core';
import { graphWorkspaceChangedPaths } from './graph-workspace-paths.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(createScratchDirSync('tests', 'raw-gate')); roots.push(root); const repo = join(root, 'repo'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q'); mkdirSync(join(repo, 'dir'));
  writeFileSync(join(repo, 'dir/file'), 'base'); writeFileSync(join(repo, 'binary'), Buffer.from([0, 255, 1]));
  git('add', '.'); git('-c', 'user.name=Raw', '-c', 'user.email=raw@invalid', 'commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  return { root, repo, base, git, read: () => graphWorkspaceChangedPaths(repo, base) };
}
it('compares clean, binary, deleted, ignored and staged paths without changing the index', () => {
  const f = fixture(); expect(f.read()).toEqual([]);
  const index = f.git('ls-files', '--stage');
  writeFileSync(join(f.repo, 'binary'), Buffer.from([0, 255, 2])); unlinkSync(join(f.repo, 'dir/file'));
  writeFileSync(join(f.repo, '.git/info/exclude'), 'hidden\n'); writeFileSync(join(f.repo, 'hidden'), 'ignored');
  expect(f.read()).toEqual(['binary', 'dir/file', 'hidden']); expect(f.git('ls-files', '--stage')).toBe(index);
  f.git('add', '-u'); expect(f.read()).toEqual(['binary', 'dir/file', 'hidden']);
});
it('uses raw executable modes even when core.filemode disables Git detection', () => {
  const f = fixture(); f.git('config', 'core.filemode', 'false'); chmodSync(join(f.repo, 'binary'), 0o755);
  expect(f.git('diff', '--name-only')).toBe(''); expect(f.read()).toEqual(['binary']);
});
it('hashes symlink targets without reading their contents', () => {
  const f = fixture(); const outside = join(f.root, 'secret'); writeFileSync(outside, 'private');
  symlinkSync(outside, join(f.repo, 'link')); f.git('add', 'link'); f.git('-c', 'user.name=Raw', '-c', 'user.email=raw@invalid', 'commit', '-qm', 'link');
  const base = f.git('rev-parse', 'HEAD'); expect(graphWorkspaceChangedPaths(f.repo, base)).toEqual([]);
  writeFileSync(outside, 'changed private'); expect(graphWorkspaceChangedPaths(f.repo, base)).toEqual([]);
  unlinkSync(join(f.repo, 'link')); symlinkSync('missing', join(f.repo, 'link'));
  expect(graphWorkspaceChangedPaths(f.repo, base)).toEqual(['link']);
});
it('fails closed on symlink ancestors instead of following them', () => {
  const f = fixture(); renameSync(join(f.repo, 'dir'), join(f.root, 'outside')); symlinkSync(join(f.root, 'outside'), join(f.repo, 'dir'));
  expect(f.read).toThrow('GRAPH_CONTRACT_RAW_SYMLINK_ANCESTOR');
});
it('rejects submodule index entries and special files', () => {
  const f = fixture(); f.git('update-index', '--add', '--cacheinfo', `160000,${f.base},module`);
  expect(f.read).toThrow('GRAPH_CONTRACT_RAW_INDEX_ENTRY'); f.git('update-index', '--force-remove', 'module');
  unlinkSync(join(f.repo, 'binary')); execFileSync('mkfifo', [join(f.repo, 'binary')]);
  expect(f.read).toThrow('GRAPH_CONTRACT_RAW_SPECIAL_FILE');
});
it('rejects oversized raw files before allocating or reading their contents', () => {
  const f = fixture(); truncateSync(join(f.repo, 'binary'), 256 * 1024 * 1024 + 1);
  expect(f.read).toThrow('GRAPH_CONTRACT_RAW_BYTE_LIMIT');
});
it('keeps both the removed file and added descendants when a file becomes a directory', () => {
  const f = fixture(); unlinkSync(join(f.repo, 'binary')); mkdirSync(join(f.repo, 'binary')); writeFileSync(join(f.repo, 'binary/child'), 'new');
  expect(f.read()).toEqual(['binary', 'binary/child']);
});
it('does not let staged deletions hide files recreated with ignored names', () => {
  const f = fixture(); f.git('rm', 'binary'); writeFileSync(join(f.repo, '.git/info/exclude'), 'binary\n'); writeFileSync(join(f.repo, 'binary'), 'new');
  expect(f.read()).toEqual(['binary']);
});
it('compares raw bytes rather than attributes-normalized contents', () => {
  const f = fixture(); writeFileSync(join(f.repo, '.gitattributes'), 'dir/file text eol=lf\n'); writeFileSync(join(f.repo, 'dir/file'), 'base\n');
  f.git('add', '.'); f.git('-c', 'user.name=Raw', '-c', 'user.email=raw@invalid', 'commit', '-qm', 'attributes');
  const base = f.git('rev-parse', 'HEAD'); writeFileSync(join(f.repo, 'dir/file'), 'base\r\n');
  expect(f.git('diff', '--name-only')).toBe(''); expect(graphWorkspaceChangedPaths(f.repo, base)).toEqual(['dir/file']);
});
it('requires an immutable commit id and rejects submodules in the original base', () => {
  const f = fixture(); expect(() => graphWorkspaceChangedPaths(f.repo, 'HEAD')).toThrow('GRAPH_CONTRACT_RAW_BASE');
  f.git('update-index', '--add', '--cacheinfo', `160000,${f.base},module`); f.git('-c', 'user.name=Raw', '-c', 'user.email=raw@invalid', 'commit', '-qm', 'submodule');
  expect(() => graphWorkspaceChangedPaths(f.repo, f.git('rev-parse', 'HEAD'))).toThrow('GRAPH_CONTRACT_RAW_BASE_ENTRY');
});
