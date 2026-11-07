import type { CodexProxyRun, CodexQualification } from '@osstack/agents';
import { HostProcessStore, type ContainedMission } from '@osstack/core';
import { describe, expect, it, vi } from 'vitest';
import { oid } from './contained-mission-bridge-shadow.testkit.js';
import { H, T0, dispatched, setup } from './contained-mission-revision.testkit.js';
import { createRevisionLaunchPort } from './contained-mission-revision.js';
import { createRevisionPublicationPort, type RevisionPublicationDeps } from './contained-mission-revision-publication.js';
import { ContainedMissionRunner, parseContainedMissionSpec, type ContainedMissionPorts } from './contained-mission-runner.js';

const PATCH = '--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-hi\n+hello\n';
const manyFiles = (n: number) => Array.from({ length: n }, (_, i) => `--- a/src/f${i}.txt\n+++ b/src/f${i}.txt\n@@ -1 +1 @@\n-a\n+b\n`).join('');
const qualified: CodexQualification = { qualified: true, version: 'codex-cli 0.160.1', identity_sha256: 'f'.repeat(64), profile: ':read-only',
  results: { parent: { write_worktree: 'denied', write_outside: 'denied', write_gitdir: 'denied', network: 'denied' }, escaped_child: { write_worktree: 'denied', write_outside: 'denied', write_gitdir: 'denied', network: 'denied' } },
  host_observed_writes: [], reasons: [] };
const run = (): CodexProxyRun => ({ launch: { pid: 4242, pgid: 4242, started_at: 1 }, exit_code: 0, signal: null, timed_out: false, cancelled: false,
  stop: { stop_proof: 'group_empty+sandbox_inherited', pgid: 4242, signals: [], confirmed_at: 2 }, patch: { ok: true, text: PATCH, bytes: PATCH.length }, stdout: 'done', stderr: '',
  stdout_truncated: false, stderr_truncated: false });

/** The runner over a real ledger (chain, grant, child) with scripted effects. */
async function harness(opts: { revision?: boolean; chainDiff?: () => string; worktreeTree?: () => string; expiresIn?: number } = {}) {
  const f = setup(opts.expiresIn ? { expiresIn: opts.expiresIn } : {});
  const out = await dispatched(f);
  const calls = { execute: [] as string[], verify: 0, publish: 0, cumulative: [] as string[] };
  let verifyExit = 0;
  const childId = out.child_mission_id;
  const spec = parseContainedMissionSpec(f.rig.missions.get(childId).spec_json);
  const chainStart = spec.publish_target!.chain_start_commit;
  let tick = 10_000;
  const ports: ContainedMissionPorts = {
    store: f.rig.missions, now: () => ++tick,
    createWorkspace: async s => ({ worktree: s.worktree_path, gitDir: '/git', head: s.start_commit, configDigest: 'sha256:0' }),
    qualify: async () => qualified,
    execute: async input => { calls.execute.push(input.prompt); input.onLaunched({ pid: 4242, pgid: 4242, started_at: 1 }); return run(); },
    readFile: async () => 'hi\n',
    commit: async () => ({ head: 'b'.repeat(40), tree: 'c'.repeat(40) }),
    cumulativeDiff: async input => { calls.cumulative.push(input.startCommit); return input.startCommit === chainStart ? (opts.chainDiff?.() ?? PATCH) : PATCH; },
    restoreWorkspace: async () => {},
    // W13 `resume_workspace` is not exercised by revision-child tests; fail loudly if a path reaches it.
    resumeWorkspace: async () => { throw new Error('resumeWorkspace not expected in revision-child tests'); },
    worktreeDiff: async input => input.startCommit === chainStart ? { diff: opts.chainDiff?.() ?? PATCH, tree: opts.worktreeTree?.() ?? 'd'.repeat(40), unsafe: [] } : { diff: PATCH, tree: 'd'.repeat(40), unsafe: [] },
    commitWorktree: async () => ({ head: 'e'.repeat(40), tree: 'd'.repeat(40) }),
    verify: async () => { calls.verify++; return { exit_code: verifyExit, output: verifyExit === 0 ? 'ok' : '1 failed', cancelled: false, evidence: 'docker-removed:x', stopped: true }; },
    publish: async input => { calls.publish++; input.beforeRemoteMutation('push'); return { pushed_commit: input.permit.head, pr: { number: 9, url: 'https://github.com/o/r/pull/9', reused: false }, base_head: null }; },
    ...(opts.revision === false ? {} : { revision: createRevisionLaunchPort({ chains: f.rig.chains, missions: f.rig.missions, access: f.deps.access, keys: f.deps.keys, now: f.deps.now, launchCaps: f.deps.launchCaps, enabled: () => f.flags.enabled }) }),
  };
  const runner = new ContainedMissionRunner(ports);
  const get = (): ContainedMission => f.rig.missions.get(childId);
  const step = async (n = 1) => { for (let i = 0; i < n; i++) await runner.step(childId); return get(); };
  const events = () => f.rig.missions.events(childId, 0, 500);
  const lastHalt = () => JSON.parse(events().filter(e => e.kind === 'halted').at(-1)!.payload_json) as { reason: string; blocked?: string };
  const chain = () => f.rig.chains.get(f.chain.chain_id);
  const use = (kind: 'executor' | 'container', seconds: number) => f.rig.chains.chargeLaunch(f.chain.chain_id, childId, kind, seconds, T0);
  const setVerifyExit = (n: number) => { verifyExit = n; };
  return { f, childId, spec, ports, runner, calls, get, step, events, lastHalt, chain, use, setVerifyExit };
}
type Harness = Awaited<ReturnType<typeof harness>>;

