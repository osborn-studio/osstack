import { expect, it, vi } from 'vitest';
import { BridgeReadLimiter } from './contained-mission-bridge-read-limiter.js';

it('coordinates consumers per chain, isolates failures and shares exponential backoff', async () => {
  const limiter = new BridgeReadLimiter();
  let now = 0;
  const options = { now: () => now, gapMs: 100, signal: new AbortController().signal };
  const failure = vi.fn(async () => { throw Error('5xx'); });
  await expect(limiter.run('a', options, failure)).rejects.toThrow('5xx');
  expect(await limiter.run('a', options, failure)).toBeUndefined();
  expect(await limiter.run('b', options, async () => 'ok')).toBe('ok');
  now = 100;
  await expect(limiter.run('a', options, failure)).rejects.toThrow();
  now = 299;
  expect(await limiter.run('a', options, failure)).toBeUndefined();
  now = 300;
  expect(await limiter.run('a', options, async () => 'ok')).toBe('ok');
  expect(failure).toHaveBeenCalledTimes(2);
});

it('returns on cancellation but keeps exclusion until the transport actually settles', async () => {
  const limiter = new BridgeReadLimiter();
  const abort = new AbortController();
  let finish!: (value: string) => void;
  const pending = limiter.run('a', { now: () => 0, gapMs: 100, signal: abort.signal }, () => new Promise<string>(resolve => { finish = resolve; }));
  abort.abort();
  await expect(pending).rejects.toThrow('bridge_read_aborted');
  const retry = vi.fn(async () => 'retry');
  expect(await limiter.run('a', { now: () => 1000, gapMs: 100, signal: new AbortController().signal }, retry)).toBeUndefined();
  finish('late');
  await Promise.resolve();
  await Promise.resolve();
  expect(retry).not.toHaveBeenCalled();
});

it('bounds memory without evicting busy leases and expires old idle chains', async () => {
  const limiter = new BridgeReadLimiter(1);
  let now = 0;
  const schedule = { now: () => now, gapMs: 100, signal: new AbortController().signal };
  await limiter.run('a', schedule, async () => 'a');
  expect(await limiter.run('b', schedule, async () => 'b')).toBeUndefined();
  now = 3_600_000;
  expect(await limiter.run('b', schedule, async () => 'b')).toBe('b');
});

it('backs off incomplete results and resets failures after a complete result', async () => {
  const limiter = new BridgeReadLimiter();
  let now = 0;
  const schedule = { now: () => now, gapMs: 100, signal: new AbortController().signal };
  const incomplete = () => limiter.run('a', schedule, async () => { limiter.fail('a', now, 100); return false; });
  await incomplete();
  now = 100;
  await incomplete();
  now = 200;
  expect(await incomplete()).toBeUndefined();
  now = 300;
  await limiter.run('a', schedule, async () => true);
  now = 400;
  await incomplete();
  now = 500;
  expect(await limiter.run('a', schedule, async () => true)).toBe(true);
});
