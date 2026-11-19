import { rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createScratchDirSync } from '../scratch.js';
import { openDb } from './db.js';
import { AttentionStore } from './attention-store.js';
import { ContainedMissionStore, MAX_REPAIR_CHAIN_DEPTH, type ContainedDeriveInput, type ContainedMissionState } from './engineering-contained-store.js';
import { MIGRATIONS } from './migrations.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
function setup(legacy = false) {
  const root = createScratchDirSync('tests', 'mission-lineage'); const path = join(root, 'state.db');
  if (legacy) {
    const raw = new Database(path);
    for (const m of MIGRATIONS.filter(m => m.id <= 55)) raw.exec(m.sql);
    raw.pragma('user_version=55'); raw.close();
  }
  let db = legacy ? new Database(path) : openDb({ path }); db.pragma('synchronous=FULL');
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  let attention = new AttentionStore(db, path); let owner = attention.claimOwner('owner');
  const scope_id = attention.registerScope(owner, 't', root).scope_id;
  const principal = { principal_id: 'human', client_session_id: 'cli', read_scopes: [scope_id], write_scopes: [scope_id], stop_scopes: [scope_id], operator_scopes: [] };
  let store = new ContainedMissionStore(attention, owner); let seq = 0;
  const input = () => ({ scope_id, spec: { goal: 'fix' }, claim: { repo_identity: 'repo', branch: `b${++seq}`, worktree_identity: `w${seq}` } });
  const derive = (parent_mission_id: string): ContainedDeriveInput => ({ ...input(), parent_mission_id, source: { kind: 'review', id: `review${seq}` }, idempotency_key: `key${seq}` });
  const counts = () => ['engineering_contained_missions', 'engineering_workspace_claims', 'engineering_mission_lineage', 'engineering_contained_events'].map(t => db.prepare(`SELECT count(*) n FROM ${t}`).get());
  return { path, get owner() { return owner; }, get db() { return db; }, get store() { return store; }, principal, input, derive, counts,
    upgrade() { db.close(); db = openDb({ path }); db.pragma('synchronous=FULL'); attention = new AttentionStore(db, path); owner = attention.claimOwner('new-owner'); store = new ContainedMissionStore(attention, owner); } };
}
it('registers roots and inherits origin hop by hop and registers the eighth hop as an atomic stop', () => {
  const f = setup(); const root = f.store.authorize(f.principal, f.input(), 1);
  expect(f.store.lineage(root.mission_id)).toMatchObject({ origin_mission_id: root.mission_id, parent_mission_id: null, chain_depth: 0, source_kind: 'local_root' });
  expect(f.store.events(root.mission_id).map(e => e.kind)).toContain('mission_lineage_registered');
  let parent = root.mission_id;
  for (let depth = 1; depth <= 8; depth++) {
    const input = f.derive(parent); input.source.kind = depth % 2 ? 'github_actions' : 'review'; input.spec = { pr: depth, head: `h${depth}`, grant: `g${depth}` };
    if (depth === 8) {
      const before = f.counts();
      f.db.exec("CREATE TEMP TRIGGER crash AFTER INSERT ON attention_deliveries BEGIN SELECT RAISE(ABORT,'crash'); END");
      expect(() => f.store.registerDerived(f.principal, input, depth + 1)).toThrow('crash');
      expect(f.counts()).toEqual(before);
      expect(f.db.prepare('SELECT * FROM attention_deliveries').all()).toEqual([]);
      f.db.exec('DROP TRIGGER crash');
    }
    const out = f.store.registerDerived(f.principal, input, depth + 1);
    if (depth === 8) {
      expect(out).toMatchObject({ status: 'depth_limit', registered: true, linked: false, mission: { state: 'awaiting_decision', revision: 2 } });
      if (out.status === 'waiting') throw Error(out.reason);
      expect(JSON.parse(f.store.events(out.mission.mission_id).at(-1)!.payload_json)).toEqual({ reason: 'verify_chain_depth_limit',
        from: 'authorized', to: 'awaiting_decision', origin_mission_id: root.mission_id, parent_mission_id: parent,
        chain_depth: 8, max_depth: 8, source: input.source, idempotency_key: input.idempotency_key });
      const counts = f.counts();
      expect(f.db.prepare('SELECT state FROM attention_deliveries').all()).toEqual([{ state: 'pending' }]);
      expect(f.store.registerDerived(f.principal, { ...input, spec: { changed: true }, source: { ...input.source, id: 'changed' } }, 10))
        .toEqual({ ...out, registered: false });
      expect(f.counts()).toEqual(counts);
      const next = f.derive(out.mission.mission_id);
      for (const linked of [true, false]) expect(f.store.registerDerived(f.principal, next, 11)).toEqual({ ...out, registered: false, linked });
      expect(f.store.events(out.mission.mission_id).filter(e => e.kind === 'chain_depth_stop_linked')).toHaveLength(1);
      expect(f.db.prepare('SELECT max(chain_depth) FROM engineering_mission_lineage').pluck().get()).toBe(8);
    } else expect(out.status).toBe('registered'); if (out.status === 'waiting') throw Error('waiting');
    expect(out.lineage).toMatchObject({ origin_mission_id: root.mission_id, parent_mission_id: parent, chain_depth: depth });
    expect(f.store.resolveLineage(out.mission.mission_id).status).toBe('known'); parent = out.mission.mission_id;
  }
  expect(MAX_REPAIR_CHAIN_DEPTH).toBe(8);
});
it.each(['chain_depth', 'origin_mission_id', 'depth', 'root', 'origin'])('rejects caller-supplied %s', key => {
  const f = setup(); const root = f.store.authorize(f.principal, f.input(), 1);
  expect(() => f.store.authorize(f.principal, { ...f.input(), [key]: 0 }, 2)).toThrow('invalid_lineage_input');
  expect(() => f.store.registerDerived(f.principal, { ...f.derive(root.mission_id), [key]: 0 }, 2)).toThrow('invalid_lineage_input');
});
it('rejects a parent on root registration', () => {
  const f = setup(); expect(() => f.store.authorize(f.principal, Object.assign(f.input(), { parent_mission_id: 'x' }), 1)).toThrow('invalid_lineage_input');
});
it('recovers duplicate registrations without any writes and rejects conflicting identity', () => {
  const f = setup(); const root = f.store.authorize(f.principal, f.input(), 1); const input = f.derive(root.mission_id);
  const first = f.store.registerDerived(f.principal, input, 2); const counts = f.counts();
  expect(f.store.registerDerived(f.principal, input, 3)).toEqual({ ...first, status: 'duplicate' }); expect(f.counts()).toEqual(counts);
  const other = f.store.authorize(f.principal, f.input(), 4);
  for (const change of [{ parent_mission_id: other.mission_id }, { spec: { changed: true } }, { source: { kind: 'patrol' as const, id: 'other' } }])
    expect(() => f.store.registerDerived(f.principal, { ...input, ...change }, 5)).toThrow('lineage_idempotency_conflict');
});
it('rolls back all four ledgers on claim conflict or enclosing transaction failure', () => {
  const f = setup(); const rootInput = f.input(); const root = f.store.authorize(f.principal, rootInput, 1); const counts = f.counts();
  expect(() => f.store.registerDerived(f.principal, { ...f.derive(root.mission_id), claim: rootInput.claim }, 2)).toThrow('workspace_claimed'); expect(f.counts()).toEqual(counts);
  expect(() => f.db.transaction(() => { f.store.registerDerived(f.principal, f.derive(root.mission_id), 2); throw Error('rollback'); })()).toThrow('rollback'); expect(f.counts()).toEqual(counts);
});
it('supersedes roots and depth-two missions without adding a hop', () => {
  const f = setup(); const root = f.store.authorize(f.principal, f.input(), 1); let parent = root.mission_id;
  for (let i = 0; i < 2; i++) { const out = f.store.registerDerived(f.principal, f.derive(parent), 2); if (out.status === 'waiting') throw Error('waiting'); parent = out.mission.mission_id; }
  for (const id of [root.mission_id, parent]) {
    f.store.transition(id, { if_revision: 1, to: 'failed', event: { kind: 'failed', payload: {} } }, 3);
    const next = f.store.authorize(f.principal, { ...f.input(), supersedes: id }, 4); const prior = f.store.lineage(id)!;
    expect(f.store.lineage(next.mission_id)).toMatchObject({ origin_mission_id: prior.origin_mission_id, parent_mission_id: prior.parent_mission_id, chain_depth: prior.chain_depth, source_kind: 'supersede', source_id: id, idempotency_key: null });
    expect(f.store.resolveLineage(next.mission_id).status).toBe('known');
  }
});
it('rejects lineage updates, deletes and late insertion', () => {
  const f = setup(); const root = f.store.authorize(f.principal, f.input(), 1);
  expect(() => f.db.prepare('UPDATE engineering_mission_lineage SET chain_depth=0 WHERE mission_id=?').run(root.mission_id)).toThrow('mission_lineage_immutable');
  expect(() => f.db.prepare('DELETE FROM engineering_mission_lineage WHERE mission_id=?').run(root.mission_id)).toThrow('mission_lineage_immutable');
  f.store.transition(root.mission_id, { if_revision: 1, to: 'workspace_ready', event: { kind: 'ready', payload: {} } }, 2);
  expect(() => f.db.prepare("INSERT INTO engineering_mission_lineage(mission_id,origin_mission_id,chain_depth,source_kind,created_at) VALUES(?,?,0,'local_root',1)").run(root.mission_id, root.mission_id)).toThrow('mission_lineage_late');
});
it('upgrades schema 55 without changing legacy missions or inventing lineage', () => {
  const f = setup(true); const ids = ['legacy-root', 'legacy-authorized', 'legacy-waiting'];
  ids.forEach((id, i) => {
    const input = f.input();
    f.db.prepare("INSERT INTO engineering_contained_missions(mission_id,scope_id,owner_principal_id,owner_client_session_id,spec_digest,spec_json,state,revision,created_at,updated_at,candidate_verified,candidate_head) VALUES(?,?,'human','cli',?,'{}',?,1,1,1,1,'head')").run(id, input.scope_id, 'a'.repeat(64), ['pr_opened', 'authorized', 'awaiting_decision'][i]);
    f.db.prepare("INSERT INTO engineering_workspace_claims(claim_id,mission_id,repo_identity,branch,worktree_identity,state,created_at) VALUES(?,?,'repo',?,?,'active',1)").run(`claim${i}`, id, input.claim.branch, input.claim.worktree_identity);
    f.store.record(id, 'legacy', {}, 1);
  });
  const before = f.db.prepare('SELECT * FROM engineering_contained_missions ORDER BY mission_id').all();
  f.upgrade(); expect(f.db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(56);
  expect(f.db.prepare('SELECT * FROM engineering_contained_missions ORDER BY mission_id').all()).toEqual(before);
  expect(f.counts()).toEqual([{ n: 3 }, { n: 3 }, { n: 0 }, { n: 3 }]);
  for (const id of ids) expect(f.store.resolveLineage(id)).toMatchObject({ status: 'unknown', reason: 'verify_chain_lineage_unknown' });
  const input = f.derive(ids[0]!);
  for (let i = 0; i < 2; i++) expect(f.store.registerDerived(f.principal, input, 2)).toEqual({ status: 'waiting', reason: 'verify_chain_lineage_unknown', parent_mission_id: ids[0] });
  expect(f.counts()).toEqual([{ n: 3 }, { n: 3 }, { n: 0 }, { n: 4 }]);
  const successor = f.store.authorize(f.principal, { ...f.input(), supersedes: ids[0]! }, 3);
  expect(f.store.lineage(successor.mission_id)).toBeNull(); expect(f.store.events(successor.mission_id).map(e => e.kind)).toContain('mission_lineage_unknown');
});
it('treats contradictory stored lineage as unknown and deduplicates waiting events', () => {
  const f = setup(); const root = f.store.authorize(f.principal, f.input(), 1); const other = f.store.authorize(f.principal, f.input(), 1);
  f.db.exec('DROP TRIGGER engineering_mission_lineage_no_update');
  f.db.prepare('UPDATE engineering_mission_lineage SET origin_mission_id=? WHERE mission_id=?').run(other.mission_id, root.mission_id);
  expect(f.store.resolveLineage(root.mission_id).status).toBe('unknown'); const input = f.derive(root.mission_id); const counts = f.counts();
  expect(f.store.registerDerived(f.principal, input, 2).status).toBe('waiting'); const after = f.counts(); expect(after.slice(0, 3)).toEqual(counts.slice(0, 3));
  expect(f.store.registerDerived(f.principal, input, 3).status).toBe('waiting'); expect(f.counts()).toEqual(after);
});
function legacyChain(depth: number) {
  const f = setup(true);
  for (const m of MIGRATIONS.filter(m => m.id > 55 && m.id <= 60)) f.db.exec(m.sql);
  f.db.pragma('user_version=60');
  const root = f.store.authorize(f.principal, f.input(), 1);
  let parent = root.mission_id;
  for (let hop = 1; hop <= depth; hop++) {
    const id = 'legacy-' + hop;
    f.db.prepare("INSERT INTO engineering_contained_missions(mission_id,scope_id,owner_principal_id,owner_client_session_id,spec_digest,spec_json,state,revision,created_at,updated_at) VALUES(?,?,'human','cli',?,'{}','authorized',1,1,1)").run(id,root.scope_id,'a'.repeat(64));
    f.db.prepare("INSERT INTO engineering_workspace_claims(claim_id,mission_id,repo_identity,branch,worktree_identity,state,created_at) VALUES(?,?,'fixture',?,?,'active',1)").run(id,id,id,id);
    f.db.prepare("INSERT INTO engineering_mission_lineage VALUES(?,?,?,?, 'review',?,?,1)").run(id, root.mission_id, parent, hop, id, id);
    parent = id;
  }
  return { f, root, parent };
}
it('freezes existing deep rows without rewriting the ledger and converts retries once', () => {
  const { f } = legacyChain(9);
  const objects = () => f.db.prepare("SELECT name FROM sqlite_schema ORDER BY name").pluck().all();
  const before = objects();
  const rows = () => f.db.prepare("SELECT * FROM engineering_contained_missions JOIN engineering_mission_lineage USING(mission_id) ORDER BY mission_id").all();
  const original = rows();
  f.upgrade();
  expect(objects().filter(n => !before.includes(n))).toEqual(['engineering_mission_depth_stop','engineering_mission_lineage_depth_cap']);
  expect(rows()).toEqual(original);
  for (const depth of [8,9]) {
    const id = 'legacy-' + depth;
    for (const to of ['authorized','workspace_ready','executing','candidate_ready','verifying','verified','verify_failed','revalidating','delivering','pr_opened','needs_reconciliation','stop_unknown','cancel_requested','cancelled','failed'])
      expect(() => f.db.prepare('UPDATE engineering_contained_missions SET state=? WHERE mission_id=?').run(to,id)).toThrow('verify_chain_depth_limit');
    const input = { ...f.derive('legacy-' + (depth-1)), idempotency_key: id };
    for (let i=0;i<2;i++) expect(f.store.registerDerived(f.principal,input,20)).toMatchObject({status:'depth_limit',registered:false,mission:{state:'awaiting_decision',revision:2}});
    expect(JSON.parse(f.store.events(id).at(-1)!.payload_json)).toMatchObject({chain_depth:depth,max_depth:8});
    const blocked: ContainedMissionState[] = ['authorized', 'workspace_ready', 'executing', 'candidate_ready', 'verifying', 'verified',
      'verify_failed', 'revalidating', 'delivering', 'pr_opened', 'needs_reconciliation', 'stop_unknown', 'cancel_requested', 'cancelled', 'failed'];
    for (const to of blocked) {
      expect(() => f.store.transition(id, { if_revision: 2, to, event: { kind: 'attempt', payload: {} } }, 21)).toThrow('verify_chain_depth_limit');
    }
    f.store.transition(id,{if_revision:2,to:'abandoned',event:{kind:'abandoned',payload:{}}},21);
    expect(() => f.store.authorize(f.principal,{...f.input(),supersedes:id},22)).toThrow('verify_chain_depth_limit');
  }
  expect(f.db.prepare('SELECT * FROM attention_deliveries').all()).toHaveLength(2);
  for (const [depth,kind] of [[MAX_REPAIR_CHAIN_DEPTH+1,'review'],[MAX_REPAIR_CHAIN_DEPTH,'supersede']])
    expect(() => f.db.prepare("INSERT INTO engineering_mission_lineage VALUES('new','origin','parent',?,?,'x','new',1)").run(depth,kind)).toThrow('verify_chain_depth_limit');
});
it('bounds legacy lineage walks and rejects mismatched parent depth', () => {
  const { f, root, parent } = legacyChain(65);
  expect(f.store.resolveLineage(parent)).toMatchObject({ status: 'unknown', detail: 'lineage_cycle_or_limit' });
  f.db.exec('DROP TRIGGER engineering_mission_lineage_no_update');
  f.db.prepare('UPDATE engineering_mission_lineage SET chain_depth=2 WHERE parent_mission_id=?').run(root.mission_id);
  const child = f.db.prepare('SELECT mission_id FROM engineering_mission_lineage WHERE parent_mission_id=?').get(root.mission_id) as { mission_id: string };
  expect(f.store.resolveLineage(child.mission_id)).toMatchObject({ status: 'unknown', detail: 'lineage_parent_mismatch' });
});
it('validates derived sources and retains permission and parent checks', () => {
  const f = setup(); const root = f.store.authorize(f.principal, f.input(), 1); const input = f.derive(root.mission_id); const before = f.counts();
  for (const source of [{ kind: 'local_root', id: 'x' }, { kind: 'review', id: '' }, { kind: 'review', id: 'x'.repeat(257) }])
    expect(() => f.store.registerDerived(f.principal, { ...input, source } as ContainedDeriveInput, 2)).toThrow('invalid_lineage_input');
  for (const idempotency_key of ['', 'x'.repeat(257)]) expect(() => f.store.registerDerived(f.principal, { ...input, idempotency_key }, 2)).toThrow('invalid_lineage_input');
  expect(() => f.store.registerDerived(f.principal, { ...input, parent_mission_id: 'missing' }, 2)).toThrow('not_found');
  expect(() => f.store.registerDerived({ ...f.principal, write_scopes: [] }, input, 2)).toThrow('permission_denied');
  expect(() => f.store.registerDerived({ ...f.principal, write_scopes: ['other'] }, { ...input, scope_id: 'other' }, 2)).toThrow('permission_denied');
  expect(f.counts()).toEqual(before);
});

it('serializes competing stop registrations across two connections', () => {
  const { f, parent } = legacyChain(7);
  f.upgrade();
  const input = f.derive(parent);
  const db = new Database(f.path, { timeout: 0 });
  try {
    db.pragma('synchronous=FULL');
    const contender = new ContainedMissionStore(new AttentionStore(db, f.path), f.owner);
    // Attempt another writer after the first has begun reading, before it has inserted a child.
    const get = f.store.get.bind(f.store);
    const read = vi.spyOn(f.store, 'get').mockImplementationOnce(id => {
      const mission = get(id);
      expect(() => contender.registerDerived(f.principal,input,11)).toThrow(/locked/);
      return mission;
    });
    try {
      expect(f.store.registerDerived(f.principal,input,10)).toMatchObject({status:'depth_limit',registered:true});
    } finally { read.mockRestore(); }
    expect(contender.registerDerived(f.principal,input,12)).toMatchObject({status:'depth_limit',registered:false});
    expect(db.prepare('SELECT mission_id FROM engineering_mission_lineage WHERE chain_depth=8').all()).toHaveLength(1);
    expect(db.prepare('SELECT * FROM attention_deliveries').all()).toHaveLength(1);
  } finally { db.close(); }
});
