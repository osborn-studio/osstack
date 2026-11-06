import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type PrSnapshot, type ProducerRegistry, createScratchDir } from '@osstack/core';
import { describe, expect, it } from 'vitest';
import { assertFixtureFile, fixtureMapPath, fixtureWith, newFixtureMap, pseudonymizeSnapshot, readFixtureMap, scanForLeaks, writeFixtureMap } from './contained-mission-bridge-fixture.js';

const HEAD = 'a'.repeat(40);
const registry: ProducerRegistry = {
  publisher: [{ actor_id: 269190136, app_id: null }],
  reviewers: [{ actor_id: 160148718, app_id: null }, { actor_id: 243772068, app_id: 3456789 }],
};
const snapshot: PrSnapshot = {
  pr_state: 'MERGED', head: HEAD, base_sha: 'b'.repeat(40), base_ref: 'main', observed_at: 1_700_000_000_000, complete: true, moved: false,
  reviews: [
    { review_id: 11, state: 'APPROVED', submitted_at: 1_699_000_000_000, review_commit: HEAD, reviewer: { actor_id: 243772068, app_id: 3456789 }, has_feedback: false, feedback_digest: null },
    { review_id: 12, state: 'CHANGES_REQUESTED', submitted_at: 1_699_000_100_000, review_commit: HEAD, reviewer: { actor_id: 777777777, app_id: null }, has_feedback: true, feedback_digest: 'c'.repeat(64) },
    { review_id: 13, state: 'COMMENTED', submitted_at: 1_699_000_200_000, review_commit: HEAD, reviewer: { actor_id: 160148718, app_id: null }, has_feedback: false, feedback_digest: null },
  ],
};

describe('pseudonymizeSnapshot', () => {
  const out = pseudonymizeSnapshot(snapshot, registry);

  it('numbers registered identities by registry order and others after them', () => {
    expect(out.registry).toEqual({ publisher: [{ actor_id: 1, app_id: null }], reviewers: [{ actor_id: 2, app_id: null }, { actor_id: 3, app_id: 1 }] });
    expect(out.snapshot.reviews.map((r) => r.reviewer)).toEqual([{ actor_id: 3, app_id: 1 }, { actor_id: 4, app_id: null }, { actor_id: 2, app_id: null }]);
  });
  it('is consistent across files for the same registry and leaves no real id behind', () => {
    const again = pseudonymizeSnapshot({ ...snapshot, reviews: [] }, registry);
    expect(again.registry).toEqual(out.registry);
    const text = JSON.stringify({ version: 1, registry: out.registry, snapshots: [out.snapshot] });
    scanForLeaks(text, { logins: ['someone'], ids: [269190136, 160148718, 243772068, 777777777, 3456789] });
  });
  it('requires observed_at', () => {
    const { observed_at: _o, ...rest } = snapshot;
    expect(() => pseudonymizeSnapshot(rest, registry)).toThrow('FIXTURE_REJECTED');
  });
});

describe('allowlist schema', () => {
  const good = () => { const o = pseudonymizeSnapshot(snapshot, registry); return { version: 1, registry: o.registry, snapshots: [o.snapshot] }; };
  it('accepts the pseudonymised file', () => { expect(assertFixtureFile(good()).snapshots).toHaveLength(1); });
  it('rejects an extra field anywhere', () => {
    const top = { ...good(), note: 'x' };
    const snap = good(); (snap.snapshots[0] as Record<string, unknown>)['title'] = 'x';
    const rev = good(); (rev.snapshots[0]!.reviews[0] as Record<string, unknown>)['login'] = 'octocat';
    const who = good(); (who.snapshots[0]!.reviews[0]!.reviewer as Record<string, unknown>)['login'] = 'octocat';
    for (const bad of [top, snap, rev, who]) expect(() => assertFixtureFile(bad)).toThrow(/FIXTURE_REJECTED:unrecognized_keys/u);
  });
  it('rejects a real-looking actor id, a non-hex oid and an odd base ref', () => {
    const real = good(); real.snapshots[0]!.reviews[0]!.reviewer.actor_id = 160148718;
    const oid = good(); oid.snapshots[0]!.head = 'not-a-sha';
    const ref = good(); ref.snapshots[0]!.base_ref = 'release-2026';
    for (const bad of [real, oid, ref]) expect(() => assertFixtureFile(bad)).toThrow(/FIXTURE_REJECTED/u);
  });
  it('does not echo the rejected value', () => {
    const bad = good(); bad.snapshots[0]!.base_ref = 'secret-login@example.com';
    try { assertFixtureFile(bad); } catch (e) { expect(String(e)).not.toContain('secret-login'); return; }
    throw new Error('expected rejection');
  });
});

describe('scanForLeaks', () => {
  const probes = { logins: ['Octo-Cat'], ids: [160148718] };
  it.each([
    ['login in any case', '{"a":"octo-cat"}', 'FIXTURE_LEAK:login'],
    ['real numeric id', '{"actor_id":160148718}', 'FIXTURE_LEAK:actor_id'],
    ['URL', '{"u":"https://github.com/x"}', 'FIXTURE_LEAK:url'],
    ['email', '{"e":"a.b@example.com"}', 'FIXTURE_LEAK:email'],
    ['bare at sign', '{"e":"@someone"}', 'FIXTURE_LEAK:at_sign'],
  ])('fails on %s', (_n, text, error) => {
    expect(() => scanForLeaks(text, probes)).toThrow(error);
  });
  it('does not mistake an id inside a longer token for a leak', () => {
    scanForLeaks(`{"x":"${'1'.repeat(8)}160148718${'f'.repeat(8)}","n":1601487189}`, probes);
  });
  it('does not echo what matched', () => {
    try { scanForLeaks('octo-cat', probes); } catch (e) { expect(String(e)).not.toMatch(/octo/iu); return; }
    throw new Error('expected leak');
  });
});

