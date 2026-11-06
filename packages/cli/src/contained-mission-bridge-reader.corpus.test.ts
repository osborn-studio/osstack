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
import { describe, expect, it } from 'vitest';
import { type FixtureFile, assertFixtureFile } from './contained-mission-bridge-fixture.js';

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
  it('has the whole recorded corpus (#340-#363), one snapshot per file', () => {
    expect(loaded).toHaveLength(24);
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
