import { evaluateMergeGates, type MergeSnapshot } from '@osstack/core';
import { describe, expect, it } from 'vitest';
import { readMergeSnapshot } from './contained-mission-merger-reader.js';
import {
  FIXTURE_EPOCH_MS, PSEUDO_REPOSITORY, assertMergerFixtureFile, pseudonymizeMergerRun, scanMergerFixtureForLeaks, type MergerSandboxRun,
} from './contained-mission-merger-sandbox-fixture.js';
import { APP, BOT, BRANCH, HEAD, MISSION, OWNER, REPO, evidence, makeWorld, registry, review, run, serve, type World } from './contained-mission-merger.testkit.js';

const SALT = 'ab'.repeat(32);
const logins = ['gilosbornhello', 'osstack-publisher', 'osstack-sandbox-test-reviewer'];

/** One real-shaped run: the reader over the synthetic GitHub, with realistic (large) ids so the leak probes have something to find. */
async function recordRun(mutate: Array<(w: World) => void>): Promise<MergerSandboxRun> {
  const w = makeWorld();
  const steps: MergerSandboxRun['steps'][number][] = [];
  let at = Date.parse('2026-11-01T00:00:00Z') + 600_000;
  for (const [i, m] of mutate.entries()) {
    m(w);
    const s = serve(w);
    const read = await readMergeSnapshot({ graphql: s.graphql, rest: s.rest }, evidence, registry);
    if (!read.ok) throw new Error('read failed');
    at += 7_000;
    steps.push({ label: `step_${i}`, observed_at: at, snapshot: read.snapshot, timeline_events: read.timeline_events });
  }
  return { evidence, registry, steps, not_recorded: [{ label: 'would_merge_control', reason: 'Requires owner decision 5' }] };
}
const real = (id: number, over: Record<string, unknown> = {}) => review(id, over);
const steps = [
  (w: World) => { w.reviews = []; },
  (w: World) => { w.reviews = [real(4_001, { author: { __typename: 'Bot', databaseId: 9_123 } })]; },
  (w: World) => { w.threads = [{ id: 't1', isResolved: false }]; w.runs[1201] = [run(8_001, 'osstack/verify', APP.evidence, { external_id: `${MISSION}:${HEAD}` })]; },
  (w: World) => { w.threads = []; w.reviews = [real(4_001, { author: { __typename: 'Bot', databaseId: 9_123 } }), real(4_002, { state: 'CHANGES_REQUESTED', author: { __typename: 'Bot', databaseId: 9_123 } })]; },
];

