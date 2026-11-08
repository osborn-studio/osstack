import { createHash } from 'node:crypto';
import { HostProcessStore } from '@osstack/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareBridgeLedgerRange, recoverBridgeLedgers, verifyBridgeLedger } from './contained-mission-bridge-ledger.js';
import { createRig } from './contained-mission-bridge-shadow.testkit.js';

// Keep SQLite migration work bounded. A failing seed and shrink path are printed by fast-check.
const seed = Number(process.env['OSSTACK_LEDGER_PROPERTY_SEED'] ?? 61107);
if (!Number.isSafeInteger(seed) || seed < -2147483648 || seed > 2147483647) {
  throw Error('OSSTACK_LEDGER_PROPERTY_SEED must be a signed 32-bit integer');
}
const parameters = { numRuns: 24, seed };
const shape = fc.record({
  sizes: fc.array(fc.integer({ min: 3, max: 6 }), { minLength: 1, maxLength: 3 }),
  offset: fc.integer({ min: 1, max: 1_000_000 }),
  width: fc.constantFrom(40, 64),
}).chain(input => fc.shuffledSubarray(input.sizes.map((_, i) => i), {
  minLength: input.sizes.length, maxLength: input.sizes.length,
}).map(order => ({ ...input, order })));
type Shape = { sizes: number[]; offset: number; width: number; order: number[] };
const bindingFor = (commits: readonly string[]) => ({ commit_count: commits.length,
  range_sha256: createHash('sha256').update(JSON.stringify(commits)).digest('hex') });

function fixture(input: Shape) {
  const rig = createRig();
  try {
    const sha = (n: number) => n.toString(16).padStart(input.width, '0');
    const start = sha(input.offset);
    // Independent oracle: generate the whole chronological history BEFORE partitioning receipts.
    // Never reconstruct the oracle by concatenating the ledger's stored ranges.
    const history = Array.from({ length: input.sizes.reduce((a, b) => a + b, 0) }, (_, i) => sha(input.offset + i + 1));
    const head = history.at(-1)!;
    const base = sha(input.offset + history.length + 1);
    const foreign = sha(input.offset + history.length + 2);
    const root = rig.seedMission({ pr_number: 7, head, base_head: base, branch: 'topic',
      spec: { start_commit: start, worktree_path: '/isolated/ledger-property' } });
    const chain = rig.chains.createLiveChain({ root_mission_id: root, repository: 'o/r', pr_number: 7,
      branch: 'topic', base_ref: 'main', published_head: head, published_base: base, trace_id: 'property', grant: { rounds: 2 } }, 100);
    const boundaries = [0];
    for (const size of input.sizes) boundaries.push(boundaries.at(-1)! + size);
    // This suite audits restored/corrupt snapshots, not publication fences. Disable only these
    // scratch DB guards so fixture corruption is possible; audit reads still use the real store.
    for (const trigger of ['engineering_intent_insert', 'engineering_intent_push_binding', 'engineering_intent_fixed',
      'engineering_intent_transition', 'engineering_intent_no_delete', 'engineering_chain_events_no_delete']) {
      rig.db.exec(`DROP TRIGGER ${trigger}`);
    }
    const insert = rig.db.prepare(`INSERT INTO engineering_publication_intents
      (intent_id,chain_id,kind,repository,pr_number,branch,expected_old_head,new_head,expected_base_sha,
       binding_json,state,created_at,updated_at) VALUES(?,?,?,'o/r',7,'topic',?,?,?,?,'confirmed',?,?)`);
    for (const [position, index] of input.order.entries()) {
      const from = boundaries[index]!;
      const to = boundaries[index + 1]!;
      const commits = history.slice(from, to);
      const intentId = `pi_property_${index}`;
      // This digest is fixture encoding required by the receipt format, never an asserted oracle.
      const binding = bindingFor(commits);
      insert.run(intentId, chain.chain_id, index === 0 ? 'open_pr' : 'push',
        from === 0 ? start : history[from - 1]!, history[to - 1]!, base, JSON.stringify(binding), 101 + position, 101 + position);
      rig.chains.appendEvent(chain.chain_id, 'push_range', { intent_id: intentId, commits }, 101 + position);
    }
    let actual = history.slice();
    let remote = head;
    const deps: Parameters<typeof verifyBridgeLedger>[0] = { chains: rig.chains, missions: rig.missions, remoteHead: async () => remote,
      compare: async (repository, from, to) => {
        if (repository !== 'o/r' || from !== start || to !== head) throw Error('unexpected_ledger_compare_target');
        return actual;
      } };
    const signal = new AbortController().signal;
    const verify = () => verifyBridgeLedger(deps, rig.chains.get(chain.chain_id), signal);
    return { rig, root, chain, history, head, start, foreign, deps, signal, verify,
      setActual: (commits: string[]) => { actual = commits; }, setRemote: (value: string) => { remote = value; } };
  } catch (error) {
    rig.close();
    throw error;
  }
}

