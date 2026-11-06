import type { PrSnapshot, ProducerRegistry } from '@osstack/core';
import { describe, expect, it } from 'vitest';
import { assertFixtureFile, fixtureWith, pseudonymizeSnapshot, scanForLeaks } from './contained-mission-bridge-fixture.js';

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
    const ref = good(); ref.snapshots[0]!.base_ref = 'https://x.example/@y';
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