describe('merger sandbox fixture de-identification', () => {
  it('keeps every gate verdict and code: the pseudonymised run evaluates exactly like the real one', async () => {
    const original = await recordRun(steps);
    const { file } = pseudonymizeMergerRun(original, SALT);
    expect(file.steps).toHaveLength(steps.length);
    const verdicts = (r: { evidence: unknown; registry: unknown; snapshots: MergeSnapshot[] }) =>
      r.snapshots.map((snapshot) => { const v = evaluateMergeGates({ evidence: r.evidence as never, snapshot, second: null, registry: r.registry as never }); return [v.verdict, v.codes] as const; });
    const before = verdicts({ evidence, registry, snapshots: original.steps.map((s) => s.snapshot) });
    const after = verdicts({ evidence: file.evidence, registry: file.registry, snapshots: file.steps.map((s) => s.snapshot as unknown as MergeSnapshot) });
    expect(after).toEqual(before);
    expect(new Set(before.map((b) => b[0]))).toEqual(new Set(['refused']));
    expect(before.flatMap((b) => b[1])).toEqual(expect.arrayContaining(['G6.no_counted_approval', 'G6.approval_by_app', 'G6.unresolved_threads', 'G6.changes_requested']));
  });

  it('writes no real value: ids are small pseudonyms, commits and the Mission id are keyed hashes, times are rebased, and the leak scan finds nothing', async () => {
    const original = await recordRun(steps);
    const out = pseudonymizeMergerRun(original, SALT);
    const text = `${JSON.stringify(out.file, null, 2)}\n`;
    scanMergerFixtureForLeaks(text, { logins, ids: out.probes.ids, strings: [...out.probes.strings, BRANCH, MISSION].filter((x) => x !== REPO) });
    expect(out.probes.ids).toEqual(expect.arrayContaining([4_001, 9_123, 8_001, BOT.publisher]));
    expect(text).not.toContain(HEAD);
    expect(text).not.toMatch(/http|@/iu);
    expect(out.file.registry.repository).toBe(PSEUDO_REPOSITORY);
    expect(out.file.evidence.mission_id).not.toBe(MISSION);
    expect(out.file.steps[0]!.observed_at).toBeGreaterThanOrEqual(FIXTURE_EPOCH_MS);
    // no number of four digits or more survives except the rebased times (the PR number is public and short)
    const big = [...text.matchAll(/\b\d{4,}\b/gu)].map((m) => Number(m[0])).filter((n) => n < FIXTURE_EPOCH_MS);
    expect(big).toEqual([]);
    // the private map carries what the file must not
    expect(out.map.actors[`a:${BOT.publisher}`]).toBe(out.file.registry.publisher.actor_id);
    expect(out.map.apps[String(APP.publisher)]).toBe(out.file.registry.publisher.app_id);
  });

  it('is deterministic for one salt, different for another, and a leak is caught', async () => {
    const original = await recordRun(steps);
    const a = pseudonymizeMergerRun(original, SALT);
    const b = pseudonymizeMergerRun(original, SALT);
    const c = pseudonymizeMergerRun(original, 'cd'.repeat(32));
    expect(JSON.stringify(a.file)).toBe(JSON.stringify(b.file));
    expect(a.file.evidence.head).not.toBe(c.file.evidence.head);
    const text = JSON.stringify(a.file);
    expect(() => scanMergerFixtureForLeaks(`${text} gilosbornhello`, { logins, ids: [], strings: [] })).toThrow('FIXTURE_LEAK:login');
    expect(() => scanMergerFixtureForLeaks(`${text} ${HEAD}`, { logins: [], ids: [], strings: [HEAD] })).toThrow('FIXTURE_LEAK:value');
    expect(() => scanMergerFixtureForLeaks(`${text} 4001`, { logins: [], ids: [4_001], strings: [] })).toThrow('FIXTURE_LEAK:id');
    expect(() => scanMergerFixtureForLeaks(`${text} https://x`, { logins: [], ids: [], strings: [] })).toThrow('FIXTURE_LEAK:url');
    expect(() => scanMergerFixtureForLeaks(`${text} a@b`, { logins: [], ids: [], strings: [] })).toThrow('FIXTURE_LEAK:');
  });

  it('keeps only registered check names: any other name or context becomes a keyed hash, in runs and in rule contexts alike', async () => {
    const odd = 'deploy-for-jane.doe-0123456789abcdef0123456789abcdef01234567';
    const original = await recordRun([(w) => {
      w.baseRules = w.baseRules.map((r) => (r['type'] === 'required_status_checks' ? { ...r, parameters: { required_status_checks: [...(r['parameters'] as { required_status_checks: unknown[] }).required_status_checks, { context: odd, integration_id: APP.actions }] } } : r));
    }]);
    // The reader keeps only required contexts in `required_runs`, so the unknown run is injected into the recorded snapshot directly.
    const snap = original.steps[0]!.snapshot;
    const injected = { ...snap.required_runs.runs[0]!, id: 8_002, name: odd };
    const seeded: MergerSandboxRun = { ...original, steps: [{ ...original.steps[0]!, snapshot: { ...snap, required_runs: { ...snap.required_runs, runs: [...snap.required_runs.runs, injected] } } }] };
    const out = pseudonymizeMergerRun(seeded, SALT);
    const text = JSON.stringify(out.file);
    expect(text).not.toContain('jane');
    expect(text).not.toContain('0123456789abcdef');
    const hashed = expect.stringMatching(/^other-[0-9a-f]{10}$/u);
    expect(out.file.steps[0]!.snapshot.base_rules.status_checks.map((c) => c.context)).toEqual(['check', 'build', hashed]);
    expect(out.file.steps[0]!.snapshot.required_runs.runs.map((r) => r.name)).toEqual([...snap.required_runs.runs.map((r) => r.name), hashed]);
    expect(out.file.registry.required_checks.map((c) => c.context)).toEqual(['check', 'build']);
    scanMergerFixtureForLeaks(text, { logins, ids: out.probes.ids, strings: out.probes.strings.filter((x) => x !== REPO) });
  });

  it('rejects protocol values outside the closed vocabulary instead of copying them, and the id scan sees ids glued to letters but not digits inside hashes', async () => {
    const original = await recordRun(steps);
    const snap = structuredClone(original.steps[0]!.snapshot);
    snap.mission_rules.rule_types = [...snap.mission_rules.rule_types, 'jane_doe'];
    expect(() => pseudonymizeMergerRun({ ...original, steps: [{ ...original.steps[0]!, snapshot: snap }] }, SALT)).toThrow(/FIXTURE_REJECTED:invalid_enum_value:steps\.0\.snapshot\.mission_rules\.rule_types/u);
    const other = structuredClone(original.steps[0]!.snapshot);
    other.pr.mergeable = 'jane_doe';
    expect(() => pseudonymizeMergerRun({ ...original, steps: [{ ...original.steps[0]!, snapshot: other }] }, SALT)).toThrow(/FIXTURE_REJECTED/u);
    expect(() => scanMergerFixtureForLeaks('{"n":"other-269190136x"}', { logins: [], ids: [269_190_136], strings: [] })).toThrow('FIXTURE_LEAK:id');
    const hash = `${'0'.repeat(10)}269190136${'a'.repeat(21)}`;
    scanMergerFixtureForLeaks(`{"h":"${hash}","m":"cm_12345678-1234-1234-269190136-123456789012"}`, { logins: [], ids: [269_190_136], strings: [] });
  });

  it('fails closed on anything the scenario does not produce', async () => {
    const original = await recordRun(steps);
    const foreign = structuredClone(original) as unknown as { steps: Array<{ snapshot: { pr: { head_repository: string } } }> };
    foreign.steps[0]!.snapshot.pr.head_repository = 'someone/else';
    expect(() => pseudonymizeMergerRun(foreign as never, SALT)).toThrow('FIXTURE_REJECTED:foreign_repository');
    const branch = structuredClone(original) as unknown as { steps: Array<{ snapshot: { pr: { head_ref_name: string } } }> };
    branch.steps[0]!.snapshot.pr.head_ref_name = 'osstack/mission/other';
    expect(() => pseudonymizeMergerRun(branch as never, SALT)).toThrow('FIXTURE_REJECTED:head_ref_is_not_the_missions');
    const good = pseudonymizeMergerRun(original, SALT).file;
    const leaked = structuredClone(good) as { steps: Array<{ snapshot: { pr: { author: { database_id: number } } } }> };
    leaked.steps[0]!.snapshot.pr.author = { type: 'Bot', database_id: 9_123 } as never;
    expect(() => assertMergerFixtureFile(leaked)).toThrow(/FIXTURE_REJECTED/u);
    expect(() => assertMergerFixtureFile({ ...good, extra: 1 })).toThrow(/FIXTURE_REJECTED/u);
    expect(OWNER).toBeGreaterThan(0);
  });
});
