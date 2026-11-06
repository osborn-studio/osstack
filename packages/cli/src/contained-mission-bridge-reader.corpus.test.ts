// Historical decision corpus (appendix §5.4, PR 4-C): osborn-studio/osstack #340-#363, one exact snapshot recorded per PR.
// These PRs are merged and none is a Mission PR, so the corpus validates the pure decision function and the reviewer
// reduction on real review shapes only. It cannot validate chain discovery, head attribution, past points in time
// (GraphQL cannot reconstruct them) or the end-to-end shadow run: those belong to the sandbox corpus (4-D).
//
// Two evaluations per file:
//  1. as recorded: pr_state MERGED at observed_at, which must close the chain;
//  2. pr_state forced to OPEN, evaluated at a replay clock one millisecond after the newest review on the head, because at the
//     recording time every historical review is past the 24h review TTL and selection would be vacuous.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type ChainDecision,
  type ChainView,
  type DiscardReason,
  type PrSnapshot,
  decideChainStep,
  reduceReviewers,
  sameProducer,
} from '@osstack/core';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { feedbackDigest, normalizeSnapshot, readPullRequest } from './contained-mission-bridge-reader.js';
import { type FixtureFile, assertFixtureFile, newFixtureMap, pseudonymizeSnapshot } from './contained-mission-bridge-fixture.js';

const dir = new URL('./__fixtures__/bridge/', import.meta.url);
const files = readdirSync(fileURLToPath(dir)).filter((f) => f.endsWith('.json')).sort((a, b) => Number(/-(\d+)\.json$/u.exec(a)?.[1]) - Number(/-(\d+)\.json$/u.exec(b)?.[1]));
const loaded = files.map((name) => ({ name, file: assertFixtureFile(JSON.parse(readFileSync(new URL(name, dir), 'utf8'))) as FixtureFile }));

const DISCARDS: ReadonlySet<DiscardReason> = new Set<DiscardReason>([
  'snapshot_incomplete', 'snapshot_moved', 'head_mismatch', 'base_changed', 'unregistered_reviewer',
  'no_feedback', 'reviewer_conflict', 'expired', 'head_already_reserved',
]);

const chainFor = (s: PrSnapshot): ChainView => ({
  mode: 'shadow', state: 'awaiting_review', published_head: s.head, published_base: s.base_sha, base_ref: s.base_ref,
  rounds_used: 0, grant_rounds: null, review_deadline: null, reserved_heads: [],
});
const replayClock = (s: PrSnapshot): number =>
  Math.max(0, ...s.reviews.filter((r) => r.review_commit === s.head).map((r) => r.submitted_at)) + 1;
const summarize = (d: ChainDecision) => ({
  kind: d.kind,
  ...(d.kind === 'none' ? { reason: d.reason } : { reason: 'reason' in d ? d.reason : undefined, to: 'to' in d ? d.to : undefined }),
  shadow_action: 'shadow_action' in d ? d.shadow_action : undefined,
  review_ids: 'review_ids' in d ? d.review_ids : undefined,
  discards: d.discards.map((x) => `${x.review_id}:${x.reason}`),
});

