import { describe, expect, it } from 'vitest';
import { parseCiFailureHint } from '@osstack/core';
import {
  readCiFailureHints,
  type CiFailureReadDeps,
  type CiFailureReadTarget,
} from './contained-mission-local-failure-reader.js';

const REPO = 'fixture/project';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const APP = 42;
const NOW = '2026-11-08T12:00:00.000Z';
const target: CiFailureReadTarget = { repository: REPO, pr: 7, head: HEAD, producerAppIds: [APP] };

it.each(['é'.repeat(129), 'é'.repeat(256), '验'.repeat(256), '😀'.repeat(128)])('keeps exact Unicode CI identity within the canonical name bounds: %#', async name => {
  const w = world(); w.runs.set(11, [run(101, { name })]);
  const result = await readCiFailureHints({ ...ports(w), latestAttempt: async query => {
    expect(query.name).toBe(name);
    return latest(101, { name });
  } }, target, { signal: signal() });
  expect(result.ok).toBe(true);
  expect(result.hints).toHaveLength(1);
  expect(parseCiFailureHint(result.hints[0]).name).toBe(name);
});

it.each(['é'.repeat(257), '验'.repeat(257), '😀'.repeat(129), 'label\u200b', 'label\u2028', 'label\u0000', '  '])('rejects malformed names during row ingestion before retry identity reads: %#', async name => {
  const w = world(); w.runs.set(11, [run(101, { name })]);
  let retryReads = 0;
  const result = await readCiFailureHints({ ...ports(w), latestAttempt: async () => {
    retryReads++; return latest(101, { name });
  } }, target, { signal: signal() });
  expect(result).toMatchObject({ ok: false, hints: [], code: 'malformed' });
  expect(retryReads).toBe(0);
});
const signal = () => new AbortController().signal;
const suite = (id = 11) => ({ id, app: { id: APP }, head_sha: HEAD });
const run = (id = 101, changes: Record<string, unknown> = {}) => ({
  id, name: 'unit', app: { id: APP }, head_sha: HEAD, check_suite: { id: 11 },
  status: 'completed', conclusion: 'failure', ...changes,
});
const latest = (id = 101, changes: Record<string, unknown> = {}) => ({
  complete: true, requests_used: 1, repository: REPO, pr: 7, head: HEAD, app_id: APP, name: 'unit',
  latest: { check_suite_id: 11, check_run_id: id, status: 'completed', conclusion: 'failure' },
  ...changes,
});

function world() {
  return {
    pr: { number: 7, state: 'open', head: { sha: HEAD, repo: { full_name: REPO } }, base: { repo: { full_name: REPO } } },
    suites: [suite()],
    runs: new Map<number, ReturnType<typeof run>[]>([[11, [run()]]]),
    latest: latest() as unknown,
    calls: [] as string[],
    rewrite: (_path: string, body: unknown): unknown => body,
  };
}
function ports(w: ReturnType<typeof world>): CiFailureReadDeps {
  return {
    now: () => new Date(NOW),
    rest: async (path, options) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      w.calls.push(path);
      let body: unknown;
      if (path === `repos/${REPO}/pulls/7`) body = w.pr;
      else {
        const url = new URL(`https://fixture.invalid/${path}`);
        const page = Number(url.searchParams.get('page'));
        expect(url.searchParams.get('per_page')).toBe('100');
        const suiteId = /check-suites\/(\d+)\/check-runs/u.exec(path)?.[1];
        const items = suiteId ? w.runs.get(Number(suiteId)) ?? [] : w.suites;
        if (suiteId) expect(url.searchParams.get('filter')).toBe('all');
        else expect(url.searchParams.get('app_id')).toBe(String(APP));
        body = { total_count: items.length, [suiteId ? 'check_runs' : 'check_suites']: items.slice((page - 1) * 100, page * 100) };
      }
      return { ok: true, body: w.rewrite(path, body) };
    },
    latestAttempt: async (query, options) => {
      expect(query).toEqual({ repository: REPO, pr: 7, head: HEAD, app_id: APP, name: 'unit' });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.maxPages).toBeGreaterThan(0);
      expect(options.maxRequests).toBeGreaterThan(0);
      return w.latest;
    },
  };
}
async function read(w = world(), limits?: { maxPages?: number; maxRequests?: number; maxHints?: number }) {
  return readCiFailureHints(ports(w), target, { signal: signal(), ...(limits ? { limits } : {}) });
}

