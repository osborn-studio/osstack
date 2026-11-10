import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, chmodSync, symlinkSync, utimesSync, writeFileSync, readFileSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { acquireRepoWriteLock, inspectRepoWriteLock } from '@osstack/autonomy';
import { resolveRepositoryScope } from '@osstack/core';
import { runShellCommand, withCommandObserver } from '@osstack/loop';
import { beginLocalLoopJournal, recoverLocalLoop, journalDigest } from './local-loop-recovery.js';

let root: string;
let workspace: string;
let locks: string;
let repoId: string;
const runId = 'local_loop_11111111-1111-4111-8111-111111111111';
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'local-recovery-')); workspace = join(root, 'workspace');
  execFileSync('git', ['init', workspace], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'ignore' });
  const scope = await resolveRepositoryScope(workspace); repoId = scope.repoId;
  locks = join(scope.commonDir, 'osstack', 'writer-locks');
  await acquireRepoWriteLock({ root_dir: locks, repo_id: repoId, autonomy_run_id: runId, pid: 2147483646, recover_stale: false });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
async function sealed() {
  const journal = await beginLocalLoopJournal(workspace, runId, true);
  await withCommandObserver(journal.observe, () => runShellCommand('true', { cwd: workspace, timeoutMs: 1000, outputLimit: 100 }));
  writeFileSync(join(workspace, 'candidate.txt'), 'preserve me');
  await journal.seal();
  return journal.path;
}
function evidence(path: string, digest: string) {
  const body = JSON.parse(readFileSync(path, 'utf8'));
  const target = join(root, 'operator-evidence.json');
  writeFileSync(target, JSON.stringify({ version: 1, journalSha256: digest, runId, repoId, workspacePath: body.workspacePath,
    allExternalProducersQuiescent: true, workspaceQuarantined: true, reviewedEvidenceSha256: '1'.repeat(64) }));
  return { quiescenceEvidencePath: target, quiescenceEvidenceSha256: journalDigest(target) };
}
const recover = (path: string, digest = journalDigest(path)) => recoverLocalLoop({ workspacePath: workspace, runId, journalSha256: digest,
  ...evidence(path, digest) });
it('releases once, preserves candidate bytes and acknowledges restart/repeat', async () => {
  const path = await sealed(); const digest = journalDigest(path);
  expect(await recover(path, digest)).toBe('released');
  expect(await inspectRepoWriteLock(locks, repoId)).toBeNull();
  expect(readFileSync(join(workspace, 'candidate.txt'), 'utf8')).toBe('preserve me');
  expect(await recover(path, digest)).toBe('already_released');
});
it('refuses missing terminal receipt', async () => {
  const journal = await beginLocalLoopJournal(workspace, runId, true);
  await expect(recover(journal.path)).rejects.toThrow();
  expect(await inspectRepoWriteLock(locks, repoId)).not.toBeNull();
});
it('refuses a changed workspace and preserves the lease', async () => {
  const path = await sealed(); writeFileSync(join(workspace, 'candidate.txt'), 'changed');
  await expect(recover(path)).rejects.toThrow(/workspace/i);
  expect(await inspectRepoWriteLock(locks, repoId)).not.toBeNull();
});
it('refuses a mismatched operator digest', async () => {
  const path = await sealed(); await expect(recover(path, '0'.repeat(64))).rejects.toThrow();
  expect(await inspectRepoWriteLock(locks, repoId)).not.toBeNull();
});
it('refuses adapter or otherwise ambiguous producers', async () => {
  const journal = await beginLocalLoopJournal(workspace, runId, false); await journal.seal();
  await expect(recover(journal.path)).rejects.toThrow(/producer/i);
});
it('refuses a replacement owner even on a repeated recovery', async () => {
  const path = await sealed(); const digest = journalDigest(path); await recover(path, digest);
  await acquireRepoWriteLock({ root_dir: locks, repo_id: repoId, autonomy_run_id: 'other', recover_stale: false });
  await expect(recover(path, digest)).rejects.toThrow(/owner/i);
  expect((await inspectRepoWriteLock(locks, repoId))?.autonomy_run_id).toBe('other');
});
type EditableJournal = { owner: { pid: number; token: string }; producers: Array<{ pgid?: number;
  terminal?: { termination: { pgid: number; stop_confirmed: boolean } } }> };
