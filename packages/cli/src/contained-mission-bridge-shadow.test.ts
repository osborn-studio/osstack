import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  decideChainStep,
  shadowChainWriter,
  sameProducer,
  type DiscardReason,
  type PrSnapshot,
  type RevisionChain,
  type SnapshotReview,
} from '@osstack/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProducerRegistryConfig } from './contained-mission-bridge-registry.js';
import { assertFixtureFile, type FixtureFile } from './contained-mission-bridge-fixture.js';
import { ShadowReconciler, createShadowMissionView } from './contained-mission-bridge-shadow.js';
import { createRig, oid, scriptedTransport, type Rig, type ScriptedOptions, type ScriptedPr } from './contained-mission-bridge-shadow.testkit.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); cleanup.splice(0).forEach((fn) => { fn(); }); });

const MIN = 60_000;
const DISCARDS: ReadonlySet<DiscardReason> = new Set<DiscardReason>([
  'snapshot_incomplete', 'snapshot_moved', 'head_mismatch', 'base_changed', 'unregistered_reviewer',
  'no_feedback', 'reviewer_conflict', 'expired', 'head_already_reserved',
]);

interface Harness {
  rig: Rig;
  reconciler: ShadowReconciler;
  logs: string[];
  clock: { now: number };
  events: (chain: RevisionChain) => Array<{ kind: string; payload: Record<string, unknown> }>;
  chain: (missionId: string) => RevisionChain;
}

function harness(registry: ProducerRegistryConfig, prFor: (variables: Record<string, unknown>) => ScriptedPr, start: number, options: ScriptedOptions = {}, rig: Rig = createRig()) {
  cleanup.push(() => { rig.close(); });
  const clock = { now: start };
  const logs: string[] = [];
  const t = scriptedTransport(prFor, options);
  const reconciler = new ShadowReconciler({
    missions: createShadowMissionView(rig.missions), chains: shadowChainWriter(rig.chains), transport: t.transport, registry,
    now: () => clock.now, log: (line) => { logs.push(line); },
  });
  const events = (chain: RevisionChain) => rig.chains.events(chain.chain_id, 0, 500).map((e) => ({ kind: e.kind, payload: JSON.parse(e.payload_json) as Record<string, unknown> }));
  const chain = (missionId: string) => rig.chains.chainForMission(missionId, 'shadow')!;
  const h: Harness = { rig, reconciler, logs, clock, events, chain };
  return { ...h, t };
}

// ---------------------------------------------------------------------------------------------------------------------
// (a) historical decision corpus replayed through the reconciler

const dir = new URL('./__fixtures__/bridge/', import.meta.url);
const files = readdirSync(fileURLToPath(dir)).filter((f) => f.endsWith('.json')).sort((a, b) => Number(/-(\d+)\.json$/u.exec(a)?.[1]) - Number(/-(\d+)\.json$/u.exec(b)?.[1]));
const loaded = files.map((name) => ({ name, file: assertFixtureFile(JSON.parse(readFileSync(new URL(name, dir), 'utf8'))) as FixtureFile }));

const replayClock = (s: PrSnapshot): number => Math.max(0, ...s.reviews.filter((r) => r.review_commit === s.head).map((r) => r.submitted_at)) + 1;
const registryOf = (file: FixtureFile): ProducerRegistryConfig => ({ repository: 'o/r', publisher: file.registry.publisher, reviewers: file.registry.reviewers });
const prOf = (file: FixtureFile, over: Partial<ScriptedPr> = {}): ScriptedPr => {
  const s = file.snapshots[0]!;
  return { state: s.pr_state, head: s.head, base_sha: s.base_sha, base_ref: s.base_ref, author: file.registry.publisher[0]!, reviews: s.reviews.map((r) => ({ ...r })), ...over };
};

