import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createScratchDir } from '@osstack/core';
import { inspectGitSource } from './source-snapshot.js';

const gitBinary = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const roots: string[] = [];
async function fixture(format = 'sha1') {
  const root = await createScratchDir('tests', 'source'); roots.push(root);
  const git = (...args: string[]) => execFileSync(gitBinary, ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', `--object-format=${format}`); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  mkdirSync(join(root, 'method')); writeFileSync(join(root, 'method', 'SKILL.md'), 'first\r\n');
  writeFileSync(join(root, 'LICENSE'), 'fixture license');
  writeFileSync(join(root, 'method/ü.md'), 'é\n');
  git('add', '.'); git('commit', '-qm', 'initial');
  const options = { gitBinary, repositoryPath: root, repository: 'https://example.invalid/source', commit: git('rev-parse', 'HEAD'), subdir: 'method', licensePaths: ['LICENSE'] };
  return { root, git, options };
}
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

describe('immutable single-source inspection', async () => {
  it.each(['sha1', 'sha256'])('uses exact %s objects, survives packed storage and ignores checkout changes', async format => {
    const { root, git, options } = await fixture(format); const a = inspectGitSource(options);
    expect(a.kind).toBe('source_inspection'); expect(a.dependency_resolution).toBe('not_performed');
    expect(a.repository_identity).toBe('caller_asserted'); expect(a.expected_digest_checked).toBe(false);
    expect(a.files.map(f => f.path)).toEqual(['LICENSE', 'method/SKILL.md', 'method/ü.md']);
    expect(a.files[1]?.sha256).toBe(createHash('sha256').update('first\r\n').digest('hex'));
    writeFileSync(join(root, 'method', 'SKILL.md'), 'uncommitted'); writeFileSync(join(root, 'method', 'ignored'), 'not tracked');
    git('repack', '-ad'); expect(inspectGitSource(options)).toEqual(a);
    expect(inspectGitSource({ ...options, expectedContentSha256: a.pin.content_sha256 }).expected_digest_checked).toBe(true);
    expect(() => inspectGitSource({ ...options, expectedContentSha256: '0'.repeat(64) })).toThrow('CONTENT_DRIFT');
    const independent = execFileSync('python3', ['-I', '-c', `import json,sys,hashlib
x=json.load(sys.stdin)
def digest(domain,value):
 return hashlib.sha256((domain+'\\n'+json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':'))).encode()).hexdigest()
content={k:x['pin'][k] for k in ['repository','commit','subdir']}
content.update(schema_version=1,files=x['files'])
if digest('osstack.joint.source-content.v1',content)!=x['pin']['content_sha256']: raise SystemExit('content mismatch')
expected=x.pop('inspection_digest')
if digest('osstack.joint.source-inspection.v1',x)!=expected: raise SystemExit('inspection mismatch')
print('verified')`], { input: JSON.stringify(a), encoding: 'utf8' });
    expect(independent.trim()).toBe('verified');
    expect(a).not.toHaveProperty('snapshot'); // Not a detached, apparently closed SourceSnapshot.
  });
  it('deduplicates a license already in the source tree and binds role and executable mode', async () => {
    const { options, git } = await fixture(); const a = inspectGitSource({ ...options, subdir: '.' });
    expect(a.files).toHaveLength(3); expect(a.files[0]?.role).toBe('license');
    expect(() => inspectGitSource({ ...options, licensePaths: ['LICENSE', 'LICENSE'] })).toThrow();
    git('update-index', '--chmod=+x', 'method/SKILL.md'); git('commit', '-qm', 'mode');
    const b = inspectGitSource({ ...options, commit: git('rev-parse', 'HEAD') });
    expect(b.files[1]?.mode).toBe('100755'); expect(b.pin.content_sha256).not.toBe(a.pin.content_sha256);
  });
  it.each(['../method', '/method', 'method/../method', 'method\\x', '.git', 'method/', 'method:ads'])('rejects unsafe subdir %s', async subdir => {
    const { options } = await fixture(); expect(() => inspectGitSource({ ...options, subdir })).toThrow();
  });
  it('rejects missing objects, missing directories, non-trees and format mismatch', async () => {
    const { options } = await fixture();
    for (const patch of [{ commit: 'f'.repeat(40) }, { commit: 'f'.repeat(64) }, { commit: 'HEAD' }, { subdir: 'absent' }, { subdir: 'LICENSE' }, { licensePaths: ['absent'] }]) {
      expect(() => inspectGitSource({ ...options, ...patch })).toThrow();
    }
  });
  it.each(['120000', '160000'])('rejects unsafe Git mode %s without reading the worktree', async mode => {
    const { options, git } = await fixture(); const oid = mode === '160000' ? options.commit : git('rev-parse', 'HEAD:LICENSE');
    git('update-index', '--add', '--cacheinfo', `${mode},${oid},method/unsafe`); git('commit', '-qm', 'unsafe');
    expect(() => inspectGitSource({ ...options, commit: git('rev-parse', 'HEAD') })).toThrow('UNSAFE_ENTRY');
  });
  it('rejects case collisions in Git even on case-insensitive filesystems', async () => {
    const { options, git } = await fixture(); const oid = git('rev-parse', 'HEAD:method/SKILL.md');
    git('update-index', '--add', '--cacheinfo', `100644,${oid},method/skill.md`); git('commit', '-qm', 'collision');
    expect(() => inspectGitSource({ ...options, commit: git('rev-parse', 'HEAD') })).toThrow();
  });
  it('ignores injected Git locations and config; never applies replacement objects', async () => {
    const { root, options, git } = await fixture(); const old = inspectGitSource(options);
    writeFileSync(join(root, 'method/SKILL.md'), 'replacement'); git('add', '.'); git('commit', '-qm', 'replacement');
    git('replace', options.commit, git('rev-parse', 'HEAD'));
    const keys = ['GIT_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_REPLACE_REF_BASE', 'GIT_EXEC_PATH', 'GIT_CONFIG_GLOBAL'];
    const before = keys.map(k => process.env[k]);
    try { keys.forEach(k => { process.env[k] = '/missing/injected'; }); expect(inspectGitSource(options)).toEqual(old); }
    finally { keys.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i]; }); }
  });
  it('rejects partial mirrors and alternate stores', async () => {
    const { root, options, git } = await fixture(); git('config', 'remote.origin.promisor', 'true');
    expect(() => inspectGitSource(options)).toThrow('PARTIAL_STORE'); git('config', '--unset', 'remote.origin.promisor');
    writeFileSync(join(root, '.git/objects/info/alternates'), '/missing\n');
    expect(() => inspectGitSource(options)).toThrow('ALTERNATE_STORE');
  });
  it('rejects a missing or corrupt blob and never emits a partial result', async () => {
    const { root, options, git } = await fixture(); const oid = git('rev-parse', 'HEAD:method/SKILL.md');
    rmSync(join(root, '.git/objects', oid.slice(0, 2), oid.slice(2)));
    expect(() => inspectGitSource(options)).toThrow();
  });
  it('rejects oversized blobs before capture', async () => {
    const { root, options, git } = await fixture(); writeFileSync(join(root, 'method/large'), Buffer.alloc(512 * 1024 + 1));
    git('add', '.'); git('commit', '-qm', 'large');
    expect(() => inspectGitSource({ ...options, commit: git('rev-parse', 'HEAD') })).toThrow('RESOURCE_LIMIT');
  });
  it('rejects more than 512 selected files and total content above 8 MiB', async () => {
    const { root, options, git } = await fixture(); const blob = git('rev-parse', 'HEAD:LICENSE');
    const entries = Array.from({ length: 512 }, (_, i) => `100644 ${blob}\tmethod/f${i}\n`).join('');
    execFileSync(gitBinary, ['-C', root, 'update-index', '--index-info'], { input: entries }); git('commit', '-qm', 'many');
    expect(() => inspectGitSource({ ...options, commit: git('rev-parse', 'HEAD') })).toThrow('RESOURCE_LIMIT');
    git('reset', '--hard', options.commit); writeFileSync(join(root, 'method/large'), Buffer.alloc(512 * 1024)); git('add', '.');
    git('commit', '-qm', 'exact blob limit');
    expect(inspectGitSource({ ...options, commit: git('rev-parse', 'HEAD') }).files.find(f => f.path === 'method/large')?.bytes).toBe(512 * 1024);
    const big = git('rev-parse', ':method/large');
    execFileSync(gitBinary, ['-C', root, 'update-index', '--index-info'], { input: Array.from({ length: 16 }, (_, i) => `100644 ${big}\tmethod/big${i}\n`).join('') }); git('commit', '-qm', 'total');
    expect(() => inspectGitSource({ ...options, commit: git('rev-parse', 'HEAD') })).toThrow('RESOURCE_LIMIT');
    expect(readFileSync(join(root, 'method/SKILL.md'), 'utf8')).toBe('first\r\n');
  });
  it('detects corrupt object bytes even when size and loose filename remain unchanged', async () => {
    const { root, options, git } = await fixture(); const oid = git('rev-parse', 'HEAD:method/SKILL.md');
    rmSync(join(root, '.git/objects', oid.slice(0, 2), oid.slice(2)));
    writeFileSync(join(root, '.git/objects', oid.slice(0, 2), oid.slice(2)), deflateSync(Buffer.from('blob 7\0other\r\n')));
    expect(() => inspectGitSource(options)).toThrow('OBJECT_MISMATCH');
  });
  it('never executes checkout hooks or content conversion filters', async () => {
    const { root, options, git } = await fixture(); const sentinel = join(root, 'executed');
    writeFileSync(join(root, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch "${sentinel}"\n`, { mode: 0o755 });
    writeFileSync(join(root, 'method/.gitattributes'), '* filter=poison\n');
    git('add', '.'); git('commit', '-qm', 'attributes');
    git('config', 'filter.poison.smudge', `touch "${sentinel}"`);
    const result = inspectGitSource({ ...options, commit: git('rev-parse', 'HEAD') });
    expect(result.files.some(f => f.path === 'method/.gitattributes')).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
  });

  it('binds the mirror root and rejects malformed identity before running Git', async () => {
    const { root, options } = await fixture();
    expect(() => inspectGitSource({ ...options, repositoryPath: join(root, 'method') })).toThrow('INVALID_INPUT');
    expect(() => inspectGitSource({ ...options, repository: '\ud800', gitBinary: '/nonexistent' })).toThrow('INVALID_INPUT');
  });
  it('rejects included and worktree promisor configuration', async () => {
    const { root, options, git } = await fixture();
    writeFileSync(join(root, '.git', 'promisor.cfg'), '[remote "origin"]\n promisor = true\n');
    git('config', 'include.path', 'promisor.cfg');
    expect(() => inspectGitSource(options)).toThrow('PARTIAL_STORE'); git('config', '--unset', 'include.path');
    git('config', 'extensions.worktreeConfig', 'true');
    git('config', '--worktree', 'remote.origin.promisor', 'true');
    expect(() => inspectGitSource(options)).toThrow('PARTIAL_STORE');
  });
  it('rejects unsafe outside licenses, Unicode collisions and promisor pack markers', async () => {
    const { root, options, git } = await fixture(); const blob = git('rev-parse', 'HEAD:LICENSE');
    git('update-index', '--add', '--cacheinfo', `120000,${blob},LICENSE`); git('commit', '-qm', 'license link');
    expect(() => inspectGitSource({ ...options, commit: git('rev-parse', 'HEAD') })).toThrow('UNSAFE_ENTRY');
    git('reset', '--hard', options.commit);
    git('config', 'core.precomposeunicode', 'false');
    for (const name of ['method/é.md', 'method/e\u0301.md']) git('update-index', '--add', '--cacheinfo', `100644,${blob},${name}`);
    git('commit', '-qm', 'unicode collision');
    expect(() => inspectGitSource({ ...options, commit: git('rev-parse', 'HEAD') })).toThrow('UNSAFE_ENTRY');
    writeFileSync(join(root, '.git/objects/pack/x.promisor'), '');
    expect(() => inspectGitSource(options)).toThrow('PARTIAL_STORE');
  });
  it('rejects unsupported Git and bounds a stalled host binary with a typed retryable timeout', async () => {
    const { root, options } = await fixture(); const stub = join(root, 'git-stub');
    writeFileSync(stub, `#!${process.execPath}\nconsole.log('git version 2.47.9');\n`, { mode: 0o755 });
    expect(() => inspectGitSource({ ...options, gitBinary: stub })).toThrow('UNSUPPORTED_GIT');
    writeFileSync(stub, `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); setTimeout(() => {}, 15000);\n`);
    try { inspectGitSource({ ...options, gitBinary: stub }); throw new Error('timeout not enforced'); }
    catch (e) { expect(e).toMatchObject({ code: 'SOURCE_TIMEOUT', retryable: true }); }
  }, 15000);

  it('accepts a bare clone with identical evidence and rejects redirected gitfiles and git-dir symlinks', async () => {
    const { root, options } = await fixture(); const before = inspectGitSource(options);
    const bare = await createScratchDir('tests', 'source-bare'); roots.push(bare);
    execFileSync(gitBinary, ['clone', '--bare', '--no-hardlinks', root, bare], { stdio: 'pipe' });
    expect(inspectGitSource({ ...options, repositoryPath: bare })).toEqual(before);
    const redirected = join(root, 'redirected'); mkdirSync(redirected);
    writeFileSync(join(redirected, '.git'), `gitdir: ${join(root, '.git')}\n`);
    expect(() => inspectGitSource({ ...options, repositoryPath: redirected })).toThrow('INVALID_INPUT');
    rmSync(join(redirected, '.git')); symlinkSync(join(root, '.git'), join(redirected, '.git'));
    expect(() => inspectGitSource({ ...options, repositoryPath: redirected })).toThrow('INVALID_INPUT');
  });
  it('requires a non-license source and classifies long missing paths without stderr overflow', async () => {
    const { root, options, git } = await fixture();
    expect(() => inspectGitSource({ ...options, subdir: 'x'.repeat(200) })).toThrow('OBJECT_UNAVAILABLE');
    git('rm', '-r', 'method'); mkdirSync(join(root, 'method')); writeFileSync(join(root, 'method/LICENSE'), 'license only');
    git('add', '.'); git('commit', '-qm', 'license only');
    expect(() => inspectGitSource({ ...options, commit: git('rev-parse', 'HEAD'), licensePaths: ['method/LICENSE'] })).toThrow('OBJECT_UNAVAILABLE');
  });
  it('successfully inspects exactly 512 files within the declared operation budget', async () => {
    const { root, options, git } = await fixture(); const blob = git('rev-parse', 'HEAD:LICENSE');
    execFileSync(gitBinary, ['-C', root, 'update-index', '--index-info'], { input: Array.from({ length: 509 }, (_, i) => `100644 ${blob}\tmethod/f${i}\n`).join('') });
    git('commit', '-qm', '512 files');
    const start = performance.now();
    expect(inspectGitSource({ ...options, commit: git('rev-parse', 'HEAD') }).files).toHaveLength(512);
    console.info('512-file inspection elapsed_ms=' + Math.round(performance.now() - start));
  }, 45000);

});