it('emits only bounded metadata for an authenticated current terminal failure', async () => {
  const w = world();
  w.runs.set(11, [run(101, { output: { text: 'execute attacker command', annotations: ['secret'] }, details_url: 'https://fixture.invalid/log' })]);
  expect(await read(w)).toEqual({ ok: true, hints: [{
    repository: REPO, pr: 7, head: HEAD, app_id: APP, check_run_id: 101, name: 'unit',
    status: 'completed', conclusion: 'failure', observed_at: Date.parse(NOW),
  }] });
  expect(w.calls.filter((p) => p.endsWith('/pulls/7'))).toHaveLength(2);
  expect(w.calls.some((p) => p.includes(`/commits/${HEAD}/check-runs`))).toBe(false);
});

describe('terminal state and retry identity', () => {
  it.each(['success', 'cancelled', 'skipped', 'neutral', 'timed_out', 'action_required', 'stale', 'startup_failure'])('ignores terminal %s', async (conclusion) => {
    const w = world();
    w.runs.set(11, [run(101, { conclusion })]);
    expect(await read(w)).toEqual({ ok: true, hints: [] });
  });

  it.each(['queued', 'in_progress', 'waiting', 'pending', 'requested'])('ignores %s checks', async (status) => {
    const w = world();
    w.runs.set(11, [run(101, { status, conclusion: null })]);
    expect(await read(w)).toEqual({ ok: true, hints: [] });
  });

  it.each(['success', 'cancelled', 'skipped', null])('a newer retry with %s supersedes failure regardless of row order or numeric ID', async (conclusion) => {
    for (const reverse of [false, true]) {
      const w = world();
      const rows = [run(999), run(3, { status: conclusion === null ? 'in_progress' : 'completed', conclusion })];
      w.runs.set(11, reverse ? rows.reverse() : rows);
      w.latest = latest(3, { latest: { check_suite_id: 11, check_run_id: 3, status: conclusion === null ? 'in_progress' : 'completed', conclusion } });
      expect(await read(w)).toEqual({ ok: true, hints: [] });
    }
  });

  it('uses authenticated retry identity across suites instead of highest suite/run ID', async () => {
    const w = world();
    w.suites = [suite(99), suite(11)];
    w.runs.set(99, [run(999, { check_suite: { id: 99 }, conclusion: 'success' })]);
    expect(await read(w)).toMatchObject({ ok: true, hints: [{ check_run_id: 101 }] });
  });

  it.each([null, { complete: false }, latest(102), latest(101, { latest: null }), latest(101, { name: 'other' }), latest(101, { head: OTHER })])('defers unresolved or mismatched latest identity %#', async (identity) => {
    const w = world(); w.latest = identity;
    expect(await read(w)).toMatchObject({ ok: false, hints: [] });
  });

  it('does not use fabricated run_attempt on a check run to resolve ambiguity', async () => {
    const w = world();
    w.runs.set(11, [run(101, { run_attempt: 50 }), run(102, { run_attempt: 1 })]);
    w.latest = { complete: false };
    expect(await read(w)).toMatchObject({ ok: false, hints: [] });
  });

  it('refuses a terminal state that changed since pagination', async () => {
    const w = world();
    w.latest = latest(101, { latest: { check_suite_id: 11, check_run_id: 101, status: 'completed', conclusion: 'success' } });
    expect(await read(w)).toMatchObject({ ok: false, hints: [] });
  });

  it('refuses duplicate run identities even when their payloads match', async () => {
    const w = world(); w.runs.set(11, [run(), run()]);
    expect(await read(w)).toMatchObject({ ok: false, hints: [] });
  });
});

