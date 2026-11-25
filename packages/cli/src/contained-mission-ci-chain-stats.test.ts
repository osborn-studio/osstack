import { expect, it } from 'vitest';
import { summarizeHops, summarizeOpenWaits, waitPercentiles } from './contained-mission-ci-chain-stats.js';

it.each([[1, 1, 1], [2, 1.5, 2], [20, 10.5, 19], [21, 11, 20]])(
  'uses the median and nearest-rank p95 for %i samples', (n, median_ms, p95_ms) => {
    expect(waitPercentiles(Array.from({ length: n }, (_, i) => n - i))).toEqual({ median_ms, p95_ms });
  });

it('pairs consecutive recorded stages, skips negative waits and orders hops by stage', () => {
  expect(summarizeHops([
    { registered: 10, ci_verified: 9, merged: 11 },
    { registered: 0, ci_verified: 8, merged: 12 },
    { registered: 0, pr_opened: 1 },
  ])).toMatchObject({ closed_chains: 3, out_of_order: 1, hops: [
    { hop: 'registered->pr_opened', n: 1, median_ms: 1, p95_ms: 1 },
    { hop: 'registered->ci_verified', n: 1, median_ms: 8, p95_ms: 8 },
    { hop: 'ci_verified->merged', n: 2, median_ms: 3, p95_ms: 4 },
  ] });
});

it('excludes future timestamps from measured waits and bounds the longest list with deterministic ties', () => {
  const chains = Array.from({ length: 12 }, (_, i) => ({ mission_id: String(i).padStart(2, '0'), state: 'waiting', since: 50 })).reverse();
  const result = summarizeOpenWaits([...chains, { mission_id: 'future', state: 'ahead', since: 101 }], 100);
  expect(result).toMatchObject({ open_chains: 13, clock_skew: 1, as_of_ms: 100,
    by_state: [{ state: 'waiting', n: 12, median_ms: 50, max_ms: 50 }] });
  expect(result.longest.map(row => row.mission_id)).toEqual(chains.reverse().slice(0, 10).map(row => row.mission_id));
});