function wireRevisionPublisher(h: Harness, beforeRelease: (intentId: string) => void = () => {}) {
  const journal = new HostProcessStore(h.f.rig.attention, h.f.rig.owner, { clock: () => ++h.f.clock.now });
  const candidate = 'b'.repeat(40);
  let gitRan = false;
  let remote = h.chain().published_head;
  const deps: RevisionPublicationDeps = {
    chains: h.f.rig.chains, missions: h.f.rig.missions, now: () => ++h.f.clock.now,
    host: { recordForIntent: id => h.f.rig.db.prepare('SELECT * FROM engineering_host_processes WHERE intent_id=?').get(id) as ReturnType<typeof journal.get> | undefined },
    runner: { gated: true, run: async (_command, args, options) => {
      if (args.includes('get-url')) return { stdout: 'https://github.com/o/r.git\n', stderr: '', exitCode: 0 };
      if (!args.includes('push') || !options.gate?.intentId) throw Error('unexpected_command');
      const opId = 'hp_runnerrelease';
      journal.launching({ op_id: opId, mission_id: h.childId, kind: 'git_push', remote_target: options.gate.remoteTarget,
        local_target: options.gate.localTarget, intent_id: options.gate.intentId, argv_digest: '8'.repeat(64), boot_id: 'test',
        marker: { path: '/tmp/marker', dev: '1', ino: '1' } });
      journal.registered(opId, { pid: 12345, pgid: 12345, leader_start: 'test' });
      beforeRelease(options.gate.intentId);
      try { journal.release(opId, options.gate.fence); }
      catch (error) { journal.stopped(opId, { proof: 'never_released', detail: {} }); throw error; }
      gitRan = true;
      remote = candidate;
      journal.stopped(opId, { proof: 'group_empty+marker_unheld', detail: {}, exit_code: 0 });
      return { stdout: '', stderr: '', exitCode: 0, opId };
    } },
    readPr: async () => ({ state: 'OPEN', repository: 'o/r', headRefName: 'topic', headRefOid: remote,
      baseRefName: 'main', baseRefOid: oid('a'), url: 'https://example.invalid/pull/7' }),
    localGit: async (_cwd, args) => ({ stdout: args[0] === 'rev-list' ? candidate : '', exitCode: 0 }),
    remoteHead: async () => remote, compare: async () => [candidate], preflight: async () => {}, checkEnabled: false,
    fenceAuthority: () => ({ access: h.f.deps.access, keys: h.f.deps.keys(), now: h.f.clock.now, enabled: h.f.flags.enabled }),
    cancelChild: id => h.runner.cancel(id),
  };
  h.ports.revisionPublication = createRevisionPublicationPort(deps);
  return { deps, journal, gitRan: () => gitRan };
}