describe('historical corpus through the shadow reconciler', () => {
  it('has the 24 recorded PRs', () => {
    expect(loaded).toHaveLength(24);
  });

  const sequences: Record<string, unknown> = {};

  describe.each(loaded)('$name', ({ name, file }) => {
    const registry = registryOf(file);
    const recorded = file.snapshots[0]!;
    const registered = (r: SnapshotReview) => registry.reviewers.some((p) => sameProducer(p, r.reviewer));

    it('discovers the Mission PR and closes the chain when the recorded PR is merged', async () => {
      const pr = prOf(file);
      const h = harness(registry, () => pr, recorded.observed_at);
      const id = h.rig.seedMission({ pr_number: 1, head: recorded.head, base_head: recorded.base_sha, base_ref: recorded.base_ref });
      await h.reconciler.scan();
      const chain = h.chain(id);
      expect(chain).toMatchObject({ mode: 'shadow', state: 'closed', published_head: recorded.head, published_base: recorded.base_sha, rounds_used: 0 });
      expect(h.rig.chains.shadowDecisions(chain.chain_id)).toEqual([]);
      expect(h.events(chain).map((e) => e.kind)).toEqual(['chain_created', 'transition', 'observation_cycle']);
      expect(h.t.queries.every((q) => !/mutation/iu.test(q))).toBe(true);
    });

    it('records within the section 5.4 invariants when the PR is forced open at the replay clock', async () => {
      const forced = prOf(file, { state: 'OPEN' });
      const now = replayClock({ ...recorded, pr_state: 'OPEN' });
      const h = harness(registry, () => forced, now);
      const id = h.rig.seedMission({ pr_number: 1, head: recorded.head, base_head: recorded.base_sha, base_ref: recorded.base_ref });

      await h.reconciler.scan();
      const first = h.chain(id);
      const rows = h.rig.chains.shadowDecisions(first.chain_id);
      const expected = decideChainStep(
        { mode: 'shadow', state: 'awaiting_review', published_head: recorded.head, published_base: recorded.base_sha, base_ref: recorded.base_ref, rounds_used: 0, grant_rounds: null, review_deadline: null, reserved_heads: [] },
        { ...recorded, pr_state: 'OPEN' }, registry, now);

      // Same observable outcome as the pure function on the same snapshot.
      if (expected.kind === 'would_reserve') expect(rows.map((r) => r.action)).toEqual(['would_reserve']);
      else if (expected.kind === 'transition' && expected.shadow_action === 'would_mark_ready') expect(rows.map((r) => r.action)).toEqual(['would_mark_ready']);
      else expect(rows).toEqual([]);

      // Every would_reserve / would_mark_ready review is a registered reviewer's, bound to the head and the base.
      for (const row of rows) {
        expect(row.head_sha).toBe(recorded.head);
        expect(row.base_sha).toBe(recorded.base_sha);
        const ids = JSON.parse(row.review_ids_json) as number[];
        expect(ids.length).toBeGreaterThan(0);
        for (const rid of ids) {
          const review = recorded.reviews.find((r) => r.review_id === rid)!;
          expect(registered(review)).toBe(true);
          expect(review.review_commit).toBe(recorded.head);
        }
      }
      // At most one would_reserve per head; no read failure; every discard has a known reason.
      expect(rows.filter((r) => r.action === 'would_reserve').length).toBeLessThanOrEqual(1);
      const events1 = h.events(first);
      expect(events1.some((e) => e.kind === 'read_failed')).toBe(false);
      for (const e of events1.filter((x) => x.kind === 'observation_cycle')) {
        for (const d of e.payload['discards'] as string[]) expect(DISCARDS.has(d.split(':')[1] as DiscardReason)).toBe(true);
      }

      // A second identical cycle writes no second decision row.
      h.clock.now += 5 * MIN;
      const before = h.rig.chains.shadowDecisions(first.chain_id).length;
      await h.reconciler.scan();
      expect(h.rig.chains.shadowDecisions(first.chain_id)).toHaveLength(before);

      // A head change stops the chain (attribution unknown) and never produces another would_reserve.
      const wasReserved = h.rig.chains.shadowDecisions(first.chain_id).filter((r) => r.action === 'would_reserve').length;
      forced.head = oid('9');
      h.clock.now += 5 * MIN;
      await h.reconciler.scan();
      const stopped = h.chain(id);
      expect(stopped).toMatchObject({ state: 'awaiting_decision', stop_reason: 'attribution_unknown' });
      expect(h.rig.chains.shadowDecisions(stopped.chain_id).filter((r) => r.action === 'would_reserve')).toHaveLength(wasReserved);
      h.clock.now += 5 * MIN;
      await h.reconciler.scan();
      expect(h.rig.chains.shadowDecisions(stopped.chain_id).filter((r) => r.action === 'would_reserve')).toHaveLength(wasReserved);
      expect(h.events(stopped).some((e) => e.kind === 'read_failed')).toBe(false);
      expect(h.t.queries.every((q) => !/mutation/iu.test(q))).toBe(true);

      sequences[name] = {
        decisions: h.rig.chains.shadowDecisions(stopped.chain_id).map((r) => ({ action: r.action, reason: r.reason, review_ids: JSON.parse(r.review_ids_json) as number[] })),
        events: h.events(stopped).map((e) => ({ kind: e.kind, ...(e.kind === 'observation_cycle' ? { decision: e.payload['decision'], reason: e.payload['reason'], action: e.payload['action'], discards: e.payload['discards'] } : {}) })),
      };
    });
  });

  it('keeps the shadow event sequences stable (regression snapshot)', () => {
    expect(sequences).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// (b) scripted synthetic sandbox Mission time series (the real sandbox recording is a later step)

const PUBLISHER = { actor_id: 501, app_id: 11 };
const REVIEWER = { actor_id: 502, app_id: 12 };
const SANDBOX: ProducerRegistryConfig = { repository: 'o/r', publisher: [PUBLISHER], reviewers: [REVIEWER] };
const T0 = 1_800_000_000_000;
const review = (id: number, state: SnapshotReview['state'], head: string, at: number, feedback = state === 'CHANGES_REQUESTED'): SnapshotReview => ({
  review_id: id, state, submitted_at: at, review_commit: head, reviewer: REVIEWER, has_feedback: feedback, feedback_digest: feedback ? 'f'.repeat(64) : null,
});
const sandboxPr = (over: Partial<ScriptedPr> = {}): ScriptedPr => ({ state: 'OPEN', head: oid('1'), base_sha: oid('a'), base_ref: 'main', author: PUBLISHER, reviews: [], ...over });

describe('synthetic sandbox Mission time series', () => {
  it('walks open -> changes requested -> would_reserve -> idempotent -> head moved -> stopped', async () => {
    const pr = sandboxPr();
    const h = harness(SANDBOX, () => pr, T0);
    const id = h.rig.seedMission({ pr_number: 13, head: oid('1'), base_head: oid('a') });

    await h.reconciler.scan(); // t0: first sight
    let chain = h.chain(id);
    expect(chain).toMatchObject({ state: 'awaiting_review', repository: 'o/r', pr_number: 13, branch: expect.stringMatching(/^osstack\/mission\//u), base_ref: 'main' });
    expect(h.events(chain).map((e) => e.kind)).toEqual(['chain_created', 'observation_cycle']);
    expect(h.events(chain)[1]!.payload).toMatchObject({ decision: 'none', reason: 'no_review' });
    expect(h.t.counts()).toEqual({ reads: 1, second: 0 });

    pr.reviews.push(review(9001, 'CHANGES_REQUESTED', oid('1'), T0 + 4 * MIN));
    h.clock.now = T0 + 5 * MIN;
    await h.reconciler.scan(); // changes requested with feedback -> would_reserve after a second read
    chain = h.chain(id);
    expect(chain.state).toBe('awaiting_review');
    expect(chain.rounds_used).toBe(0);
    expect(h.rig.chains.shadowDecisions(chain.chain_id)).toMatchObject([{ action: 'would_reserve', head_sha: oid('1'), base_sha: oid('a'), review_ids_json: '[9001]' }]);
    expect(h.t.counts()).toEqual({ reads: 2, second: 1 });

    h.clock.now = T0 + 7 * MIN;
    await h.reconciler.scan(); // less than five minutes after the last read: nothing is read
    expect(h.t.counts()).toEqual({ reads: 2, second: 1 });

    h.clock.now = T0 + 10 * MIN;
    const eventsBefore = h.events(chain).length;
    await h.reconciler.scan(); // identical cycle: no duplicate row
    expect(h.rig.chains.shadowDecisions(chain.chain_id)).toHaveLength(1);
    expect(h.events(chain)).toHaveLength(eventsBefore + 1);
    expect(h.events(chain).at(-1)!.payload).toMatchObject({ decision: 'none', reason: 'head_already_reserved' });
    expect(h.t.counts()).toEqual({ reads: 3, second: 1 });

    pr.head = oid('2'); // somebody pushed
    h.clock.now = T0 + 16 * MIN;
    await h.reconciler.scan();
    chain = h.chain(id);
    expect(chain).toMatchObject({ state: 'awaiting_decision', stop_reason: 'attribution_unknown', published_head: oid('1') });
    expect(h.rig.chains.shadowDecisions(chain.chain_id).map((r) => [r.action, r.head_sha])).toEqual([['would_reserve', oid('1')], ['would_stop', oid('2')]]);

    h.clock.now = T0 + 30 * MIN;
    await h.reconciler.scan(); // a stopped chain is not read again
    expect(h.t.counts()).toEqual({ reads: 4, second: 1 });
  });

  it('stops on a base change, closes on PR close, marks ready on approval and does not duplicate it', async () => {
    const base = sandboxPr();
    const h = harness(SANDBOX, (v) => ({ ...base, ...(v['number'] === 14 ? changed : v['number'] === 15 ? closed : approved) }), T0);
    const changed: Partial<ScriptedPr> = {};
    const closed: Partial<ScriptedPr> = {};
    const approved: Partial<ScriptedPr> = { reviews: [review(9100, 'APPROVED', oid('1'), T0 + MIN, false)] };
    const a = h.rig.seedMission({ pr_number: 14, head: oid('1'), base_head: oid('a') });
    const b = h.rig.seedMission({ pr_number: 15, head: oid('1'), base_head: oid('a') });
    const c = h.rig.seedMission({ pr_number: 16, head: oid('1'), base_head: oid('a') });
    await h.reconciler.scan();
    expect(h.chain(a).state).toBe('awaiting_review');
    expect(h.chain(b).state).toBe('awaiting_review');
    expect(h.chain(c)).toMatchObject({ state: 'ready_for_human' });
    expect(h.rig.chains.shadowDecisions(h.chain(c).chain_id).map((r) => r.action)).toEqual(['would_mark_ready']);

    changed.base_sha = oid('b');
    closed.state = 'MERGED';
    h.clock.now = T0 + 5 * MIN;
    await h.reconciler.scan();
    expect(h.chain(a)).toMatchObject({ state: 'awaiting_decision', stop_reason: 'base_changed' });
    expect(h.rig.chains.shadowDecisions(h.chain(a).chain_id).map((r) => [r.action, r.base_sha])).toEqual([['would_stop', oid('b')]]);
    expect(h.chain(b)).toMatchObject({ state: 'closed' });
    expect(h.events(h.chain(b)).find((e) => e.kind === 'transition')!.payload).toMatchObject({ to: 'closed', reason: 'pr_merged' });
    expect(h.rig.chains.shadowDecisions(h.chain(c).chain_id)).toHaveLength(1);
    expect(h.events(h.chain(c)).at(-1)!.payload).toMatchObject({ decision: 'none', reason: 'already_ready' });
  });

  it('discards a decision when the second read sees the review move', async () => {
    const pr = sandboxPr({ reviews: [review(9200, 'CHANGES_REQUESTED', oid('1'), T0 - MIN)] });
    let flip = true;
    const h = harness(SANDBOX, () => pr, T0, { before: (kind, p) => { if (kind === 'second' && flip) { p.reviews = [review(9200, 'DISMISSED', oid('1'), T0 - MIN, false)]; flip = false; } } });
    const id = h.rig.seedMission({ pr_number: 17, head: oid('1'), base_head: oid('a') });
    await h.reconciler.scan();
    const chain = h.chain(id);
    expect(h.rig.chains.shadowDecisions(chain.chain_id)).toEqual([]);
    expect(h.events(chain).at(-1)!.payload).toMatchObject({ decision: 'none', reason: 'snapshot_moved' });
    // The next cycle sees the new state and decides on it.
    h.clock.now = T0 + 5 * MIN;
    await h.reconciler.scan();
    expect(h.rig.chains.shadowDecisions(chain.chain_id)).toEqual([]);
    expect(h.events(chain).at(-1)!.payload).toMatchObject({ decision: 'none', reason: 'no_review' });
  });

  it('records a fixed-code read_failed event and leaves the chain unchanged on read errors', async () => {
    const pr = sandboxPr();
    let mode: 'ok' | 'throw' | 'errors' | 'garbage' = 'ok';
    const h = harness(SANDBOX, () => pr, T0, {
      before: (kind) => { if (kind === 'read' && mode === 'throw') throw new Error('network down https://x-access-token:ghs_secretsecretsecret1234567890@github.com'); },
      override: (kind) => (kind === 'read' && mode === 'errors' ? { errors: [{ message: 'secret detail' }] } : kind === 'read' && mode === 'garbage' ? { data: { repository: 'x' } } : undefined),
    });
    const id = h.rig.seedMission({ pr_number: 18, head: oid('1'), base_head: oid('a') });
    await h.reconciler.scan();
    const created = h.chain(id);

    for (const [m, code] of [['throw', 'request_failed'], ['errors', 'graphql_errors'], ['garbage', 'malformed_response']] as const) {
      mode = m;
      h.clock.now += 5 * MIN;
      await h.reconciler.scan();
      const after = h.chain(id);
      expect(after).toMatchObject({ state: created.state, revision: created.revision, published_head: created.published_head });
      expect(h.events(after).at(-1)).toEqual({ kind: 'read_failed', payload: { code } });
    }
    const serialised = JSON.stringify(h.events(h.chain(id)));
    expect(serialised).not.toMatch(/secret|ghs_|x-access-token|network down/u);
    mode = 'ok';
    h.clock.now += 5 * MIN;
    await h.reconciler.scan();
    expect(h.events(h.chain(id)).at(-1)!.kind).toBe('observation_cycle');
  });

  it('records read_failed(second_read_failed), not a movement, when the confirmation cannot be read', async () => {
    const pr = sandboxPr({ reviews: [review(9300, 'CHANGES_REQUESTED', oid('1'), T0 - MIN)] });
    let fail = true;
    const h = harness(SANDBOX, () => pr, T0, { before: (kind) => { if (kind === 'second' && fail) throw new Error('timeout'); } });
    const id = h.rig.seedMission({ pr_number: 19, head: oid('1'), base_head: oid('a') });
    await h.reconciler.scan();
    const chain = h.chain(id);
    expect(h.events(chain).at(-1)).toEqual({ kind: 'read_failed', payload: { code: 'second_read_failed' } });
    expect(h.events(chain).filter((e) => e.kind === 'observation_cycle')).toEqual([]);
    expect(h.rig.chains.shadowDecisions(chain.chain_id)).toEqual([]);
    expect(chain).toMatchObject({ state: 'awaiting_review', revision: 1 });
    fail = false;
    h.clock.now += 5 * MIN;
    await h.reconciler.scan();
    expect(h.rig.chains.shadowDecisions(h.chain(id).chain_id).map((r) => r.action)).toEqual(['would_reserve']);
  });

  it('first scans a full read gap after start(), so a restart never rereads sooner than the gap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const h = harness(SANDBOX, () => sandboxPr(), T0);
    h.rig.seedMission({ pr_number: 60, head: oid('1'), base_head: oid('a') });
    h.reconciler.start();
    await vi.advanceTimersByTimeAsync(5 * MIN - 1);
    expect(h.t.counts().reads).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.t.counts().reads).toBe(1);
    h.clock.now += 5 * MIN;
    h.reconciler.start(); // a second start() never adds a second timer loop
    h.reconciler.start();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(h.t.counts().reads).toBe(2);
    await h.reconciler.stop();
  });

  it('bounds a scan to ten chain reads, discovers at most five Missions per scan and resumes from a cursor', async () => {
    const pr = sandboxPr();
    const h = harness(SANDBOX, () => pr, T0);
    const ids = Array.from({ length: 12 }, (_, i) => h.rig.seedMission({ pr_number: 100 + i, head: oid('1'), base_head: oid('a') }));
    const known = () => ids.filter((id) => h.rig.chains.chainForMission(id, 'shadow')).length;
    await h.reconciler.scan();
    expect([known(), h.t.counts().reads]).toEqual([5, 5]);
    await h.reconciler.scan();
    expect([known(), h.t.counts().reads]).toEqual([10, 10]);
    await h.reconciler.scan(); // the last two; chains read at this instant are not due again
    expect([known(), h.t.counts().reads]).toEqual([12, 12]);
    h.clock.now += 5 * MIN;
    await h.reconciler.scan(); // at most ten chains per scan
    expect(h.t.counts().reads).toBe(22);
    await h.reconciler.scan(); // the cursor continues with the remaining two
    expect(h.t.counts().reads).toBe(24);
  });

  it('reads exactly ten chains every five minutes, with no empty scan at the page boundary', async () => {
    const h = harness(SANDBOX, () => sandboxPr(), T0);
    for (let i = 0; i < 10; i++) h.rig.seedMission({ pr_number: 200 + i, head: oid('1'), base_head: oid('a') });
    await h.reconciler.scan();
    await h.reconciler.scan();
    expect(h.t.counts().reads).toBe(10);
    for (let round = 2; round <= 4; round++) {
      h.clock.now += 5 * MIN;
      await h.reconciler.scan();
      expect(h.t.counts().reads).toBe(10 * round);
    }
  });

  it('shares one ten-read budget between first sights and chain cycles', async () => {
    const h = harness(SANDBOX, () => sandboxPr(), T0);
    const first = Array.from({ length: 10 }, (_, i) => h.rig.seedMission({ pr_number: 300 + i, head: oid('1'), base_head: oid('a') }));
    await h.reconciler.scan();
    await h.reconciler.scan();
    expect(h.t.counts().reads).toBe(10);
    const second = Array.from({ length: 10 }, (_, i) => h.rig.seedMission({ pr_number: 400 + i, head: oid('1'), base_head: oid('a') }));
    h.clock.now += 5 * MIN;
    const before = h.t.counts().reads;
    await h.reconciler.scan(); // ten chains are due and ten Missions are new: still ten reads, split between the two
    expect(h.t.counts().reads - before).toBe(10);
    expect(second.filter((id) => h.rig.chains.chainForMission(id, 'shadow'))).toHaveLength(5);
    expect(first.filter((id) => h.events(h.chain(id)).filter((e) => e.kind === 'observation_cycle').length === 2)).toHaveLength(5);
  });

  it('keeps observing existing chains while new Missions keep failing to read', async () => {
    const pr = sandboxPr();
    const h = harness(SANDBOX, (v) => { if ((v['number'] as number) >= 500) throw new Error('down'); return pr; }, T0);
    const existing = h.rig.seedMission({ pr_number: 99, head: oid('1'), base_head: oid('a') });
    await h.reconciler.scan();
    for (let i = 0; i < 10; i++) h.rig.seedMission({ pr_number: 500 + i, head: oid('1'), base_head: oid('a') });
    for (let round = 1; round <= 4; round++) {
      h.clock.now += 5 * MIN;
      await h.reconciler.scan();
      expect(h.events(h.chain(existing)).filter((e) => e.kind === 'observation_cycle')).toHaveLength(1 + round);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// (d) chain discovery rules

describe('chain discovery', () => {
  it('creates one chain when two Missions point at the same PR', async () => {
    const h = harness(SANDBOX, () => sandboxPr(), T0);
    const first = h.rig.seedMission({ pr_number: 20, head: oid('1'), base_head: oid('a') });
    const second = h.rig.seedMission({ pr_number: 20, head: oid('1'), base_head: oid('a') });
    await h.reconciler.scan();
    expect(h.rig.chains.chainForMission(first, 'shadow')).toBeDefined();
    expect(h.rig.chains.chainForMission(second, 'shadow')).toBeUndefined();
    expect(h.logs.some((l) => l.includes(`skip mission=${second} reason=pr_has_shadow_chain`))).toBe(true);
    expect(h.t.counts().reads).toBe(1);
    // The duplicate is remembered and never read.
    h.clock.now += 10 * MIN;
    await h.reconciler.scan();
    expect(h.rig.chains.chainForMission(second, 'shadow')).toBeUndefined();
  });

  it('still refuses the second Mission once the first chain has stopped', async () => {
    const pr = sandboxPr();
    const h = harness(SANDBOX, () => pr, T0);
    const first = h.rig.seedMission({ pr_number: 21, head: oid('1'), base_head: oid('a') });
    await h.reconciler.scan();
    pr.head = oid('3');
    h.clock.now += 5 * MIN;
    await h.reconciler.scan();
    expect(h.chain(first).state).toBe('awaiting_decision');
    const second = h.rig.seedMission({ pr_number: 21, head: oid('3'), base_head: oid('a') });
    h.clock.now += 5 * MIN;
    await h.reconciler.scan();
    expect(h.rig.chains.chainForMission(second, 'shadow')).toBeUndefined();
  });

  it('skips and logs a Mission without base head, with an unregistered author, on another repository or with an unreadable author', async () => {
    const outsider = { actor_id: 777, app_id: null };
    const h = harness(SANDBOX, (v) => sandboxPr(v['number'] === 31 ? { author: outsider } : {}), T0);
    const noBase = h.rig.seedMission({ pr_number: 30, head: oid('1'), base_head: null });
    const stranger = h.rig.seedMission({ pr_number: 31, head: oid('1'), base_head: oid('a') });
    const elsewhere = h.rig.seedMission({ pr_number: 32, head: oid('1'), base_head: oid('a'), repository: 'other/repo' });
    const ok = h.rig.seedMission({ pr_number: 33, head: oid('1'), base_head: oid('a') });
    await h.reconciler.scan();
    for (const id of [noBase, stranger, elsewhere]) expect(h.rig.chains.chainForMission(id, 'shadow')).toBeUndefined();
    expect(h.rig.chains.chainForMission(ok, 'shadow')).toBeDefined();
    expect(h.logs.join('\n')).toContain(`skip mission=${noBase} reason=base_head_missing`);
    expect(h.logs.join('\n')).toContain(`skip mission=${stranger} reason=author_not_publisher`);
    expect(h.logs.join('\n')).toContain(`skip mission=${elsewhere} reason=repository_not_registered`);
    // Skipped Missions write nothing to the chain tables.
    expect(h.rig.db.prepare('SELECT COUNT(*) n FROM engineering_revision_chains').get()).toEqual({ n: 1 });
  });

  it('retries discovery after a failed read and does not create a chain from a partial one', async () => {
    let fail = true;
    const h = harness(SANDBOX, () => sandboxPr(), T0, { before: (kind) => { if (kind === 'read' && fail) throw new Error('boom'); } });
    const id = h.rig.seedMission({ pr_number: 40, head: oid('1'), base_head: oid('a') });
    await h.reconciler.scan();
    expect(h.rig.chains.chainForMission(id, 'shadow')).toBeUndefined();
    fail = false;
    h.clock.now += 5 * MIN;
    await h.reconciler.scan();
    expect(h.rig.chains.chainForMission(id, 'shadow')).toBeDefined();
  });

  it('never runs a scan after stop() and never throws from scan()', async () => {
    const h = harness(SANDBOX, () => sandboxPr(), T0);
    h.rig.seedMission({ pr_number: 50, head: oid('1'), base_head: oid('a') });
    h.reconciler.start();
    await h.reconciler.stop();
    await h.reconciler.scan();
    expect(h.t.counts().reads).toBe(0);
  });
});
