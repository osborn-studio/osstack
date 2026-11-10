import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FifoSemaphore, inspectRepoWriteLock } from '@osstack/autonomy';
import { resolveRepositoryScope } from '@osstack/core';
import { GovernedExecution } from './governed-execution.js';
import { main } from './bin.js';

vi.mock('./local-execution.js', () => ({
  // Only health is replaced. Admission, native lock, engine and receipts are real.
  acquireLocalExecution: (options: { runId: string; workspacePath: string }) => new GovernedExecution({
    reads: new FifoSemaphore(1), writes: new FifoSemaphore(1), repositories: new Map(), checkHealth: async () => {},
  }).acquire({ kind: 'write', runId: options.runId, workspacePath: options.workspacePath }),
}));
let root: string | undefined;
afterEach(() => { vi.restoreAllMocks(); if (root) rmSync(root, { recursive: true, force: true }); });
it('journals and retains a stopped leader-exit failure through the foreground CLI', async () => {
  root = mkdtempSync(join(tmpdir(), 'local-cli-')); const workspace = join(root, 'workspace');
  execFileSync('git', ['init', workspace], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'ignore' });
  mkdirSync(join(workspace, '.osstack')); writeFileSync(join(workspace, '.osstack', 'policy.yaml'), 'schema_version: 1\nmode: execute\n');
  mkdirSync(join(workspace, 'tasks')); writeFileSync(join(workspace, 'tasks', 'one.json'), JSON.stringify({ task_id: 'fixture', prompt: 'fixture', capability: 'code.write' }));
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  const result = await main(['loop', 'run', '--workspace', workspace, '--source', 'task_queue', '--local-recovery-contained',
    '--execute', '/bin/sleep 10 & exit 0', '--verify', 'true', '--json']);
  expect(result).toBe(2);
  const scope = await resolveRepositoryScope(workspace);
  const owner = await inspectRepoWriteLock(join(scope.commonDir, 'osstack', 'writer-locks'), scope.repoId);
  expect(owner?.autonomy_run_id).toMatch(/^local_loop_/);
  const dir = join(scope.commonDir, 'osstack', 'local-loop-recovery');
  const path = join(dir, readdirSync(dir).find(name => name.endsWith('.json'))!);
  const journal = JSON.parse(readFileSync(path, 'utf8'));
  expect(journal.sealed).toBe(true); expect(journal.owner).toEqual(owner);
  expect(journal.producers[0].terminal).toMatchObject({ failure_code: 'surviving_descendants', termination: { stop_confirmed: true } });
  expect(journal.containmentSha256).toMatch(/^[a-f0-9]{64}$/);
  // Current foreground host is alive. CLI recovery must refuse even with its exact digest.
  const { journalDigest } = await import('./local-loop-recovery.js');
  await expect(main(['loop', 'recover-local', '--workspace', workspace, '--run-id', owner!.autonomy_run_id,
    '--approve-journal-sha256', journalDigest(path)])).rejects.toThrow(/approved external quiescence/);
  expect(await inspectRepoWriteLock(join(scope.commonDir, 'osstack', 'writer-locks'), scope.repoId)).toEqual(owner);
});
it.each(['--agent', '--auto-agent', '--daemon', '--worktree'])('refuses recovery opt-in with %s', async flag => {
  const args = ['loop', 'run', '--local-recovery-contained', flag]; if (flag === '--agent') args.push('codex-cli');
  const route = vi.spyOn(await import('./loop-profile-routing.js'), 'resolveLoopProfileRouting')
    .mockResolvedValue(new Error('no Builder is available'));
  await expect(main(args)).rejects.toThrow(/foreground contained/);
  expect(route).not.toHaveBeenCalled();
});

it('releases newly admitted ownership when journal initialization fails before execution', async () => {
  const { loopContainmentPath } = await import('@osstack/loop');
  root = mkdtempSync(join(tmpdir(), 'local-cli-init-')); const workspace = join(root, 'workspace');
  execFileSync('git', ['init', workspace], { stdio: 'ignore' });
  mkdirSync(join(workspace, '.osstack')); writeFileSync(join(workspace, '.osstack', 'policy.yaml'), 'schema_version: 1\nmode: execute\n');
  const marker = loopContainmentPath(workspace); mkdirSync(join(marker, '..'), { recursive: true }); writeFileSync(marker, 'previous containment');
  await expect(main(['loop', 'run', '--workspace', workspace, '--local-recovery-contained', '--execute', 'touch forbidden']))
    .rejects.toThrow(/pre-existing containment/);
  const scope = await resolveRepositoryScope(workspace);
  expect(await inspectRepoWriteLock(join(scope.commonDir, 'osstack', 'writer-locks'), scope.repoId)).toBeNull();
  expect(() => readFileSync(join(workspace, 'forbidden'))).toThrow();
  expect(readFileSync(marker, 'utf8')).toBe('previous containment');
});