function editJournal(path: string, change: (body: EditableJournal) => void) {
  const body = JSON.parse(readFileSync(path, 'utf8')); change(body); writeFileSync(path, JSON.stringify(body));
}
it('refuses a live owner, including a reused PID', async () => {
  const path = await sealed();
  const owner = (await inspectRepoWriteLock(locks, repoId))!;
  writeFileSync(join(locks, `${repoId}.lock`), JSON.stringify({ ...owner, pid: process.pid }));
  editJournal(path, body => { body.owner.pid = process.pid; });
  await expect(recover(path)).rejects.toThrow(/alive|reused/i);
  expect(await inspectRepoWriteLock(locks, repoId)).not.toBeNull();
});
it('refuses a wrong token without changing the owner', async () => {
  const path = await sealed(); const before = await inspectRepoWriteLock(locks, repoId);
  editJournal(path, body => { body.owner.token = '22222222-2222-4222-8222-222222222222'; });
  await expect(recover(path)).rejects.toThrow(/owner/i);
  expect(await inspectRepoWriteLock(locks, repoId)).toEqual(before);
});
it.each(['missing', 'mismatch', 'unconfirmed'])('refuses %s terminal group proof', async kind => {
  const path = await sealed();
  editJournal(path, body => {
    if (kind === 'missing') delete body.producers[0]!.terminal;
    else if (kind === 'mismatch') body.producers[0]!.terminal!.termination.pgid += 1;
    else body.producers[0]!.terminal!.termination.stop_confirmed = false;
  });
  await expect(recover(path)).rejects.toThrow();
  expect(await inspectRepoWriteLock(locks, repoId)).not.toBeNull();
});
it('refuses a live process group despite a terminal receipt', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  try {
    const path = await sealed();
    editJournal(path, body => { body.producers[0]!.pgid = child.pid!; body.producers[0]!.terminal!.termination.pgid = child.pid!; });
    await expect(recover(path)).rejects.toThrow(/alive/i);
    expect(await inspectRepoWriteLock(locks, repoId)).not.toBeNull();
  } finally {
    const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM'); await exit;
  }
});
it('resumes after unlink with lost acknowledgement using durable release intent', async () => {
  const path = await sealed(); const digest = journalDigest(path);
  const body = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path + '.release', JSON.stringify({ journalSha256: digest, owner: body.owner }));
  rmSync(join(locks, `${repoId}.lock`));
  expect(await recover(path, digest)).toBe('already_released');
});
it('does not interpret an unexplained absent lease as successful recovery', async () => {
  const path = await sealed(); rmSync(join(locks, `${repoId}.lock`));
  await expect(recover(path)).rejects.toThrow(/release intent/i);
});
it('refuses legacy runs without host inventory', async () => {
  await expect(recoverLocalLoop({ workspacePath: workspace, runId, journalSha256: '0'.repeat(64), quiescenceEvidencePath: join(root, 'absent'), quiescenceEvidenceSha256: '1'.repeat(64) })).rejects.toThrow();
  expect(await inspectRepoWriteLock(locks, repoId)).not.toBeNull();
});
it('preserves and clears only the exact journaled containment marker', async () => {
  const { loopContainmentPath } = await import('@osstack/loop');
  const { mkdirSync } = await import('node:fs');
  const journal = await beginLocalLoopJournal(workspace, runId, true);
  await withCommandObserver(journal.observe, () => runShellCommand('true', { cwd: workspace, timeoutMs: 1000, outputLimit: 100 }));
  const marker = loopContainmentPath(workspace); mkdirSync(join(marker, '..'), { recursive: true });
  writeFileSync(marker, '{"schema_version":1,"state":"containment_pending"}\n');
  await journal.seal();
  const digest = journalDigest(journal.path);
  expect(await recover(journal.path, digest)).toBe('released');
  expect(() => readFileSync(marker)).toThrow();
  expect(await recover(journal.path, digest)).toBe('already_released');
});
it('rejects modified containment evidence', async () => {
  const { loopContainmentPath } = await import('@osstack/loop');
  const { mkdirSync } = await import('node:fs');
  const path = await sealed(); const marker = loopContainmentPath(workspace);
  mkdirSync(join(marker, '..'), { recursive: true }); writeFileSync(marker, 'another run');
  await expect(recover(path)).rejects.toThrow(/containment/i);
  expect(readFileSync(marker, 'utf8')).toBe('another run');
});
it('never executes configured Git fsmonitor helpers while sealing or recovering', async () => {
  const sentinel = join(root, 'fsmonitor-ran');
  const helper = join(root, 'fsmonitor.sh');
  writeFileSync(helper, `#!/bin/sh\nprintf invoked > '${sentinel}'\nprintf '\\0'\n`, { mode: 0o700 });
  execFileSync('git', ['-C', workspace, 'config', 'core.fsmonitor', helper]);
  const path = await sealed();
  expect(() => readFileSync(sentinel)).toThrow();
  await recover(path);
  expect(() => readFileSync(sentinel)).toThrow();
});