describe('historical decision corpus', () => {
  it('has exactly PRs 340-363, one snapshot per file', () => {
    expect(loaded.map((l) => l.name)).toEqual(Array.from({ length: 24 }, (_, i) => `osborn-studio-osstack-${340 + i}.json`));
    for (const { file } of loaded) expect(file.snapshots).toHaveLength(1);
  });

  const regular: Record<string, unknown> = {};
  const forcedOpen: Record<string, unknown> = {};

  describe.each(loaded)('$name', ({ name, file }) => {
    const registry = file.registry;
    const recorded = file.snapshots[0]!;
    const open: PrSnapshot = { ...recorded, pr_state: 'OPEN' };
    const registered = (r: PrSnapshot['reviews'][number]) => registry.reviewers.some((p) => sameProducer(p, r.reviewer));

    it('closes the chain as recorded (merged)', () => {
      const d = decideChainStep(chainFor(recorded), recorded, registry, recorded.observed_at);
      expect(d).toMatchObject({ kind: 'transition', to: 'closed', reason: 'pr_merged' });
      regular[name] = summarize(d);
    });

    it('selects within the invariants when forced OPEN at the replay clock', () => {
      const now = replayClock(open);
      const d = decideChainStep(chainFor(open), open, registry, now);
      forcedOpen[name] = summarize(d);
      // No unclassified discard reason, and no read failure.
      for (const x of d.discards) expect(DISCARDS.has(x.reason)).toBe(true);
      expect(d).not.toMatchObject({ reason: 'snapshot_incomplete' });
      const ids = 'review_ids' in d ? d.review_ids : [];
      const reservations = d.kind === 'would_reserve' ? 1 : 0;
      // At most one would_reserve per head (a single snapshot has a single head).
      expect(reservations).toBeLessThanOrEqual(1);
      // Every review used for would_reserve / would_mark_ready comes from a registered reviewer and is bound to the snapshot head.
      if (d.kind === 'would_reserve' || (d.kind === 'transition' && d.shadow_action === 'would_mark_ready')) {
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) {
          const review = open.reviews.find((r) => r.review_id === id)!;
          expect(registered(review)).toBe(true);
          expect(review.review_commit).toBe(open.head);
        }
      }
      // Every recorded review is either used or discarded for a classified reason, or is a state that carries no weight.
      const discarded = new Set(d.discards.map((x) => x.review_id));
      for (const r of open.reviews) {
        if (r.review_commit !== open.head && registered(r)) expect(discarded.has(r.review_id)).toBe(true);
      }
    });

    it('reduces reviewers per historical head using only reviews on that head', () => {
      const heads = new Set(recorded.reviews.map((r) => r.review_commit));
      for (const head of heads) {
        // now=0 keeps the 24h expiry out of the picture: this asserts reduction only.
        const { participating, discards } = reduceReviewers(head, recorded.reviews, registry, 0);
        for (const { review, state } of participating.values()) {
          expect(review.review_commit).toBe(head);
          expect(state === 'APPROVED' || state === 'CHANGES_REQUESTED').toBe(true);
          expect(registered(review)).toBe(true);
        }
        for (const x of discards) expect(DISCARDS.has(x.reason)).toBe(true);
        const other = recorded.reviews.filter((r) => r.review_commit !== head && registered(r));
        expect(discards.filter((x) => x.reason === 'head_mismatch').map((x) => x.review_id).sort()).toEqual(other.map((r) => r.review_id).sort());
      }
    });
  });

  it('keeps the decisions stable (regression snapshot)', () => {
    expect({ as_recorded: regular, forced_open: forcedOpen }).toMatchSnapshot();
  });
});

// Hand-checked facts. These expectations were read off the recorded reviews by a person (review ids, states and commits as
// GitHub reported them, reviewer pseudonyms as numbered by the ADR-005 registry order) and do not call the decision code to
// produce their expected values.
describe('hand-checked corpus facts', () => {
  const pr = (n: number) => loaded.find((l) => l.name.endsWith(`-${n}.json`))!.file;
  const open = (n: number) => ({ ...pr(n).snapshots[0]!, pr_state: 'OPEN' as const });
  const participants = (n: number, headPrefix: string) => {
    const f = pr(n);
    const head = f.snapshots[0]!.reviews.map((r) => r.review_commit).find((c) => c.startsWith(headPrefix))!;
    const { participating } = reduceReviewers(head, f.snapshots[0]!.reviews, f.registry, 0);
    return [...participating.entries()].map(([actor, v]) => [actor, v.state, v.review.review_id]).sort();
  };
  const decide = (n: number) => {
    const snap = open(n);
    return summarize(decideChainStep(chainFor(snap), snap, pr(n).registry, replayClock(snap)));
  };
  const ready = (ids: number[], discards: string[]) => ({
    kind: 'transition', reason: 'all_participating_approved', to: 'ready_for_human', shadow_action: 'would_mark_ready', review_ids: ids, discards,
  });

  it('#340 (simple): one approval from reviewer 2', () => {
    expect(pr(340).snapshots[0]!.head.startsWith('52a8616')).toBe(true);
    expect(participants(340, '52a8616')).toEqual([[2, 'APPROVED', 5725712517]]);
    expect(decide(340)).toEqual(ready([5725712517], []));
  });

  it('#345 (DISMISSED): the dismissed review is on the old head 8e4e12b; only the head approval counts', () => {
    expect(participants(345, '11ee8ae')).toEqual([[3, 'APPROVED', 5724335109]]);
    expect(participants(345, '8e4e12b')).toEqual([]);
    expect(decide(345)).toEqual(ready([5724335109], ['5724194737:head_mismatch']));
  });

  it('#352 (several reviewers): two reviewers both approve the head', () => {
    expect(participants(352, 'c9b2bd6')).toEqual([[2, 'APPROVED', 5725716794], [3, 'APPROVED', 5725302936]]);
    expect(decide(352)).toEqual(ready([5725302936, 5725716794], []));
  });

  it('#353 (five DISMISSED reviews on the old head 48549cd, one approval on the head)', () => {
    expect(participants(353, '8b685dc')).toEqual([[3, 'APPROVED', 5725870248]]);
    expect(participants(353, '48549cd')).toEqual([]);
    expect(decide(353)).toEqual(ready([5725870248], [5725558051, 5725719902, 5725724998, 5725730826, 5725790142].map((id) => `${id}:head_mismatch`)));
  });
});