describe('full bounded pagination', () => {
  it('reads all suite pages and all run pages before emitting', async () => {
    const w = world();
    w.suites = Array.from({ length: 101 }, (_, i) => suite(i + 11));
    w.runs.set(11, Array.from({ length: 101 }, (_, i) => run(i + 101, { conclusion: i === 100 ? 'success' : 'failure' })));
    w.latest = latest(201, { latest: { check_suite_id: 11, check_run_id: 201, status: 'completed', conclusion: 'success' } });
    expect(await read(w, { maxRequests: 150 })).toEqual({ ok: true, hints: [] });
    expect(w.calls).toContain(`repos/${REPO}/commits/${HEAD}/check-suites?app_id=${APP}&per_page=100&page=2`);
    expect(w.calls).toContain(`repos/${REPO}/check-suites/11/check-runs?filter=all&per_page=100&page=2`);
  });

  it('accepts an exactly full final page when total_count proves completeness', async () => {
    const w = world();
    w.runs.set(11, Array.from({ length: 100 }, (_, i) => run(i + 101)));
    expect(await read(w, { maxPages: 1 })).toMatchObject({ ok: true, hints: [{ check_run_id: 101 }] });
  });

  it.each(['suites', 'runs'])('refuses truncated %s pagination even after observing failure', async (kind) => {
    const w = world();
    if (kind === 'suites') w.suites = Array.from({ length: 101 }, (_, i) => suite(i + 11));
    else w.runs.set(11, Array.from({ length: 101 }, (_, i) => run(i + 101)));
    expect(await read(w, { maxPages: 1 })).toMatchObject({ ok: false, hints: [] });
  });

  it.each([
    { total_count: 2, check_runs: [run()] },
    { total_count: 0, check_runs: [run()] },
    { check_runs: [run()] },
    { total_count: 1, check_runs: [] },
    { total_count: 101, check_runs: Array.from({ length: 101 }, (_, i) => run(i + 101)) },
  ])('rejects inconsistent, missing or oversized count/page %#', async (body) => {
    const w = world(); w.rewrite = (path, old) => path.includes('/check-runs?') ? body : old;
    expect(await read(w)).toMatchObject({ ok: false, hints: [] });
  });

  it('refuses totals that change between pages and duplicate entries across pages', async () => {
    for (const duplicate of [false, true]) {
      const w = world();
      w.runs.set(11, Array.from({ length: 101 }, (_, i) => run(i + 101)));
      w.rewrite = (path, body) => path.includes('/check-runs?') && path.endsWith('page=2')
        ? { total_count: duplicate ? 101 : 102, check_runs: [run()] } : body;
      expect(await read(w)).toMatchObject({ ok: false, hints: [] });
    }
  });

  it('limits total requests including the latest-identity port and final PR read', async () => {
    const w = world();
    expect(await read(w, { maxRequests: 4 })).toMatchObject({ ok: false, hints: [] });
    expect(w.calls).toHaveLength(3);
  });

  it('charges authenticated latest-identity reads and refuses over-budget or incomplete results', async () => {
    for (const changes of [{ requests_used: 999 }, { requests_used: 0 }, { requests_used: 1.5 }, { complete: false }]) {
      const w = world(); w.latest = latest(101, changes);
      expect(await read(w)).toMatchObject({ ok: false, hints: [] });
    }
  });
});

