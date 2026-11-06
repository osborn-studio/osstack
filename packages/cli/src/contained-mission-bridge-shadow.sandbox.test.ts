// Sandbox Mission corpus (appendix §5.4, phase 4-D): a real time series recorded by scripts/sandbox-bridge-scenario.mjs from a Mission
// PR published in the sandbox through the phase 3 publication path. One snapshot per scenario step, taken right after the step:
//   0 (a) PR opened, no reviews                         4 (e) the publisher App pushed a follow-up commit (new head)
//   1 (b) test reviewer COMMENTED                       5 (f) the test reviewer APPROVED the new head
//   2 (c) CHANGES_REQUESTED with a body + inline thread 6 (g) the PR was closed
//   3 (d) a second CHANGES_REQUESTED, same App, same head
// The series is replayed through the real ShadowReconciler (scripted transport, real ledger). Expected values below come from the
// recorded facts (review ids, heads), never from the decision code, which is only observed.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { shadowChainWriter, sameProducer, type DiscardReason, type RevisionChain } from '@osstack/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProducerRegistryConfig } from './contained-mission-bridge-registry.js';
import { assertFixtureFile, type FixtureFile, type FixtureSnapshot } from './contained-mission-bridge-fixture.js';
import { ShadowReconciler, createShadowMissionView } from './contained-mission-bridge-shadow.js';
import { createRig, scriptedTransport, type Rig, type ScriptedPr } from './contained-mission-bridge-shadow.testkit.js';

const MIN = 60_000;
const DISCARDS: ReadonlySet<DiscardReason> = new Set<DiscardReason>([
  'snapshot_incomplete', 'snapshot_moved', 'head_mismatch', 'base_changed', 'unregistered_reviewer',
  'no_feedback', 'reviewer_conflict', 'expired', 'head_already_reserved',
]);

const dirUrl = new URL('./__fixtures__/bridge/sandbox/', import.meta.url);
const names = readdirSync(fileURLToPath(dirUrl)).filter((f) => f.endsWith('.json')).sort();
const loaded = names.map((name) => ({
  name,
  pr: Number(/-(\d+)\.json$/u.exec(name)?.[1]),
  text: readFileSync(new URL(name, dirUrl), 'utf8'),
}));

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach((fn) => { fn(); }); });