it('hashes only safe selected-worktree files and stores no credentials or raw command output', async () => {
  const sentinel = 'PRIVATE_ENV_SENTINEL_79d42';
  writeFileSync(join(workspace, '.gitignore'), '.env.local\nnode_modules/\n');
  writeFileSync(join(workspace, '.env.local'), sentinel); chmodSync(join(workspace, '.env.local'), 0);
  mkdirSync(join(workspace, 'node_modules')); symlinkSync('/unavailable-ignored-dependency', join(workspace, 'node_modules', 'ignored'));
  const unrelated = join(root, 'unrelated'); execFileSync('git', ['-C', workspace, 'worktree', 'add', '-b', 'fixture-other', unrelated], { stdio: 'ignore' });
  writeFileSync(join(unrelated, 'private.txt'), sentinel); chmodSync(join(unrelated, 'private.txt'), 0);
  const journal = await beginLocalLoopJournal(workspace, runId, true);
  const commandSecret = 'COMMAND_SECRET_93d42';
  await withCommandObserver(journal.observe, () => runShellCommand(`printf ${commandSecret}`, { cwd: workspace, timeoutMs: 1000, outputLimit: 100 }));
  await journal.seal();
  const bytes = readFileSync(journal.path, 'utf8');
  expect(bytes).not.toContain(sentinel); expect(bytes).not.toContain(commandSecret);
  expect(bytes).not.toContain('stdout'); expect(bytes).not.toContain('stderr'); expect(bytes).not.toContain('base64');
  expect(JSON.parse(bytes).snapshot).toEqual(expect.objectContaining({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/), fileCount: 1 }));
  expect(await recover(journal.path)).toBe('released');
  chmodSync(join(workspace, '.env.local'), 0o600); chmodSync(join(unrelated, 'private.txt'), 0o600);
});
it('refuses missing or mismatched explicit external-producer evidence', async () => {
  const path = await sealed(); const digest = journalDigest(path); const approval = evidence(path, digest);
  const args = { workspacePath: workspace, runId, journalSha256: digest, ...approval };
  writeFileSync(approval.quiescenceEvidencePath, '{}');
  await expect(recoverLocalLoop(args)).rejects.toThrow(/external evidence digest/);
  rmSync(approval.quiescenceEvidencePath);
  await expect(recoverLocalLoop(args)).rejects.toThrow();
  expect(await inspectRepoWriteLock(locks, repoId)).not.toBeNull();
});
it.each(['same-size edit', 'stat-only touch'])('never starts configured clean filters for %s', async change => {
  const sentinel = join(root, 'filter-ran');
  writeFileSync(join(workspace, '.gitattributes'), 'tracked.txt filter=fixture\n');
  writeFileSync(join(workspace, 'tracked.txt'), 'original');
  execFileSync('git', ['-C', workspace, 'add', '.gitattributes', 'tracked.txt']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'filter baseline'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspace, 'config', 'filter.fixture.clean', `touch '${sentinel}'; cat`]);
  if (change === 'same-size edit') writeFileSync(join(workspace, 'tracked.txt'), 'modified');
  else utimesSync(join(workspace, 'tracked.txt'), new Date(), new Date(Date.now() + 1000));
  const path = await sealed(); expect(() => readFileSync(sentinel)).toThrow();
  await recover(path); expect(() => readFileSync(sentinel)).toThrow();
});


it('fingerprints changes without reading an oversized clean baseline or unchanged environment template', async () => {
  writeFileSync(join(workspace, '.env.example'), 'EXAMPLE=placeholder');
  const large = join(workspace, 'large-clean-baseline');
  writeFileSync(large, '');
  truncateSync(large, 33 * 1024 * 1024);
  mkdirSync(join(workspace, 'deleted-directory'));
  writeFileSync(join(workspace, 'deleted-directory', 'tracked.txt'), 'tracked');
  execFileSync('git', ['-C', workspace, 'add', '--all']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'large baseline'], { stdio: 'ignore' });
  rmSync(join(workspace, 'deleted-directory'), { recursive: true });
  const path = await sealed();
  expect(JSON.parse(readFileSync(path, 'utf8')).snapshot.fileCount).toBe(2);
  expect(await recover(path)).toBe('released');
});


it.each(['--assume-unchanged', '--skip-worktree'])('refuses a dirty path hidden by %s', async (flag) => {
  writeFileSync(join(workspace, 'hidden.txt'), 'base');
  execFileSync('git', ['-C', workspace, 'add', 'hidden.txt']);
  execFileSync('git', ['-C', workspace, 'update-index', flag, 'hidden.txt']);
  writeFileSync(join(workspace, 'hidden.txt'), 'edit');
  const journal = await beginLocalLoopJournal(workspace, runId, true);
  await expect(journal.seal()).rejects.toThrow(/hidden index entries/);
  expect(await inspectRepoWriteLock(locks, repoId)).not.toBeNull();
});
