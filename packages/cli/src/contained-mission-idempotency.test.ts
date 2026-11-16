import { createHash } from 'node:crypto';
import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AttentionStore, ContainedMissionStore, createScratchDirSync, openDb, type ContainedMission } from '@osstack/core';
import { afterEach, describe, expect, it } from 'vitest';
import { EngineeringAccess } from './engineering-access.js';
import type { ContainedMissionHost } from './contained-mission-host.js';
import { ContainedMissionService } from './contained-mission-rpc.js';

const credential = 'c'.repeat(48);
const kinds = ['abandon', 'extra_repair', 'approve_publication', 'discard_changes', 'adopt_worktree', 'resume_workspace', 'retry_stop_check', 'resume_budget', 'resume_grant'] as const;
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => { fn(); }); });

function fixture(options: { deferred?: boolean; failOnce?: string; draining?: boolean; admissionFailure?: boolean } = {}) {
  const root = realpathSync(createScratchDirSync('tests', 'decide-idempotency'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'state.db');
  const auth = join(root, 'authority.json');
  let db = openDb({ path }); db.pragma('synchronous=FULL');
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  let attention = new AttentionStore(db, path);
  let owner = attention.claimOwner('owner');
  const scope = attention.registerScope(owner, 't', root).scope_id;
  const principal = { principal_id: 'human', client_session_id: 'cli', read_scopes: [scope], write_scopes: [scope], stop_scopes: [scope], operator_scopes: [] };
  writeFileSync(auth, JSON.stringify({ version: 1, principals: [{ credential_sha256: createHash('sha256').update(credential).digest('hex'), ...principal }] }), { mode: 0o600 });
  let store = new ContainedMissionStore(attention, owner);
  const authorized = store.authorize(principal, { scope_id: scope, spec: { goal: 'test' }, claim: { repo_identity: 'repo', branch: 'branch', worktree_identity: 'worktree' } }, 1000);
  const mission = store.transition(authorized.mission_id, { if_revision: authorized.revision, to: 'awaiting_decision',
    event: { kind: 'halted', payload: { reason: 'test' } } }, 1001);
  const id = mission.mission_id;
  let calls = 0;
  let busy = false;
  let release: (() => void) | undefined;
  let failure = options.failOnce;
  const service = () => {
    const host = {
      store,
      isBusy: () => busy,
      retryStopCheckAllowed: () => true,
      runner: {
        decisionAllowed: () => true,
        prepareDecision: () => { if (options.admissionFailure) throw Error('resume_refused:facts_changed'); },
        isVerifyResume: () => false,
        decideImmediate: (m: ContainedMission, d: { kind: string; decision_id?: string }) => {
          calls++;
          if (d.kind === 'abandon') return store.transition(id, { if_revision: m.revision, to: 'abandoned',
            event: { kind: 'decision_abandon', payload: { decision_id: d.decision_id } } }, 2001);
          store.record(id, `decision_${d.kind}`, { decision_id: d.decision_id }, 2001); return m;
        },
      },
      decide: async (_actor: unknown, _id: string, d: { kind: string; decision_id?: string }) => {
        calls++; busy = true;
        try {
          if (options.deferred) await new Promise<void>(resolve => { release = resolve; });
          if (failure) { const code = failure; failure = undefined; throw Error(code); }
          if (d.kind === 'resume_workspace') return store.transition(id, { if_revision: store.get(id).revision, to: 'workspace_ready',
            event: { kind: 'workspace_created', payload: { decision_id: d.decision_id, resumed: true } } }, 2001);
          store.record(id, `decision_${d.kind}`, { decision_id: d.decision_id }, 2001); return store.get(id);
        }
        finally { busy = false; }
      },
    } as unknown as ContainedMissionHost;
    return new ContainedMissionService({ host, access: new EngineeringAccess(auth), draining: () => options.draining ?? false, ackMs: 1 });
  };
  const reopen = () => {
    db.close(); db = openDb({ path }); db.pragma('synchronous=FULL');
    attention = new AttentionStore(db, path); owner = attention.claimOwner('owner'); store = new ContainedMissionStore(attention, owner);
  };
  cleanup.push(() => db.close());
  const events = () => db.prepare('SELECT kind,payload_json FROM engineering_contained_events WHERE mission_id=? ORDER BY seq').all(id) as Array<{ kind: string; payload_json: string }>;
  const decide = (s: ContainedMissionService, kind: string, decisionId = 'key-1', expectedRevision?: number) =>
    s.handle('mission.decide', { credential, mission_id: id, decision: kind, decision_id: decisionId,
      ...(expectedRevision !== undefined ? { expected_revision: expectedRevision } : {}) });
  return { id, db: () => db, store: () => store, service, reopen, events, decide, calls: () => calls,
    release: () => release?.(), setBusy: (value: boolean) => { busy = value; }, setDraining: (value: boolean) => { options.draining = value; } };
}

describe('mission.decide idempotent admission (SQLite)', () => {
  for (const kind of kinds.filter(k => !['abandon', 'approve_publication', 'retry_stop_check'].includes(k))) {
    it(`${kind}: early ack stays busy and replays unknown until it settles`, async () => {
      const f = fixture({ deferred: true }); const s = f.service();
      expect(await f.decide(s, kind, `early-${kind}`)).toMatchObject({ accepted: true, decision: kind });
      expect(await f.decide(s, kind, `early-${kind}`)).toMatchObject({ accepted: true, replay: true, outcome: 'unknown' });
      expect(f.calls()).toBe(1);
      f.release(); await new Promise(resolve => setTimeout(resolve, 5));
      expect(await f.decide(s, kind, `early-${kind}`)).toMatchObject({ accepted: true, replay: true });
    });
  }

  it('retries an effect-free host refusal under the same key', async () => {
    const f = fixture({ failOnce: 'CONTAINED_STOP_UNPROVEN' }); const s = f.service();
    expect(await f.decide(s, 'retry_stop_check')).toMatchObject({ outcome: 'failed', code: 'CONTAINED_STOP_UNPROVEN' });
    expect(await f.decide(s, 'retry_stop_check')).toMatchObject({ accepted: true });
    expect(f.calls()).toBe(2);
    expect(f.events().filter(e => e.kind === 'decision_accepted')).toHaveLength(1);
  });

  it('rolls back admission on a synchronous chain refusal', async () => {
    const f = fixture({ admissionFailure: true }); const before = f.events();
    await expect(f.decide(f.service(), 'extra_repair')).rejects.toThrow('resume_refused:facts_changed');
    expect(f.events()).toEqual(before);
    expect(f.calls()).toBe(0);
  });

  it('rolls back acceptance if the immediate transition fails', async () => {
    const f = fixture(); const s = f.service(); const before = f.events();
    f.db().exec("CREATE TRIGGER fail_decision_transition BEFORE INSERT ON engineering_contained_events WHEN NEW.kind='decision_abandon' BEGIN SELECT RAISE(ABORT, 'injected_transition_failure'); END");
    await expect(f.decide(s, 'abandon')).rejects.toThrow('injected_transition_failure');
    expect(f.events()).toEqual(before);
    f.db().exec('DROP TRIGGER fail_decision_transition');
    expect(await f.decide(s, 'abandon')).toMatchObject({ accepted: true, state: 'abandoned' });
  });

  it('returns unknown after an effect marker without executing again', async () => {
    const f = fixture(); const revision = f.store().get(f.id).revision;
    const digest = createHash('sha256').update(JSON.stringify({ kind: 'discard_changes' })).digest('hex');
    f.store().record(f.id, 'decision_accepted', { decision_id: 'charged', principal_id: 'human', digest, revision, kind: 'discard_changes' }, 2000);
    f.store().record(f.id, 'decision_effect_started', { decision_id: 'charged', effect: 'chargeLaunch:executor:discard_changes' }, 2001);
    expect(await f.decide(f.service(), 'discard_changes', 'charged')).toMatchObject({ accepted: true, replay: true, outcome: 'unknown' });
    expect(f.calls()).toBe(0);
  });

  it('checks draining before continuing an effect-free admission', async () => {
    const f = fixture({ draining: true }); const revision = f.store().get(f.id).revision;
    const digest = createHash('sha256').update(JSON.stringify({ kind: 'extra_repair' })).digest('hex');
    f.store().record(f.id, 'decision_accepted', { decision_id: 'drain', principal_id: 'human', digest, revision, kind: 'extra_repair' }, 2000);
    await expect(f.decide(f.service(), 'extra_repair', 'drain')).rejects.toThrow('draining');
    expect(f.calls()).toBe(0);
  });

  for (const kind of kinds) {
    it(`${kind}: accepts once and replays its recorded result without executing again`, async () => {
      const f = fixture(); const s = f.service();
      const first = await f.decide(s, kind, `id-${kind}`);
      expect(first).toMatchObject({ accepted: true });
      const replay = await f.decide(s, kind, `id-${kind}`);
      expect(replay).toMatchObject({ accepted: true, replay: true });
      expect(f.calls()).toBe(1);
      expect(f.events().filter(e => e.kind === 'decision_accepted')).toHaveLength(1);
      expect(f.events().filter(e => e.kind === (kind === 'resume_workspace' ? 'workspace_created' : `decision_${kind}`))).toHaveLength(1);
    });
  }

  it('ignores expected_revision on replay and returns current and recorded views', async () => {
    const f = fixture(); const s = f.service(); const revision = f.store().get(f.id).revision;
    await f.decide(s, 'resume_workspace', 'views', revision);
    const current = f.store().get(f.id);
    f.store().transition(f.id, { if_revision: current.revision, to: 'executing', event: { kind: 'test_advance', payload: {} } }, 3000);
    expect(await f.decide(s, 'resume_workspace', 'views', 999)).toMatchObject({ replay: true,
      mission_at_acceptance: { state: 'awaiting_decision' }, mission_at_decision: { state: 'workspace_ready' }, mission_current: { state: 'executing' } });
    expect(f.calls()).toBe(1);
  });

  it('refuses another principal before disclosing or continuing a decision', async () => {
    const f = fixture(); const revision = f.store().get(f.id).revision;
    f.store().record(f.id, 'decision_accepted', { decision_id: 'owner', principal_id: 'someone-else',
      digest: createHash('sha256').update(JSON.stringify({ kind: 'resume_workspace' })).digest('hex'), revision }, 2000);
    await expect(f.decide(f.service(), 'resume_workspace', 'owner')).rejects.toThrow('decision_id_owner_mismatch');
    expect(f.calls()).toBe(0);
  });

  for (const kind of kinds) {
    it(`${kind}: replays a busy admission as unknown`, async () => {
      const f = fixture(); const revision = f.store().get(f.id).revision;
      f.store().record(f.id, 'decision_accepted', { decision_id: 'busy', principal_id: 'human',
        digest: createHash('sha256').update(JSON.stringify({ kind })).digest('hex'), revision }, 2000);
      f.setBusy(true);
      expect(await f.decide(f.service(), kind, 'busy')).toMatchObject({ replay: true, outcome: 'unknown' });
      expect(f.calls()).toBe(0);
    });

    it(`${kind}: replays a recorded failure with the current mission`, async () => {
      const f = fixture(); const revision = f.store().get(f.id).revision;
      f.store().record(f.id, 'decision_accepted', { decision_id: 'failed', principal_id: 'human',
        digest: createHash('sha256').update(JSON.stringify({ kind })).digest('hex'), revision }, 2000);
      f.store().record(f.id, 'decision_effect_started', { decision_id: 'failed', effect: 'test' }, 2001);
      f.store().record(f.id, 'host_decision_failed', { decision_id: 'failed', code: 'test_failure', retryable: false }, 2002);
      expect(await f.decide(f.service(), kind, 'failed')).toMatchObject({ replay: true, outcome: 'failed', code: 'test_failure', mission_current: { revision } });
      expect(f.calls()).toBe(0);
    });
  }

  for (const kind of kinds.filter(k => !['abandon', 'approve_publication'].includes(k))) {
    it(`${kind}: records host_decision_failed before an effect and retries`, async () => {
      const f = fixture({ failOnce: 'CONTAINED_MISSION_BUSY' }); const s = f.service();
      expect(await f.decide(s, kind)).toMatchObject({ accepted: true, outcome: 'failed', code: 'CONTAINED_MISSION_BUSY' });
      expect(JSON.parse(f.events().find(e => e.kind === 'host_decision_failed')!.payload_json)).toMatchObject({ retryable: true });
      expect(await f.decide(s, kind)).toMatchObject({ accepted: true });
      expect(f.calls()).toBe(2);
    });
  }

  it('rejects a different decision under an accepted key without executing it', async () => {
    const f = fixture(); const s = f.service();
    await f.decide(s, 'abandon');
    await expect(f.decide(s, 'extra_repair')).rejects.toThrow('decision_id_conflict');
    expect(f.calls()).toBe(1);
  });

  it('rejects a stale revision with zero new events', async () => {
    const f = fixture(); const s = f.service(); const before = f.events().length;
    await expect(f.decide(s, 'abandon', 'stale', 1)).rejects.toThrow('stale_revision');
    expect(f.events()).toHaveLength(before);
    expect(f.calls()).toBe(0);
  });

  it('continues an accepted decision after reopening the SQLite database', async () => {
    const f = fixture();
    const digest = createHash('sha256').update(JSON.stringify({ kind: 'resume_workspace' })).digest('hex');
    const revision = f.store().get(f.id).revision;
    f.store().record(f.id, 'decision_accepted', { decision_id: 'crash', principal_id: 'human', digest, revision, kind: 'resume_workspace' }, 2000);
    f.reopen();
    const s = f.service();
    expect(await f.decide(s, 'resume_workspace', 'crash')).toMatchObject({ accepted: true, state: 'workspace_ready' });
    expect(f.store().get(f.id).revision).toBe(revision + 1);
    expect(f.calls()).toBe(1);
    expect(await f.decide(s, 'resume_workspace', 'crash')).toMatchObject({ replay: true, state: 'workspace_ready' });
    expect(f.store().get(f.id).revision).toBe(revision + 1);
    expect(f.calls()).toBe(1);
    expect(f.events().filter(e => e.kind === 'decision_accepted')).toHaveLength(1);
  });

  it('commits acceptance and the immediate transition together and replays the result', async () => {
    const f = fixture(); const s = f.service(); const before = f.store().get(f.id).revision;
    expect(await f.decide(s, 'abandon')).toMatchObject({ state: 'abandoned', accepted: true });
    expect(f.store().get(f.id).revision).toBe(before + 1);
    const names = f.events().map(e => e.kind);
    expect(names.slice(-3)).toEqual(['decision_accepted', 'decision_abandon', 'decision_result']);
    expect(await f.decide(s, 'abandon')).toMatchObject({ state: 'abandoned', replay: true });
    expect(f.calls()).toBe(1);
  });

  it('returns unknown when the revision advances after acceptance without a result', async () => {
    const f = fixture(); const revision = f.store().get(f.id).revision;
    const digest = createHash('sha256').update(JSON.stringify({ kind: 'abandon' })).digest('hex');
    f.store().record(f.id, 'decision_accepted', { decision_id: 'interrupted', principal_id: 'human', digest, revision, kind: 'abandon' }, 2000);
    f.store().transition(f.id, { if_revision: revision, to: 'abandoned', event: { kind: 'decision_abandon', payload: { decision_id: 'interrupted' } } }, 2001);
    const s = f.service();
    expect(await f.decide(s, 'abandon', 'interrupted')).toMatchObject({ accepted: true, replay: true, outcome: 'unknown', mission: { state: 'abandoned' } });
    expect(f.calls()).toBe(0);
  });
});