describe('sandbox Mission corpus', () => {
  it('has at least one recorded scenario and every file is named after the sandbox repository', () => {
    expect(loaded.length).toBeGreaterThan(0);
    for (const l of loaded) expect(l.name).toMatch(/^osborn-studio-osstack-bridge-sandbox-\d+\.json$/u);
  });

  describe.each(loaded)('$name', ({ pr: prNumber, text }) => {
    const file = assertFixtureFile(JSON.parse(text)) as FixtureFile;
    const snaps = file.snapshots;
    const registry: ProducerRegistryConfig = { repository: 'o/r', publisher: file.registry.publisher, reviewers: file.registry.reviewers };
    const publisher = file.registry.publisher[0]!;
    const registered = (r: FixtureSnapshot['reviews'][number]): boolean => registry.reviewers.some((p) => sameProducer(p, r.reviewer));

    // ---- the recording itself

    it('is a privacy-clean, append-only time series of the expected scenario', () => {
      expect(text).not.toMatch(/http|@/iu);
      expect(text).not.toMatch(/osstack-publisher|osstack-evidence|sandbox-test-reviewer/iu);
      expect(file.registry).toEqual({ publisher: [{ actor_id: 1, app_id: 1 }], reviewers: [{ actor_id: 2, app_id: 2 }] });
      expect(snaps).toHaveLength(7);
      expect(snaps.every((s) => s.complete && !s.moved && s.base_ref === 'main')).toBe(true);
      for (let i = 1; i < snaps.length; i += 1) {
        expect(snaps[i]!.observed_at).toBeGreaterThan(snaps[i - 1]!.observed_at);
        // Reviews are never edited or removed: every snapshot extends the previous one.
        expect(snaps[i]!.reviews.slice(0, snaps[i - 1]!.reviews.length)).toEqual(snaps[i - 1]!.reviews);
      }
      const [a, b, c, d, e, f, g] = snaps as [FixtureSnapshot, FixtureSnapshot, FixtureSnapshot, FixtureSnapshot, FixtureSnapshot, FixtureSnapshot, FixtureSnapshot];
      const h1 = a.head;
      const h2 = e.head;
      expect(h2).not.toBe(h1);
      expect([a, b, c, d].every((s) => s.head === h1)).toBe(true);
      expect([e, f, g].every((s) => s.head === h2)).toBe(true);
      expect(new Set(snaps.map((s) => s.base_sha)).size).toBe(1);
      expect(snaps.map((s) => s.reviews.length)).toEqual([0, 1, 2, 3, 3, 4, 4]);
      expect(snaps.map((s) => s.pr_state)).toEqual(['OPEN', 'OPEN', 'OPEN', 'OPEN', 'OPEN', 'OPEN', 'CLOSED']);
      expect(snaps[6]!.reviews.map((r) => r.state)).toEqual(['COMMENTED', 'CHANGES_REQUESTED', 'CHANGES_REQUESTED', 'APPROVED']);
      expect(snaps[6]!.reviews.map((r) => r.review_commit)).toEqual([h1, h1, h1, h2]);
      expect(snaps[6]!.reviews.every((r) => r.reviewer.actor_id === 2 && r.reviewer.app_id === 2 && registered(r))).toBe(true);
      expect(snaps[6]!.reviews.slice(1, 3).every((r) => r.has_feedback && r.feedback_digest !== null)).toBe(true);
      expect(new Set(snaps[6]!.reviews.map((r) => r.review_id)).size).toBe(4);
    });

    // ---- replay through the shadow reconciler

    it('replays through the reconciler: discovery, one would_reserve, attribution_unknown stop, nothing after', async () => {
      const rig: Rig = createRig();
      cleanup.push(() => { rig.close(); });
      const clock = { now: snaps[0]!.observed_at };
      let current: ScriptedPr = { ...fromSnapshot(snaps[0]!, publisher) };
      // Every request that names a PR must name the recorded one, in the Mission's repository (a regressed query would otherwise be answered anyway).
      let addressed = 0;
      const t = scriptedTransport((variables) => {
        if ('number' in variables) {
          addressed += 1;
          expect(variables).toMatchObject({ owner: 'o', name: 'r', number: prNumber });
        }
        return current;
      });
      const logs: string[] = [];
      const reconciler = new ShadowReconciler({
        missions: createShadowMissionView(rig.missions), chains: shadowChainWriter(rig.chains), transport: t.transport, registry,
        now: () => clock.now, log: (line) => { logs.push(line); },
      });
      const h1 = snaps[0]!.head;
      const h2 = snaps[4]!.head;
      const base = snaps[0]!.base_sha;
      const id = rig.seedMission({ pr_number: prNumber, head: h1, base_head: base });
      const chain = (): RevisionChain => rig.chains.chainForMission(id, 'shadow')!;
      const rows = () => rig.chains.shadowDecisions(chain().chain_id);
      const events = () => rig.chains.events(chain().chain_id, 0, 500).map((e) => ({ kind: e.kind, payload: JSON.parse(e.payload_json) as Record<string, unknown> }));
      const reserves = () => rows().filter((r) => r.action === 'would_reserve');
      const step = async (i: number): Promise<void> => {
        current = fromSnapshot(snaps[i]!, publisher);
        clock.now = snaps[0]!.observed_at + i * 5 * MIN; // a fresh read is due every step; all reviews are minutes old (24h TTL not reached)
        await reconciler.scan();
      };
      const sequence: Array<{ step: string; chain_state: string; decisions: string[]; reads: { reads: number; second: number } }> = [];
      const mark = (step: string): void => {
        sequence.push({ step, chain_state: chain().state, decisions: rows().map((r) => r.action), reads: t.counts() });
      };

      // (a) PR opened, no reviews: the chain is discovered, no decision.
      await step(0);
      expect(chain()).toMatchObject({ mode: 'shadow', state: 'awaiting_review', pr_number: prNumber, published_head: h1, published_base: base, base_ref: 'main', rounds_used: 0 });
      expect(rows()).toEqual([]);
      expect(events().map((e) => e.kind)).toEqual(['chain_created', 'observation_cycle']);
      mark('a');

      // (b) a COMMENTED review is not a request: still no decision.
      await step(1);
      expect(rows()).toEqual([]);
      expect(chain().state).toBe('awaiting_review');
      mark('b');

      // (c) CHANGES_REQUESTED with feedback on the published head: exactly one would_reserve, bound to that review, head and base.
      await step(2);
      const requested = snaps[2]!.reviews.at(-1)!;
      expect(requested.state).toBe('CHANGES_REQUESTED');
      expect(rows().map((r) => r.action)).toEqual(['would_reserve']);
      expect(rows()[0]).toMatchObject({ action: 'would_reserve', head_sha: h1, base_sha: base });
      expect(JSON.parse(rows()[0]!.review_ids_json)).toEqual([requested.review_id]);
      expect(t.counts().second).toBe(1); // confirmed by a second read before it was recorded
      expect(chain().state).toBe('awaiting_review');
      mark('c');

      // (d) a second CHANGES_REQUESTED by the same App on the same head: no second would_reserve for that head.
      await step(3);
      expect(reserves()).toHaveLength(1);
      expect(rows().filter((r) => r.head_sha === h1)).toHaveLength(1);
      expect(chain().state).toBe('awaiting_review');
      expect(events().at(-1)!.payload).toMatchObject({ decision: 'none' });
      mark('d');

      // (e) the publisher App pushed a follow-up commit: no confirmed intent exists, so the shadow stops with attribution_unknown.
      await step(4);
      expect(chain()).toMatchObject({ state: 'awaiting_decision', stop_reason: 'attribution_unknown', published_head: h1 });
      expect(rows().map((r) => [r.action, r.head_sha])).toEqual([['would_reserve', h1], ['would_stop', h2]]);
      expect(reserves()).toHaveLength(1);
      mark('e');

      // (f) approval on the new head, (g) PR closed: a stopped chain is not read again and never reserves.
      const readsAfterStop = t.counts();
      await step(5);
      expect(reserves()).toHaveLength(1);
      mark('f');
      await step(6);
      expect(reserves()).toHaveLength(1);
      expect(rows().map((r) => r.action)).toEqual(['would_reserve', 'would_stop']);
      expect(chain()).toMatchObject({ state: 'awaiting_decision', stop_reason: 'attribution_unknown' });
      expect(t.counts()).toEqual(readsAfterStop);
      expect(snaps[6]!.pr_state).toBe('CLOSED'); // the close is recorded in the corpus even though the stopped chain no longer reads
      mark('g');

      // ---- section 5.4 invariants over the whole run
      for (const row of rows().filter((r) => r.action === 'would_reserve')) {
        const ids = JSON.parse(row.review_ids_json) as number[];
        expect(ids.length).toBeGreaterThan(0);
        for (const rid of ids) {
          const rev = snaps[6]!.reviews.find((r) => r.review_id === rid)!;
          expect(registered(rev)).toBe(true); // a registered reviewer's review
          expect(rev.review_commit).toBe(row.head_sha); // bound to the head it was reserved for
          expect(row.base_sha).toBe(base); // and to the base at that time
        }
      }
      expect(new Set(reserves().map((r) => r.head_sha)).size).toBe(reserves().length); // at most one per head
      expect(reserves().some((r) => r.head_sha === h2)).toBe(false); // none after the head changed
      const all = events();
      expect(all.some((e) => e.kind === 'read_failed')).toBe(false);
      for (const e of all.filter((x) => x.kind === 'observation_cycle')) {
        for (const d of e.payload['discards'] as string[]) expect(DISCARDS.has(d.split(':')[1] as DiscardReason)).toBe(true);
      }
      expect(logs.filter((l) => /scan_failed|create_failed|cycle_abandoned|read_failed_unrecorded/u.test(l))).toEqual([]);
      expect(t.queries.every((q) => !/mutation/iu.test(q))).toBe(true);
      expect(addressed).toBe(t.counts().reads + t.counts().second);

      expect({
        sequence,
        events: all.map((e) => ({ kind: e.kind, ...(e.kind === 'observation_cycle' ? { decision: e.payload['decision'], reason: e.payload['reason'], action: e.payload['action'], discards: e.payload['discards'] } : {}) })),
      }).toMatchSnapshot();
    });
  });
});

function fromSnapshot(s: FixtureSnapshot, author: ScriptedPr['author']): ScriptedPr {
  return { state: s.pr_state, head: s.head, base_sha: s.base_sha, base_ref: s.base_ref, author, reviews: s.reviews.map((r) => ({ ...r })) };
}
