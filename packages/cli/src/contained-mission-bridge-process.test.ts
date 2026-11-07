import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createScratchDirSync } from '@osstack/core';
import { expect, it, vi } from 'vitest';
import { defaultGhExec } from './contained-mission-bridge-reader.js';

it('cancels a running host-credential read process instead of waiting for its timeout', async () => {
  const root = createScratchDirSync('tests', 'bridge-gh-abort');
  const ready = join(root, 'ready');
  writeFileSync(join(root, 'gh'), `#!${process.execPath}\nconst fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const abort = new AbortController();
  vi.stubEnv('PATH', root);
  try {
    const running = defaultGhExec(['api', 'repos/o/r'], { timeoutMs: 30_000, signal: abort.signal });
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
    const pid = Number(readFileSync(ready, 'utf8'));
    abort.abort();
    expect((await running).exitCode).not.toBe(0);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  } finally { abort.abort(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});
