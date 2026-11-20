import type { execFile } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { createVerificationRest } from './contained-mission-verification-read-transport.js';

const base = 'repos/fixture-owner/fixture-repo'; const sha = 'a'.repeat(40);
const paths = [`${base}/pulls/7`, `${base}/commits/${sha}/check-suites?per_page=100&page=2`,
  `${base}/check-suites/11/check-runs?filter=all&per_page=100&page=3`, `${base}/check-runs/1`];
const options = { signal: new AbortController().signal };
function harness(stdout = '{"fixture":1}', error: Error | null = null, complete?: () => void) {
  const exec = vi.fn((_bin: string, _argv: string[], _options: unknown, callback: (e: Error | null, out: string, err: string) => void) => {
    complete?.(); callback(error, stdout, 'fixture stderr');
  });
  return { exec, rest: createVerificationRest({ execFileImpl: exec as unknown as typeof execFile }) };
}
it.each(paths)('runs the exact GET with bounds for %s', async path => {
  const { rest, exec } = harness();
  expect(await rest(path, { ...options, method: 'GET' })).toEqual({ ok: true, body: { fixture: 1 } });
  expect(exec).toHaveBeenCalledTimes(1);
  expect(exec).toHaveBeenCalledWith('gh', ['api', '--hostname', 'github.com', '--method', 'GET', path],
    { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024, signal: options.signal }, expect.any(Function));
});
it.each(['POST', 'PATCH', 'get', ''])('refuses method %j without spawning', async method => {
  const { rest, exec } = harness(); expect(await rest(paths[0]!, { ...options, method })).toEqual({ ok: false }); expect(exec).not.toHaveBeenCalled();
});
it.each([`${base}/actions/jobs/1/logs`, `${base}/check-runs/1/annotations`, 'repos/o/../pulls/7', `${base}/pulls/7?x=1`,
  `https://api.github.com/${paths[0]}`, 'repos/o/r/check-runs/1/rerequest', paths[1]!.replace('page=2', 'page=0'),
  paths[1]!.replace(sha, sha.toUpperCase()), `/${paths[0]}`, `${base}/pulls/01`])('refuses path %s without spawning', async path => {
  const { rest, exec } = harness(); expect(await rest(path, options)).toEqual({ ok: false }); expect(exec).not.toHaveBeenCalled();
});
it('contains exec errors, invalid JSON and cancellation', async () => {
  expect(await harness(undefined, Error('fixture')).rest(paths[0]!, options)).toEqual({ ok: false });
  expect(await harness('fixture').rest(paths[0]!, options)).toEqual({ ok: false });
  const { exec, rest } = harness(); expect(await rest(paths[0]!, { signal: AbortSignal.abort() })).toEqual({ ok: false }); expect(exec).not.toHaveBeenCalled();
  const c = new AbortController(); expect(await harness(undefined, null, () => c.abort()).rest(paths[0]!, { signal: c.signal })).toEqual({ ok: false });
});