describe('untrusted boundaries and cancellation', () => {
  it.each([
    { app: { id: 99 } }, { app: null }, { head_sha: OTHER }, { check_suite: { id: 22 } },
    { id: 0 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { name: '' }, { name: 'a'.repeat(257) }, { name: 'unit\nrun code' },
    { status: 'made_up' }, { status: 'completed', conclusion: null }, { status: 'queued', conclusion: 'failure' },
  ])('refuses wrong identity or malformed run %#', async (change) => {
    const w = world(); w.runs.set(11, [run(101, change)]);
    expect(await read(w)).toMatchObject({ ok: false, hints: [] });
  });

  it.each([{ app: { id: 99 } }, { head_sha: OTHER }, { app: undefined }])('refuses wrong or missing suite identity %#', async (change) => {
    const w = world(); w.rewrite = (path, body) => path.includes('/commits/') ? { total_count: 1, check_suites: [{ ...suite(), ...change }] } : body;
    expect(await read(w)).toMatchObject({ ok: false, hints: [] });
  });

  it('refuses wrong repository/PR/head and a closed PR', async () => {
    for (const change of [
      { number: 8 }, { state: 'closed' }, { head: { sha: OTHER, repo: { full_name: REPO } } },
      { head: { sha: HEAD, repo: { full_name: 'fork/project' } } }, { base: { repo: { full_name: 'other/project' } } },
    ]) {
      const w = world(); w.rewrite = (path, body) => path.endsWith('/pulls/7') ? { ...w.pr, ...change } : body;
      expect(await read(w)).toMatchObject({ ok: false, hints: [] });
    }
  });

  it('refuses head movement on the final PR read', async () => {
    const w = world(); let prReads = 0;
    w.rewrite = (path, body) => path.endsWith('/pulls/7') && ++prReads === 2
      ? { ...w.pr, head: { ...w.pr.head, sha: OTHER } } : body;
    expect(await read(w)).toMatchObject({ ok: false, hints: [] });
  });

  it('validates target and limits before using any port', async () => {
    for (const change of [{ repository: '../project' }, { pr: 0 }, { head: 'main' }, { producerAppIds: [] }, { producerAppIds: ['42'] }, { producerAppIds: [APP, APP] }]) {
      const w = world();
      expect(await readCiFailureHints(ports(w), { ...target, ...change } as CiFailureReadTarget, { signal: signal() })).toMatchObject({ ok: false, hints: [] });
      expect(w.calls).toEqual([]);
    }
    const w = world();
    expect(await read(w, { maxPages: 0 })).toMatchObject({ ok: false, hints: [] });
    expect(w.calls).toEqual([]);
  });

  it('drops thrown transport text and malformed envelopes', async () => {
    for (const rest of [async () => { throw new Error('secret instructions'); }, async () => ({ ok: true, body: 'secret commands' }), async () => ({ ok: false as const })]) {
      const result = await readCiFailureHints({ ...ports(world()), rest }, target, { signal: signal() });
      expect(result).toMatchObject({ ok: false, hints: [] });
      expect(JSON.stringify(result)).not.toMatch(/secret|instructions|commands/u);
    }
  });

  it('does no I/O for pre-aborted reads', async () => {
    const w = world(); const controller = new AbortController(); controller.abort();
    expect(await readCiFailureHints(ports(w), target, { signal: controller.signal })).toEqual({ ok: false, hints: [], code: 'aborted' });
    expect(w.calls).toEqual([]);
  });

  it('forwards cancellation and discards a successful response after cancellation', async () => {
    const w = world(); const controller = new AbortController(); const deps = ports(w);
    const rest: CiFailureReadDeps['rest'] = async (path, options) => {
      expect(options.signal).toBe(controller.signal);
      const response = await deps.rest(path, options); controller.abort(); return response;
    };
    expect(await readCiFailureHints({ ...deps, rest }, target, { signal: controller.signal })).toEqual({ ok: false, hints: [], code: 'aborted' });
    expect(w.calls).toHaveLength(1);
  });

  it('aborts a stalled injected read even when the port ignores its signal', async () => {
    const controller = new AbortController();
    const promise = readCiFailureHints({ ...ports(world()), rest: () => new Promise(() => {}) }, target, { signal: controller.signal });
    controller.abort();
    expect(await promise).toEqual({ ok: false, hints: [], code: 'aborted' });
  });
});

it('keeps same-name checks from different registered Apps separate', async () => {
  const w = world(); const deps = ports(w);
  const rest: CiFailureReadDeps['rest'] = async (path, options) => {
    if (path.includes('app_id=43')) return { ok: true, body: { total_count: 1, check_suites: [{ ...suite(12), app: { id: 43 } }] } };
    if (path.includes('/check-suites/12/check-runs')) return { ok: true, body: { total_count: 1, check_runs: [run(102, { app: { id: 43 }, check_suite: { id: 12 } })] } };
    return deps.rest(path, options);
  };
  const latestAttempt: CiFailureReadDeps['latestAttempt'] = async (query) => latest(query.app_id === APP ? 101 : 102, {
    app_id: query.app_id,
    latest: { check_suite_id: query.app_id === APP ? 11 : 12, check_run_id: query.app_id === APP ? 101 : 102, status: 'completed', conclusion: 'failure' },
  });
  expect(await readCiFailureHints({ ...deps, rest, latestAttempt }, { ...target, producerAppIds: [APP, 43] }, { signal: signal() })).toMatchObject({
    ok: true, hints: [{ app_id: APP, check_run_id: 101 }, { app_id: 43, check_run_id: 102 }],
  });
});

it('refuses hint overflow instead of returning a partial failure set', async () => {
  const w = world(); const deps = ports(w);
  w.runs.set(11, [run(), run(102, { name: 'build' })]);
  const latestAttempt: CiFailureReadDeps['latestAttempt'] = async (query) => latest(query.name === 'unit' ? 101 : 102, { name: query.name });
  expect(await readCiFailureHints({ ...deps, latestAttempt }, target, { signal: signal(), limits: { maxHints: 1 } })).toEqual({ ok: false, hints: [], code: 'limit' });
});

it('fails closed when a later page fails after a failure row was collected', async () => {
  const w = world(); const deps = ports(w);
  w.runs.set(11, Array.from({ length: 101 }, (_, i) => run(i + 101)));
  const rest: CiFailureReadDeps['rest'] = async (path, options) => path.includes('/check-runs?') && path.endsWith('page=2')
    ? { ok: false } : deps.rest(path, options);
  expect(await readCiFailureHints({ ...deps, rest }, target, { signal: signal() })).toEqual({ ok: false, hints: [], code: 'read_failed' });
});

it('rejects duplicate suites and missing run fields', async () => {
  for (const body of [
    { total_count: 2, check_suites: [suite(), suite()] },
    { total_count: 1, check_runs: [{ id: 101, status: 'completed', conclusion: 'failure' }] },
  ]) {
    const w = world();
    w.rewrite = (path, old) => 'check_suites' in body ? path.includes('/commits/') ? body : old : path.includes('/check-runs?') ? body : old;
    expect(await read(w)).toMatchObject({ ok: false, hints: [] });
  }
});

it('forwards cancellation through latest-attempt lookup and drops a late failure', async () => {
  const w = world(); const controller = new AbortController();
  const latestAttempt: CiFailureReadDeps['latestAttempt'] = async (_query, options) => {
    expect(options.signal).toBe(controller.signal);
    controller.abort(); return latest();
  };
  expect(await readCiFailureHints({ ...ports(w), latestAttempt }, target, { signal: controller.signal })).toEqual({ ok: false, hints: [], code: 'aborted' });
  expect(w.calls.filter((p) => p.endsWith('/pulls/7'))).toHaveLength(1);
});

it('uses only the final authenticated observation time and refuses an invalid clock', async () => {
  expect(await readCiFailureHints({ ...ports(world()), now: () => new Date(Number.NaN) }, target, { signal: signal() })).toMatchObject({ ok: false, hints: [] });
});