describe('synthetic read -> normalize -> pseudonymize against a hand-written fixture', () => {
  const HEAD = '1'.repeat(40);
  const BASE = '2'.repeat(40);
  const page = {
    data: { repository: { pullRequest: {
      state: 'OPEN', merged: false, closed: false, headRefName: 'topic', headRefOid: HEAD, headRepository: { nameWithOwner: 'o/r' }, baseRefName: 'release-9', baseRefOid: BASE,
      reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
        { databaseId: 7, state: 'CHANGES_REQUESTED', submittedAt: '2026-11-01T00:00:10Z', commit: { oid: HEAD }, author: { __typename: 'User', databaseId: 900 }, body: 'fix it\r\n' },
        { databaseId: 8, state: 'APPROVED', submittedAt: '2026-11-01T00:00:20Z', commit: { oid: HEAD }, author: { __typename: 'User', databaseId: 500 }, body: '' },
      ] },
      reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'T', isResolved: false, comments: { pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ databaseId: 70, pullRequestReview: { databaseId: 7 }, body: 'here', author: { __typename: 'User', databaseId: 900 } }] } }] },
      commits: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ commit: { oid: HEAD } }] },
      timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    } } },
  };

  it('produces exactly the hand-written fixture', async () => {
    const registry = { publisher: [{ actor_id: 1, app_id: null }], reviewers: [{ actor_id: 500, app_id: null }] };
    const read = await readPullRequest(async () => page, { owner: 'o', name: 'r', number: 1 });
    const snapshot = normalizeSnapshot(read, registry, 1_800_000_000_000);
    const map = newFixtureMap('ab'.repeat(32));
    const out = pseudonymizeSnapshot(snapshot, registry, map);
    const digest = createHmac('sha256', Buffer.from('ab'.repeat(32), 'hex')).update(feedbackDigest('fix it', [{ threadId: 'T', databaseId: 70, body: 'here' }])).digest('hex');
    expect(out.registry).toEqual({ publisher: [{ actor_id: 1, app_id: null }], reviewers: [{ actor_id: 2, app_id: null }] });
    expect(out.snapshot).toEqual({
      pr_state: 'OPEN', head: HEAD, base_sha: BASE, base_ref: 'ref1', observed_at: 1_800_000_000_000, complete: true, moved: false,
      reviews: [
        { review_id: 7, state: 'CHANGES_REQUESTED', submitted_at: Date.parse('2026-11-01T00:00:10Z'), review_commit: HEAD, reviewer: { actor_id: 3, app_id: null }, has_feedback: true, feedback_digest: digest },
        { review_id: 8, state: 'APPROVED', submitted_at: Date.parse('2026-11-01T00:00:20Z'), review_commit: HEAD, reviewer: { actor_id: 2, app_id: null }, has_feedback: false, feedback_digest: null },
      ],
    });
  });
});