describe('fixtureWith', () => {
  it('appends a second snapshot under the same registry and refuses a different registry', () => {
    const first = fixtureWith(undefined, pseudonymizeSnapshot(snapshot, registry));
    const second = fixtureWith(first, pseudonymizeSnapshot({ ...snapshot, observed_at: 1_700_000_100_000 }, registry));
    expect(second.snapshots.map((s) => s.observed_at)).toEqual([1_700_000_000_000, 1_700_000_100_000]);
    const other: ProducerRegistry = { publisher: registry.publisher, reviewers: [registry.reviewers[0]!] };
    expect(() => fixtureWith(first, pseudonymizeSnapshot(snapshot, other))).toThrow('FIXTURE_REJECTED:registry_mismatch');
  });
});

describe('stable pseudonym map (item: append consistency)', () => {
  const later: PrSnapshot = {
    ...snapshot, observed_at: 1_700_000_100_000,
    reviews: [
      { ...snapshot.reviews[0]!, reviewer: { actor_id: 111111111, app_id: null }, review_id: 21 }, // sorts before 777777777
      snapshot.reviews[1]!,
    ],
  };

  it('keeps an unregistered actor on the same pseudonym across recordings, even when new actors sort before it', () => {
    const first = pseudonymizeSnapshot(snapshot, registry);
    const second = pseudonymizeSnapshot(later, registry, first.map);
    const stranger = (p: ReturnType<typeof pseudonymizeSnapshot>) => p.snapshot.reviews.find((r) => r.review_id === 12)!.reviewer;
    expect(stranger(second)).toEqual(stranger(first));
    expect(second.snapshot.reviews.find((r) => r.review_id === 21)!.reviewer.actor_id).not.toBe(stranger(first).actor_id);
    expect(() => fixtureWith(fixtureWith(undefined, first), second)).not.toThrow();
  });

  it('does not mutate the previous map, and the fixture never contains the map', () => {
    const map = newFixtureMap();
    const out = pseudonymizeSnapshot(snapshot, registry, map);
    expect(map.actors).toEqual({});
    const text = JSON.stringify(fixtureWith(undefined, out));
    for (const id of [269190136, 777777777]) expect(text).not.toContain(String(id));
    expect(text).not.toContain(map.salt);
    expect(text).not.toContain(out.map.salt);
  });

  it('round-trips the sidecar privately and reports a missing one', async () => {
    const dir = await createScratchDir('tests', 'fixture-map');
    const path = fixtureMapPath('o/r', 7, { OSSTACK_FIXTURE_MAP_DIR: join(dir, 'maps') });
    expect(path).toBe(join(dir, 'maps', 'o-r-7.json'));
    expect(await readFixtureMap(path)).toBeUndefined();
    const { map } = pseudonymizeSnapshot(snapshot, registry);
    await writeFixtureMap(path, map);
    expect(await readFixtureMap(path)).toEqual(map);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe('digest salting and refs', () => {
  const withDigest = (digest: string | null, base_ref = 'main'): PrSnapshot => ({ ...snapshot, base_ref, reviews: [{ ...snapshot.reviews[1]!, feedback_digest: digest }] });

  it('replaces digests with a salted HMAC: equal inside a file, different across salts, never the raw digest', () => {
    const map = newFixtureMap('00'.repeat(32));
    const a = pseudonymizeSnapshot(withDigest('c'.repeat(64)), registry, map).snapshot.reviews[0]!.feedback_digest;
    const b = pseudonymizeSnapshot(withDigest('c'.repeat(64)), registry, map).snapshot.reviews[0]!.feedback_digest;
    const c = pseudonymizeSnapshot(withDigest('c'.repeat(64)), registry, newFixtureMap('11'.repeat(32))).snapshot.reviews[0]!.feedback_digest;
    expect(a).toBe(b);
    expect(a).not.toBe('c'.repeat(64));
    expect(c).not.toBe(a);
    expect(pseudonymizeSnapshot(withDigest(null), registry).snapshot.reviews[0]!.feedback_digest).toBeNull();
  });

  it('keeps main and pseudonymises every other base ref consistently', () => {
    expect(pseudonymizeSnapshot(withDigest(null, 'main'), registry).snapshot.base_ref).toBe('main');
    const one = pseudonymizeSnapshot(withDigest(null, 'feature/secret-login'), registry);
    expect(one.snapshot.base_ref).toBe('ref1');
    const two = pseudonymizeSnapshot(withDigest(null, 'other'), registry, one.map);
    expect(two.snapshot.base_ref).toBe('ref2');
    expect(pseudonymizeSnapshot(withDigest(null, 'feature/secret-login'), registry, two.map).snapshot.base_ref).toBe('ref1');
    expect(JSON.stringify(one.snapshot)).not.toContain('secret');
  });
});
