import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readCandidateRevisions } from './graph-verification.js';

it('reads fresh commit and tree with one Git invocation per observation', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-revisions-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args: string[]) => execFileSync('git', ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args], { cwd:root,encoding:'utf8',env:{...env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'} }).trim();
  try {
    git('init','-q');writeFileSync(join(root,'answer'),'before');git('add','answer');git('-c','user.name=fixture','-c','user.email=fixture@invalid','commit','-qm','before');
    const read = vi.fn(git); const before = readCandidateRevisions(read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(before).toEqual({head:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}')});
    writeFileSync(join(root,'answer'),'after');git('add','answer');git('-c','user.name=fixture','-c','user.email=fixture@invalid','commit','-qm','after');
    const after = readCandidateRevisions(read);
    expect(read).toHaveBeenCalledTimes(2);expect(after.head).not.toBe(before.head);expect(after.tree).not.toBe(before.tree);
    expect(after).toEqual({head:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}')});
  } finally { rmSync(root,{recursive:true,force:true}); }
});
it.each(['', 'HEAD', 'a'.repeat(40), 'a'.repeat(40)+'\nHEAD^{tree}', 'a'.repeat(40)+'\n'+'b'.repeat(40)+'\nextra'])('rejects incomplete or malformed Git output %s', output => {
  expect(() => readCandidateRevisions(() => output)).toThrow('CANDIDATE_REVISIONS_INVALID');
});
it('accepts SHA-256 repositories and propagates Git failure', () => {
  expect(readCandidateRevisions(() => 'a'.repeat(40)+'\r\n'+'b'.repeat(40))).toEqual({head:'a'.repeat(40),tree:'b'.repeat(40)});
  expect(readCandidateRevisions(() => 'a'.repeat(64)+'\n'+'b'.repeat(64))).toEqual({head:'a'.repeat(64),tree:'b'.repeat(64)});
  expect(() => readCandidateRevisions(() => {throw Error('git failed');})).toThrow('git failed');
});