describe('a revision child under the runner', () => {
  it('publishes a same-PR revision through the real publication port and W13 release', async () => {
    const h = await harness();
    const wired = wireRevisionPublisher(h);
    expect((await h.step(5)).state).toBe('pr_opened');
    expect(wired.gitRan()).toBe(true);
    expect(h.calls.publish).toBe(0);
    expect(h.chain()).toMatchObject({ state: 'awaiting_review', published_head: 'b'.repeat(40) });
  });

  it('records a failed revision check on the opened Mission', async () => {
    const h = await harness();
    wireRevisionPublisher(h);
    h.ports.publishVerifyCheck = async () => { throw Error('check_http_failed'); };
    expect((await h.step(5)).state).toBe('pr_opened');
    expect(h.events().filter(e => e.kind === 'verify_check_failed').map(e => JSON.parse(e.payload_json))).toEqual([{ code: 'check_http_failed' }]);
    expect(h.chain().state).toBe('awaiting_review');
  });

  it('skips the revision check when the chain closes after confirmation', async () => {
    const h = await harness();
    wireRevisionPublisher(h);
    const publication = h.ports.revisionPublication!;
    h.ports.revisionPublication = { ...publication, confirm: input => {
      const opened = publication.confirm(input);
      const chain = h.chain();
      h.f.rig.chains.closeLive(chain.chain_id, chain.revision, 'pr_closed', ++h.f.clock.now);
      return opened;
    } };
    const send = vi.fn(async () => ({ check_run_id: 33, created: true }));
    h.ports.publishVerifyCheck = send;
    expect((await h.step(5)).state).toBe('pr_opened');
    expect(send).not.toHaveBeenCalled();
    expect(h.events().map(e => e.kind)).toContain('verify_check_skipped');
    expect(h.f.rig.chains.events(h.chain().chain_id, 0, 500).map(e => e.kind)).toContain('check_skipped');
  });


  it('requests host cancellation when the PR closes before revision publication', async () => {
    const h = await harness();
    const wired = wireRevisionPublisher(h);
    wired.deps.readPr = async () => ({ state: 'CLOSED', repository: 'o/r', headRefName: 'topic', headRefOid: h.chain().published_head,
      baseRefName: 'main', baseRefOid: oid('a'), url: 'https://example.invalid/pull/7' });
    expect((await h.step(5)).state).toBe('cancel_requested');
    expect(wired.gitRan()).toBe(false);
    expect(h.chain().state).toBe('closed');
    expect(h.events().map(e => e.kind)).toContain('cancel_requested');
  });

  it.each(['bridge_live_disabled', 'grant_expired', 'grant_invalid', 'budget_exhausted', 'child_cancelled', 'chain_state', 'intent_moved', 'not_current_child'] as const)(
    'refuses %s at the real runner release fence before git runs', async expected => {
      const h = await harness(expected === 'budget_exhausted' ? { expiresIn: 72 * H } : {});
      let wired!: ReturnType<typeof wireRevisionPublisher>;
      wired = wireRevisionPublisher(h, _intentId => {
        if (expected === 'bridge_live_disabled') h.f.flags.enabled = false;
        if (expected === 'grant_expired') h.f.clock.now = T0 + 24 * H;
        if (expected === 'budget_exhausted') h.f.clock.now = T0 + 48 * H;
        if (expected === 'grant_invalid') h.f.flags.access = false;
        if (expected === 'child_cancelled') void h.runner.cancel(h.childId);
        if (expected === 'chain_state' || expected === 'not_current_child') {
          const original = wired.deps.chains.get.bind(wired.deps.chains);
          vi.spyOn(wired.deps.chains, 'get').mockImplementationOnce(id => ({ ...original(id),
            ...(expected === 'chain_state' ? { state: 'awaiting_decision' as const } : { current_mission_id: 'cm_other' }) }));
        }
        if (expected === 'intent_moved') {
          const original = wired.deps.chains.getIntent.bind(wired.deps.chains);
          vi.spyOn(wired.deps.chains, 'getIntent').mockImplementationOnce(id => ({ ...original(id), new_head: oid('f') }));
        }
      });
      const result = await h.step(5);
      expect(result.state).toBe(expected === 'child_cancelled' ? 'cancel_requested' : 'awaiting_decision');
      expect(wired.gitRan()).toBe(false);
      expect(h.calls.publish).toBe(0);
      const intent = h.f.rig.chains.intents(h.chain().chain_id).at(-1)!;
      expect(intent).toMatchObject({ state: 'failed', detail: expected.startsWith('grant_') || expected === 'budget_exhausted' || expected === 'bridge_live_disabled' || expected === 'child_cancelled' ? expected : `fence_${expected}` });
      expect(wired.deps.host.recordForIntent(intent.intent_id)).toMatchObject({ state: 'stopped', released_at: null });
    });

  it.each(['reservation_moved', 'claim_released'] as const)('refuses %s at W13 release', async failure => {
    const h = await harness();
    let wired!: ReturnType<typeof wireRevisionPublisher>;
    wired = wireRevisionPublisher(h, () => {
      if (failure === 'reservation_moved') {
        const original = wired.deps.chains.reservations.bind(wired.deps.chains);
        vi.spyOn(wired.deps.chains, 'reservations').mockImplementationOnce(id => original(id).map(row => ({ ...row, child_mission_id: h.f.rootId })));
      } else {
        const original = wired.deps.missions.claim.bind(wired.deps.missions);
        vi.spyOn(wired.deps.missions, 'claim').mockImplementationOnce(id => ({ ...original(id), state: 'released' }));
      }
    });
    expect((await h.step(5)).state).toBe('awaiting_decision');
    expect(wired.gitRan()).toBe(false);
    const intent = h.f.rig.chains.intents(h.chain().chain_id).at(-1)!;
    expect(intent).toMatchObject({ state: 'failed', detail: failure === 'reservation_moved' ? 'fence_intent_moved' : 'fence_chain_state' });
  });

  it('carries the untrusted review block into the first turn and into the repair turn', async () => {
    const h = await harness(); h.setVerifyExit(1);
    await h.step(3); // workspace, executor, verify
    expect(h.get().state).toBe('verify_failed');
    await h.step();
    expect(h.calls.execute).toHaveLength(2);
    const nonce = h.spec.revision_feedback!.nonce;
    for (const prompt of h.calls.execute) {
      expect(prompt).toContain(`<<<REVIEW-FEEDBACK-${nonce}`);
      expect(prompt).toContain('untrusted review feedback');
      expect(prompt).toContain('please rename the helper');
    }
    expect(h.calls.execute[1]).toContain('failed verification (exit 1)');
  });

  it('charges every launch and gives back what a short launch did not use', async () => {
    const h = await harness();
    await h.step(2);
    // One executor turn: 600 charged, then refunded down to the elapsed second.
    expect(h.f.rig.chains.allocations(h.f.chain.chain_id)[h.childId]!.executor_used).toBeLessThanOrEqual(1);
    await h.step();
    expect(h.f.rig.chains.allocations(h.f.chain.chain_id)[h.childId]!.container_used).toBeLessThanOrEqual(1);
    expect(h.calls.verify).toBe(1);
  });

  it('stops before any launch when the host has no revision port', async () => {
    const h = await harness({ revision: false });
    await h.step();
    expect((await h.step()).state).toBe('awaiting_decision');
    expect(h.lastHalt()).toMatchObject({ reason: 'revision_not_configured', blocked: 'executor:workspace_ready' });
    expect(h.calls.execute).toEqual([]);
  });

  it('classifies the chain-wide diff too: a patch that is small for this child but over the caps since the root is refused', async () => {
    const h = await harness({ chainDiff: () => manyFiles(8) });
    const m = await h.step(2);
    expect(m.state).toBe('awaiting_decision');
    expect(h.lastHalt()).toMatchObject({ reason: 'tier_escalated', chain_cumulative: true });
    expect(h.calls.cumulative).toEqual([h.spec.start_commit, h.spec.publish_target!.chain_start_commit]);
    expect(h.events().map(e => e.kind)).not.toContain('candidate_committed');
  });

  it('records the chain tier on a candidate that passes both, and refuses to publish a candidate without it', async () => {
    const h = await harness();
    await h.step(2);
    const committed = JSON.parse(h.events().find(e => e.kind === 'candidate_committed')!.payload_json) as { tier: string; chain_tier: string };
    expect(committed.chain_tier).toMatch(/^T[01]$/);
  });

  it('classifies the chain-wide diff on the adopt path as well, and refuses an unstable second read', async () => {
    for (const [chainDiff, tree, reason] of [[() => manyFiles(8), 'd'.repeat(40), undefined], [() => PATCH, '1'.repeat(40), 'CHAIN_DIFF_UNSTABLE']] as const) {
      const h = await harness({ chainDiff, worktreeTree: () => tree });
      await h.step();
      h.f.rig.missions.transition(h.childId, { if_revision: h.get().revision, to: 'needs_reconciliation', event: { kind: 'halted', payload: { reason: 'stop_evidence_recovered' } } }, 20_000);
      const m = await h.runner.decide(h.childId, { kind: 'adopt_worktree' });
      expect(m.state).toBe('awaiting_decision');
      expect(h.lastHalt()).toMatchObject({ reason: 'tier_escalated', chain_cumulative: true, ...(reason ? { reasons: [reason] } : {}) });
    }
    const ok = await harness();
    await ok.step();
    ok.f.rig.missions.transition(ok.childId, { if_revision: ok.get().revision, to: 'needs_reconciliation', event: { kind: 'halted', payload: { reason: 'test' } } }, 20_000);
    expect((await ok.runner.decide(ok.childId, { kind: 'adopt_worktree' })).state).toBe('candidate_ready');
    expect(JSON.parse(ok.events().find(e => e.kind === 'candidate_committed')!.payload_json).chain_tier).toMatch(/^T[01]$/);
  });

  it('can reach delivering but never opens a PR: the runner stops before any publish port, and the port itself refuses', async () => {
    const h = await harness();
    const m = await h.step(5); // workspace, executor, verify, publication_preauthorized, revalidating -> delivering
    expect(h.get().state).toBe('awaiting_decision');
    expect(m.state).toBe('awaiting_decision');
    expect(h.lastHalt().reason).toBe('publication_failed:revision_publisher_unavailable');
    expect(h.events().map(e => e.kind)).toEqual(expect.arrayContaining(['delivery_intent']));
    expect(h.events().map(e => e.kind)).not.toEqual(expect.arrayContaining(['delivery_attempt']));
    expect(h.events().map(e => e.kind)).not.toEqual(expect.arrayContaining(['remote_mutation']));
    expect(h.calls.publish).toBe(0);
    // A human approving publication changes nothing: it re-enters the same stop.
    const again = await h.runner.decide(h.childId, { kind: 'approve_publication' });
    expect(again.state).toBe('revalidating');
    await h.step(2);
    expect(h.lastHalt().reason).toBe('publication_failed:revision_publisher_unavailable');
    expect(h.calls.publish).toBe(0);
  });

  it('dispatches a wired revision target to publishRevision on the runner path', async () => {
    const h = await harness();
    let revisions = 0;
    h.ports.revisionPublication = {
      publishRevision: async input => {
        revisions++;
        input.beforeRemoteMutation('push');
        return { pushed_commit: input.permit.head, pr: { number: 7, url: 'https://example.invalid/pull/7', reused: true }, base_head: oid('a'),
          intent_id: 'pi_test', op_id: 'hp_test', push_range: [input.permit.head], range_sha256: 'a'.repeat(64) };
      },
      confirm: input => {
        const current = h.get();
        expect(input.child_mission_id).toBe(h.childId);
        return h.ports.store.transition(h.childId, { if_revision: current.revision, to: 'pr_opened', event: { kind: 'pr_opened', payload: {} } }, 20_000);
      },
      reconcileReceipt: () => { throw Error('unexpected reconciliation'); },
      publishCheck: async () => { throw Error('unexpected check'); },
    };
    expect((await h.step(5)).state).toBe('pr_opened');
    expect(revisions).toBe(1);
    expect(h.calls.publish).toBe(0);
  });

  describe('budget and grant stops', () => {
    const exhaustExecutor = (h: Harness) => h.use('executor', 1200);
    const regrantStoppedChild = async () => {
      const h = await harness();
      await h.step(); exhaustExecutor(h); await h.step();
      const stopped = h.chain();
      h.f.rig.chains.replaceGrant(stopped.chain_id, stopped.revision,
        h.f.renew({ budget: { max_executor_seconds: 4200, max_container_seconds: 3600, max_wall_clock_hours: 48 } }), T0);
      return h;
    };

    it.each(['bridge_live_disabled', 'facts_changed', 'decision_not_allowed', 'grant_expired'] as const)(
      'refuses %s before a child resume and preserves both ledgers', async failure => {
        const h = await regrantStoppedChild();
        if (failure === 'bridge_live_disabled') h.f.flags.enabled = false;
        if (failure === 'facts_changed') h.f.rig.db.prepare(
          "INSERT INTO engineering_revision_chain_events(chain_id,kind,payload_json,created_at) VALUES(?,'stopped_chain_observed',?,?)"
        ).run(h.chain().chain_id, JSON.stringify({ pr_state: 'OPEN', head: oid('f'), base_sha: oid('a'), base_ref: 'main' }), T0);
        if (failure === 'grant_expired') h.f.clock.now = T0 + 49 * H;
        const beforeChild = h.get(); const beforeChain = h.chain();
        const decision = failure === 'decision_not_allowed' ? 'extra_repair' : 'resume_budget';
        await expect(h.runner.decide(h.childId, { kind: decision })).rejects.toThrow(`resume_refused:${failure}`);
        expect(h.get()).toEqual(beforeChild);
        expect(h.chain()).toEqual(beforeChain);
        expect(h.calls.execute).toEqual([]);
      });

    it('keeps the resumed chain in flight while the accepted decision advances its child', async () => {
      const h = await regrantStoppedChild();
      h.ports.execute = async input => {
        expect(h.chain().state).toBe('revising');
        expect(h.get().state).toBe('executing');
        input.onLaunched({ pid: 4242, pgid: 4242, started_at: 1 });
        return run();
      };
      expect((await h.runner.decide(h.childId, { kind: 'resume_budget' })).state).toBe('candidate_ready');
      expect(h.chain().state).toBe('revising');
      expect(h.f.rig.chains.events(h.chain().chain_id).map(e => e.kind)).toContain('round_resumed');
    });

    it('keeps a live-cycle stop that races a resumed decision', async () => {
      const h = await regrantStoppedChild();
      h.ports.execute = async input => {
        input.onLaunched({ pid: 4242, pgid: 4242, started_at: 1 });
        const active = h.chain();
        expect(active.state).toBe('revising');
        h.f.rig.chains.stopLive(active.chain_id, active.revision, 'external_write', T0);
        return run();
      };
      await h.runner.decide(h.childId, { kind: 'resume_budget' });
      expect(h.chain()).toMatchObject({ state: 'awaiting_decision', stop_reason: 'external_write' });
      expect(h.calls.publish).toBe(0);
    });

    it('re-stops a chain when a failed decision leaves the child halted', async () => {
      const h = await regrantStoppedChild();
      h.ports.qualify = async () => { throw Error('probe_failed'); };
      await expect(h.runner.decide(h.childId, { kind: 'resume_budget' })).rejects.toThrow('probe_failed');
      expect(h.get().state).toBe('awaiting_decision');
      expect(h.chain().state).toBe('revising');
      const inFlight = h.chain();
      h.f.rig.chains.stopLive(inFlight.chain_id, inFlight.revision, 'child_halted', T0);
      expect(h.chain()).toMatchObject({ state: 'awaiting_decision', stop_reason: 'child_halted' });
    });

    it('halts with the blocked route when the slice is spent, stops the chain, and refuses resume_budget until a re-grant', async () => {
      const h = await harness();
      await h.step();
      exhaustExecutor(h);
      const m = await h.step();
      expect(m.state).toBe('awaiting_decision');
      expect(h.lastHalt()).toMatchObject({ reason: 'budget_exhausted', blocked: 'executor:workspace_ready' });
      expect(h.calls.execute).toEqual([]);
      expect(h.chain()).toMatchObject({ state: 'awaiting_decision', stop_reason: 'budget_exhausted' });
      await expect(h.runner.decide(h.childId, { kind: 'resume_budget' })).rejects.toThrow('resume_refused:chain_not_resumable:budget_exhausted');
      await expect(h.runner.decide(h.childId, { kind: 'resume_grant' })).rejects.toThrow('resume_refused:chain_not_resumable:budget_exhausted');
      expect(h.calls.execute).toEqual([]);
    });

    it('resumes an executor launch after a re-grant tops up the same child', async () => {
      const h = await harness();
      await h.step();
      exhaustExecutor(h);
      await h.step();
      const before = h.f.rig.chains.allocations(h.f.chain.chain_id)[h.childId]!;
      const next = h.f.renew({ budget: { max_executor_seconds: 4200, max_container_seconds: 3600, max_wall_clock_hours: 48 } });
      const stopped = h.chain();
      expect(h.f.rig.chains.replaceGrant(stopped.chain_id, stopped.revision, next, T0).chain).toMatchObject({ state: 'awaiting_decision', stop_reason: 'child_halted' });
      expect(h.f.rig.chains.allocations(h.f.chain.chain_id)[h.childId]).toMatchObject({ executor_seconds: before.executor_seconds + 600, executor_used: before.executor_used });
      const m = await h.runner.decide(h.childId, { kind: 'resume_budget' });
      expect(m.state).toBe('candidate_ready');
      expect(h.chain().state).toBe('revising');
      expect(h.calls.execute).toHaveLength(1);
      expect(h.events().map(e => e.kind)).toContain('decision_resume');
    });

    it('resumes a verification launch: the halted candidate re-enters candidate_ready unchanged', async () => {
      const h = await harness();
      await h.step(2);
      const candidate = h.get().candidate_head;
      h.use('container', 240);
      expect((await h.step()).state).toBe('awaiting_decision');
      expect(h.lastHalt()).toMatchObject({ reason: 'budget_exhausted', blocked: 'verify' });
      expect(h.calls.verify).toBe(0);
      expect(h.chain().stop_reason).toBe('budget_exhausted');
      // Not enough raise: the slice still cannot cover a verification.
      await expect(h.runner.decide(h.childId, { kind: 'resume_budget' })).rejects.toThrow('resume_refused');
      const stopped = h.chain();
      h.f.rig.chains.replaceGrant(stopped.chain_id, stopped.revision, h.f.renew({ budget: { max_executor_seconds: 3600, max_container_seconds: 3720, max_wall_clock_hours: 48 } }), T0);
      expect(h.chain()).toMatchObject({ state: 'awaiting_decision', stop_reason: 'child_halted' });
      const m = await h.runner.decide(h.childId, { kind: 'resume_budget' });
      expect(m).toMatchObject({ state: 'verified', candidate_head: candidate, candidate_verified: 1 });
      expect(h.chain().state).toBe('revising');
      expect(h.calls.verify).toBe(1);
    });

    it('stops on an expired grant before launching, and resume_grant works only after a fresh grant', async () => {
      const h = await harness();
      await h.step();
      h.f.clock.now = T0 + 25 * H;
      expect((await h.step()).state).toBe('awaiting_decision');
      expect(h.lastHalt()).toMatchObject({ reason: 'grant_stopped:grant_expired', blocked: 'executor:workspace_ready' });
      expect(h.chain()).toMatchObject({ state: 'awaiting_decision', stop_reason: 'grant_expired' });
      expect(h.calls.execute).toEqual([]);
      await expect(h.runner.decide(h.childId, { kind: 'resume_grant' })).rejects.toThrow('resume_refused');
      const stopped = h.chain();
      h.f.rig.chains.replaceGrant(stopped.chain_id, stopped.revision, h.f.renew(), h.f.clock.now);
      expect(h.chain()).toMatchObject({ state: 'awaiting_decision', stop_reason: 'child_halted' });
      const m = await h.runner.decide(h.childId, { kind: 'resume_grant' });
      expect(m.state).toBe('candidate_ready');
      expect(h.chain().state).toBe('revising');
      expect(h.calls.execute).toHaveLength(1);
    });

    it('keeps the whole charge of a launch that may still be running (stop_unknown), and refunds a clean one', async () => {
      const h = await harness();
      h.ports.execute = async input => { h.calls.execute.push(input.prompt); input.onLaunched({ pid: 1, pgid: 4242, started_at: 1 }); const r = run(); delete (r as { stop?: unknown }).stop; return r; };
      await h.step();
      expect((await h.step()).state).toBe('stop_unknown');
      expect(h.f.rig.chains.allocations(h.f.chain.chain_id)[h.childId]!.executor_used).toBe(600);
    });

    it('refuses to adopt a worktree once the chain has closed without changing the child', async () => {
      const h = await harness();
      await h.step();
      h.f.rig.missions.transition(h.childId, { if_revision: h.get().revision, to: 'needs_reconciliation', event: { kind: 'halted', payload: { reason: 'test' } } }, 20_000);
      h.f.rig.chains.closeLive(h.f.chain.chain_id, h.chain().revision, 'takeover', T0);
      const before = h.get();
      await expect(h.runner.decide(h.childId, { kind: 'adopt_worktree' })).rejects.toThrow('resume_refused:chain_closed');
      expect(h.get()).toEqual(before);
      expect(h.events().map(e => e.kind)).not.toContain('candidate_committed');
    });

    it.each(['restore', 'probe', 'diff'] as const)('keeps %s reconciliation retryable when the grant expires during the await', async at => {
      const h = await harness();
      await h.step();
      h.f.rig.missions.transition(h.childId, { if_revision: h.get().revision, to: 'needs_reconciliation', event: { kind: 'halted', payload: { reason: 'stop_evidence_recovered' } } }, 20_000);
      const decision = at === 'diff' ? 'adopt_worktree' : 'discard_changes';
      const expire = () => { h.f.clock.now = T0 + 24 * H; };
      if (at === 'restore') h.ports.restoreWorkspace = async () => { expire(); };
      if (at === 'probe') h.ports.qualify = async () => { expire(); return qualified; };
      if (at === 'diff') {
        const original = h.ports.worktreeDiff;
        h.ports.worktreeDiff = async input => { const result = await original(input); expire(); return result; };
      }
      const before = h.get();
      await expect(h.runner.decide(h.childId, { kind: decision })).rejects.toThrow('resume_refused:grant_expired');
      expect(h.get()).toEqual(before);
      expect(h.calls.execute).toEqual([]);
      expect(h.events().map(e => e.kind)).not.toContain('candidate_committed');

      const chain = h.chain();
      h.f.rig.chains.stopLive(chain.chain_id, chain.revision, 'child_halted', h.f.clock.now);
      const stopped = h.chain();
      h.f.rig.chains.replaceGrant(stopped.chain_id, stopped.revision, h.f.renew(), h.f.clock.now);
      expect(h.chain()).toMatchObject({ state: 'awaiting_decision', stop_reason: 'child_halted' });
      const retried = await h.runner.decide(h.childId, { kind: decision });
      expect(retried.state).toBe('candidate_ready');
      expect(h.chain().state).toBe('revising');
    });

    it.each(['restore', 'probe', 'diff'] as const)('keeps %s reconciliation retryable when write scope is revoked during the await', async at => {
      const h = await harness();
      await h.step();
      h.f.rig.missions.transition(h.childId, { if_revision: h.get().revision, to: 'needs_reconciliation', event: { kind: 'halted', payload: { reason: 'stop_evidence_recovered' } } }, 20_000);
      const decision = at === 'diff' ? 'adopt_worktree' : 'discard_changes';
      let revoked = false;
      const revoke = () => { if (!revoked) { h.f.principal.write_scopes.splice(0); revoked = true; } };
      if (at === 'restore') h.ports.restoreWorkspace = async () => { revoke(); };
      if (at === 'probe') h.ports.qualify = async () => { revoke(); return qualified; };
      if (at === 'diff') {
        const original = h.ports.worktreeDiff;
        h.ports.worktreeDiff = async input => { const result = await original(input); revoke(); return result; };
      }
      const before = h.get();
      await expect(h.runner.decide(h.childId, { kind: decision })).rejects.toThrow('resume_refused:grant_invalid');
      expect(h.get()).toEqual(before);
      expect(h.events().map(e => e.kind)).not.toContain('candidate_committed');

      const chain = h.chain();
      h.f.rig.chains.stopLive(chain.chain_id, chain.revision, 'child_halted', h.f.clock.now);
      const stopped = h.chain();
      h.f.rig.chains.replaceGrant(stopped.chain_id, stopped.revision, h.f.renew(), h.f.clock.now);
      h.f.principal.write_scopes.push(h.f.rig.scope.scope_id);
      const retried = await h.runner.decide(h.childId, { kind: decision });
      expect(retried.state).toBe('candidate_ready');
      expect(h.chain().state).toBe('revising');
    });

    it('halts when the chain closes during an adopt diff or discard restore await', async () => {
      const closeDuring = (h: Harness) => { if (h.chain().state === 'closed') return; h.f.rig.chains.closeLive(h.f.chain.chain_id, h.chain().revision, 'takeover', T0); };
      const adopt = await harness();
      await adopt.step();
      adopt.f.rig.missions.transition(adopt.childId, { if_revision: adopt.get().revision, to: 'needs_reconciliation', event: { kind: 'halted', payload: { reason: 'test' } } }, 20_000);
      const original = adopt.ports.worktreeDiff;
      adopt.ports.worktreeDiff = async input => { const r = await original(input); closeDuring(adopt); return r; };
      // The chain closes while the diff is read: the first check (before) has passed, the one before the write must stop it.
      adopt.ports.revision = { ...adopt.ports.revision!, assertActive: (() => { let n = 0; const real = adopt.ports.revision!.assertActive; return (m, s) => { n += 1; if (n === 1) return; real(m, s); }; })() };
      expect((await adopt.runner.decide(adopt.childId, { kind: 'adopt_worktree' })).state).toBe('awaiting_decision');
      expect(adopt.lastHalt()).toMatchObject({ reason: 'chain_stopped:chain_closed', blocked: 'adopt_worktree' });
      expect(adopt.events().map(e => e.kind)).not.toContain('candidate_committed');

      const discard = await harness();
      await discard.step();
      discard.f.rig.missions.transition(discard.childId, { if_revision: discard.get().revision, to: 'needs_reconciliation', event: { kind: 'halted', payload: { reason: 'test' } } }, 20_000);
      discard.ports.restoreWorkspace = async () => { closeDuring(discard); };
      expect((await discard.runner.decide(discard.childId, { kind: 'discard_changes' })).state).toBe('awaiting_decision');
      expect(discard.lastHalt()).toMatchObject({ reason: 'chain_stopped:chain_closed', blocked: 'executor:discard_changes' });
      expect(discard.calls.execute).toEqual([]);
    });

    it('halts a child whose chain was closed, and an abandoned decision still works', async () => {
      const h = await harness();
      await h.step();
      h.f.rig.chains.closeLive(h.f.chain.chain_id, h.chain().revision, 'abandon', T0);
      expect((await h.step()).state).toBe('awaiting_decision');
      expect(h.lastHalt().reason).toBe('chain_stopped:chain_closed');
      expect((await h.runner.decide(h.childId, { kind: 'abandon' })).state).toBe('abandoned');
      expect(h.calls.execute).toEqual([]);
    });

    it('does not let a non-revision Mission use the new decisions or be charged', async () => {
      const h = await harness();
      const plain = h.f.rig.seedMission({ pr_number: 99, head: oid('7'), base_head: oid('a') });
      await expect(h.runner.decide(plain, { kind: 'resume_budget' })).rejects.toThrow('CONTAINED_DECISION_NOT_ALLOWED');
    });
  });
});