describe('production bridge ledger properties', () => {
  it('matches bounded ancestry regardless of receipt insertion order and rejects same-tip history attacks', async () => {
    await fc.assert(fc.asyncProperty(shape, fc.nat({ max: 100 }), async (input, position) => {
      const f = fixture(input);
      try {
        expect(await f.verify()).toBe('matched');
        const index = position % (f.history.length - 2);
        const reordered = f.history.slice();
        [reordered[index], reordered[index + 1]] = [reordered[index + 1]!, reordered[index]!];
        const replaced = f.history.slice(); replaced[index] = f.foreign;
        const inserted = f.history.slice(); inserted.splice(index, 0, f.foreign);
        const missing = f.history.filter((_, i) => i !== index);
        const duplicated = f.history.slice(); duplicated.splice(index, 0, f.history[index]!);
        for (const attack of [reordered, replaced, inserted, missing, duplicated]) {
          expect(attack.at(-1)).toBe(f.head);
          f.setActual(attack);
          expect(await f.verify()).toBe('external_write');
        }
        f.setActual(f.history);
        f.setRemote(f.foreign);
        expect(await f.verify()).toBe('external_write');
      } finally { f.rig.close(); }
    }), parameters);
  });

  it('requires a confirmed baseline even when the full remote history and tip agree', async () => {
    await fc.assert(fc.asyncProperty(shape, async input => {
      const f = fixture(input);
      try {
        expect(await f.verify()).toBe('matched');
        for (const state of ['pending', 'failed', 'uncertain']) {
          f.rig.db.prepare('UPDATE engineering_publication_intents SET state=? WHERE intent_id=?').run(state, 'pi_property_0');
          expect(await f.verify()).toBe('external_write');
        }
        f.rig.db.prepare('DELETE FROM engineering_publication_intents WHERE intent_id=?').run('pi_property_0');
        expect(await f.verify()).toBe('external_write');
      } finally { f.rig.close(); }
    }), parameters);
  });

  it('rejects gaps, overlaps, foreign ranges and missing range evidence in the stored ledger', async () => {
    await fc.assert(fc.asyncProperty(shape, fc.nat({ max: 100 }), async (input, position) => {
      const f = fixture(input);
      try {
        expect(await f.verify()).toBe('matched');
        const index = position % input.sizes.length;
        const intentId = `pi_property_${index}`;
        const event = f.rig.chains.pushRangeEvent(f.chain.chain_id, intentId)!;
        const original = JSON.parse(event.payload_json) as { commits: string[] };
        const changed = original.commits.slice(); changed[0] = f.foreign;
        f.rig.chains.appendEvent(f.chain.chain_id, 'push_range', { intent_id: intentId, commits: changed }, 200);
        expect(await f.verify()).toBe('external_write');
        // Even a self-consistent receipt for a foreign commit cannot authorize that history.
        f.rig.db.prepare('UPDATE engineering_publication_intents SET binding_json=? WHERE intent_id=?')
          .run(JSON.stringify(bindingFor(changed)), intentId);
        expect(await f.verify()).toBe('external_write');
        f.rig.db.prepare('UPDATE engineering_publication_intents SET binding_json=? WHERE intent_id=?')
          .run(JSON.stringify(bindingFor(original.commits)), intentId);
        f.rig.chains.appendEvent(f.chain.chain_id, 'push_range', { intent_id: intentId, commits: original.commits }, 201);
        expect(await f.verify()).toBe('matched');
        const intent = f.rig.chains.intents(f.chain.chain_id).find(row => row.intent_id === intentId)!;
        for (const oldHead of [f.foreign, intent.new_head!]) {
          f.rig.db.prepare('UPDATE engineering_publication_intents SET expected_old_head=? WHERE intent_id=?').run(oldHead, intentId);
          expect(await f.verify()).toBe('external_write');
        }
        f.rig.db.prepare('UPDATE engineering_publication_intents SET expected_old_head=? WHERE intent_id=?').run(intent.expected_old_head, intentId);
        f.rig.db.prepare("DELETE FROM engineering_revision_chain_events WHERE chain_id=? AND kind='push_range' AND json_extract(payload_json,'$.intent_id')=?")
          .run(f.chain.chain_id, intentId);
        expect(await f.verify()).toBe('external_write');
      } finally { f.rig.close(); }
    }), parameters);
  });

  it('defers pending and uncertain receipts at the remote tip or after release; recovery preserves the stop', async () => {
    await fc.assert(fc.asyncProperty(shape, fc.constantFrom('pending', 'uncertain'), async (input, state) => {
      const f = fixture(input);
      try {
        const child = f.rig.missions.authorize(f.rig.principal, { scope_id: f.rig.scope.scope_id,
          spec: { goal: 'receipt recovery fixture', branch: 'topic-child' },
          claim: { repo_identity: 'receipt-repo', branch: 'topic-child', worktree_identity: 'receipt-worktree' } }, 199);
        f.rig.db.prepare(`INSERT INTO engineering_publication_intents
          (intent_id,chain_id,kind,repository,pr_number,branch,expected_old_head,new_head,expected_base_sha,
           child_mission_id,binding_json,state,created_at,updated_at) VALUES('pi_unsettled',?,'push','o/r',7,'topic',?,?,?,?,'{}',?,200,200)`)
          .run(f.chain.chain_id, f.head, f.foreign, f.chain.published_base, child.mission_id, state);
        f.setRemote(f.foreign);
        expect(await f.verify()).toBe('reconciliation_incomplete');
        f.setRemote(f.head);
        // An unreleased proposal at a different tip is not evidence of an actual remote write.
        expect(await f.verify()).toBe('matched');
        const journal = new HostProcessStore(f.rig.attention, f.rig.owner, { clock: () => 201 });
        journal.launching({ op_id: 'hp_property', mission_id: child.mission_id, kind: 'git_push', remote_target: 'o/r#refs/heads/topic',
          local_target: '/isolated/ledger-property', intent_id: 'pi_unsettled', argv_digest: 'a'.repeat(64),
          boot_id: 'property', marker: { path: '/isolated/marker', dev: '1', ino: '1' } });
        journal.registered('hp_property', { pid: 12345, pgid: 12345, leader_start: 'property' });
        journal.release('hp_property', () => {});
        f.rig.chains.stopLive(f.chain.chain_id, f.rig.chains.get(f.chain.chain_id).revision, 'grant_expired', 202);
        // Deliberately broken reads prove that deferral is decided before trying to audit history.
        const noRead = async (): Promise<never> => { throw Error('deferred audit must not read'); };
        f.deps.remoteHead = noRead; f.deps.compare = noRead;
        expect(await f.verify()).toBe('reconciliation_incomplete');
        const before = f.rig.chains.get(f.chain.chain_id);
        await recoverBridgeLedgers({ ...f.deps, now: () => 203,
          cancelChild: noRead }, f.signal);
        expect(f.rig.chains.get(f.chain.chain_id)).toEqual(before);
        expect(before.stop_reason).toBe('grant_expired');
      } finally { f.rig.close(); }
    }), parameters);
  });

  it('marks an audit stale when its captured chain or receipts change during the compare read', async () => {
    await fc.assert(fc.asyncProperty(shape, fc.constantFrom('chain', 'receipt'), async (input, mutation) => {
      const f = fixture(input);
      try {
        f.deps.compare = async () => {
          if (mutation === 'chain') {
            const current = f.rig.chains.get(f.chain.chain_id);
            f.rig.chains.stopLive(current.chain_id, current.revision, 'grant_expired', 200);
          } else {
            f.rig.db.prepare("UPDATE engineering_publication_intents SET state='failed' WHERE intent_id='pi_property_0'").run();
          }
          return f.history;
        };
        expect(await f.verify()).toBe('stale');
      } finally { f.rig.close(); }
    }), parameters);
  });

  it('audits complete paged reads and propagates incomplete pages or transport failures without stopping a chain', async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 101, max: 205 }), fc.constantFrom(40, 64), async (count, width) => {
      const f = fixture({ sizes: [count], offset: 1, width, order: [0] });
      try {
        let fault: 'none' | 'short' | 'outage' = 'none';
        f.deps.compare = (repository, from, to, signal) => compareBridgeLedgerRange(repository, from, to, async args => {
          const request = new URL(`https://fixture.invalid/${args[1]!}`);
          if (request.pathname !== `/repos/o/r/compare/${f.start}...${f.head}`) throw Error('unexpected_ledger_compare_target');
          const page = Number(request.searchParams.get('page'));
          if (page === 2 && fault === 'outage') return { exitCode: 1, stdout: '', stderr: 'synthetic outage' };
          const commits = page === 2 && fault === 'short' ? [] : f.history.slice((page - 1) * 100, page * 100);
          return { exitCode: 0, stderr: '', stdout: JSON.stringify({ total_commits: count, commits: commits.map(sha => ({ sha })) }) };
        }, signal);
        expect(await f.verify()).toBe('matched');
        const before = f.rig.chains.get(f.chain.chain_id);
        for (const failure of ['short', 'outage'] as const) {
          fault = failure;
          const error = failure === 'short' ? 'bridge_ledger_range_incomplete' : 'bridge_ledger_read_failed';
          await expect(f.verify()).rejects.toThrow(error);
          await expect(recoverBridgeLedgers({ ...f.deps, now: () => 200 }, f.signal)).rejects.toThrow(error);
          expect(f.rig.chains.get(f.chain.chain_id)).toEqual(before);
        }
      } finally { f.rig.close(); }
    }), parameters);
  });
});
