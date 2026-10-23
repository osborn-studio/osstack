import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { captureGraphProcessIdentity, observeGraphProcessIdentity, compareGraphProcessIdentity } from './graph-process-identity.js';

it('observes an actual isolated child without treating its leader as all executors', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  await once(child, 'spawn');
  try {
    const identity = captureGraphProcessIdentity(child.pid!);
    expect(identity.pid).toBe(child.pid);
    if (process.platform === 'linux') {
      expect(identity).toMatchObject({ kind: 'linux', pgid: child.pid, bootId: expect.any(String), startTicks: expect.any(String) });
      expect(observeGraphProcessIdentity(identity).state).toBe('running');
      if (identity.kind === 'linux') expect(observeGraphProcessIdentity({ ...identity, startTicks: String(BigInt(identity.startTicks) + 1n) }))
        .toMatchObject({ state: 'unknown', reason: 'identity_mismatch' });
    } else expect(observeGraphProcessIdentity(identity).state).toBe('unknown');
  } finally { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
});
it('rejects PID reuse, boot changes, process group changes and coarse timestamps without signaling', () => {
  const saved = { kind: 'linux' as const, pid: 123, pgid: 123, bootId: 'boot', startTicks: '100' };
  const kill = vi.spyOn(process, 'kill');
  try {
    for (const changed of [{ startTicks: '101' }, { bootId: 'new' }, { pgid: 124 }, { pid: 124 }]) {
      expect(compareGraphProcessIdentity(saved, { ...saved, ...changed })).toMatchObject({ state: 'unknown', reason: 'identity_mismatch' });
    }
    const coarse = { kind: 'unverifiable' as const, pid: 123, pgid: 123, platform: 'darwin', detail: 'same second' };
    expect(compareGraphProcessIdentity(coarse, coarse).state).toBe('unknown');
    expect(kill).not.toHaveBeenCalled();
  } finally { kill.mockRestore(); }
});
it('does not probe invalid PIDs', () => {
  expect(() => captureGraphProcessIdentity(-1)).toThrow('GRAPH_PROCESS_PID');
  expect(() => captureGraphProcessIdentity(NaN)).toThrow('GRAPH_PROCESS_PID');
  expect(observeGraphProcessIdentity({ kind: 'linux', pid: -1, pgid: 1, bootId: 'boot', startTicks: '1' }))
    .toEqual({ state: 'unknown', reason: 'identity_invalid' });
});
