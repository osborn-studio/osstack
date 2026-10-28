import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
import { spawn } from 'node:child_process';
import { checkSource } from './watcher.js';
import { SkillSource } from './manifest.js';

function child() {
  const process = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  vi.mocked(spawn).mockReturnValueOnce(process as unknown as ChildProcessWithoutNullStreams);
  return process;
}
const source = SkillSource.parse({ id: 'upstream', origin: 'file:///owned/origin', ref: 'refs/heads/main', blessed_sha: 'a'.repeat(40) });
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

describe('source check waits for subprocess stdio completion', () => {
  it('reads the complete head when exit arrives before the final stdout chunk', async () => {
    const git = child(); const result = checkSource(source);
    git.emit('exit', 0);
    git.stdout.write('b'.repeat(40) + '\trefs/heads/main\n');
    git.emit('close', 0);
    await expect(result).resolves.toMatchObject({ ok: true, current_sha: 'b'.repeat(40), drifted: true });
  });

  it('preserves trailing stderr for a failed Git process instead of reporting only its exit code', async () => {
    const git = child(); const result = checkSource(source);
    git.emit('exit', 128);
    git.stderr.write('fatal: reference access denied\n');
    git.emit('close', 128);
    await expect(result).resolves.toMatchObject({ ok: false, reason: 'fatal: reference access denied' });
  });

  it('does not report no_matching_ref until the stdout pipe has actually closed', async () => {
    const git = child(); const result = checkSource(source); let settled = false;
    void result.then(() => { settled = true; });
    git.emit('exit', 0); await new Promise<void>(resolve => setImmediate(resolve));
    const settledBeforeClose = settled; git.emit('close', 0);
    expect(settledBeforeClose).toBe(false);
    await expect(result).resolves.toMatchObject({ ok: false, reason: 'no_matching_ref' });
  });

  it('keeps the existing deadline active while an exited process has not closed its pipes', async () => {
    vi.useFakeTimers(); const git = child(); const result = checkSource(source);
    git.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(20000);
    await expect(result).resolves.toMatchObject({ ok: false, reason: 'timeout' });
    expect(git.kill).toHaveBeenCalledWith('SIGTERM');
    git.stdout.write('b'.repeat(40) + '\trefs/heads/main\n'); git.emit('close', 0);
    await expect(result).resolves.toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('retains spawn failure when no process can run', async () => {
    const git = child(); const result = checkSource(source);
    git.emit('error', new Error('ENOENT')); git.emit('close', -2);
    await expect(result).resolves.toMatchObject({ ok: false, reason: 'spawn_failed: ENOENT' });
  });

  it('still checks equality after ordinary stdout-before-exit completion', async () => {
    const git = child(); const result = checkSource(source);
    git.stdout.write('a'.repeat(40) + '\trefs/heads/main\n'); git.emit('exit', 0); git.emit('close', 0);
    await expect(result).resolves.toMatchObject({ ok: true, current_sha: 'a'.repeat(40), drifted: false });
  });
});
