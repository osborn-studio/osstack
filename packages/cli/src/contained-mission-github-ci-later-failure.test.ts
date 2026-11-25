import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRig, oid } from './contained-mission-bridge-shadow.testkit.js';
import { computeCiChainStats, readCiChain } from './contained-mission-ci-chain-read.js';
import { SANDBOX_CI_POLICY } from './contained-mission-ci-policy.js';
import { createSandboxCiObserver } from './contained-mission-github-ci.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

function ciEntry(canDispatch = true) {
  const rig = createRig(); const policy = SANDBOX_CI_POLICY;
  const head = oid('b'), base = oid('a'), branch = 'osstack/mission/later-failure';
  const repoPath = join(rig.root, 'repo'); mkdirSync(repoPath);
  const parent = rig.seedMission({ pr_number: 7, head, base_head: base, repository: policy.repository, branch,
    spec: { goal: 'fixture', repo_path: repoPath, base_ref: 'main', start_commit: base, branch,
      worktree_path: join(rig.root, 'seed'), allowed_paths: ['PROBE_FAIL'], verification_mode: 'github_actions', verify: { argv: [] }, max_repair_cycles: 0,
      publication: { remote: 'origin', repository: policy.repository, base: 'main', draft: false, preauthorized: true } } });
  rig.missions.record(parent, 'ci_delivery_evidence', { head, base_head: base, evidence_digest: 'fixture' }, 1100);
  rig.missions.record(parent, 'pr_opened', { verification_kind: 'github_actions', evidence_digest: 'fixture', pr: { number: 7 } }, 1101);
  const repo = { id: policy.repositoryId, full_name: policy.repository }; const app = { id: policy.actionsAppId };
  let checkRun = 41;
  let time = 2000;
  const makeObserver = () => createSandboxCiObserver({ store: rig.missions, scopeId: rig.scope.scope_id, enabled: () => true, now: () => ++time, log: () => {},
    ...(canDispatch ? { refresh: () => ({ ...rig.principal, operator_scopes: [rig.scope.scope_id] }) } : {}),
    worktreesRoot: join(rig.root, 'worktrees'),
    ci: {
      rest: async path => {
        if (path.endsWith('/pulls/7')) return { ok: true, body: { number: 7, state: 'open', merged: false,
          head: { sha: head, ref: branch, repo }, base: { sha: base, ref: 'main', repo }, user: { id: policy.publisherActorId, type: 'Bot' } } };
        if (path.includes('/contents/')) return { ok: true, body: { sha: policy.workflowBlob, type: 'file' } };
        if (path.includes('/check-suites?')) return { ok: true, body: { total_count: 1, check_suites: [{ id: 19, app, head_sha: head }] } };
        if (path.includes('/check-runs?')) return { ok: true, body: { total_count: 1, check_runs: [{ id: checkRun, name: 'check', app, head_sha: head,
          check_suite: { id: 19 }, status: 'completed', conclusion: 'failure' }] } };
        return { ok: false };
      },
      latestAttempt: async q => ({ ...q, complete: true, requests_used: 1, latest: { check_suite_id: 19, check_run_id: checkRun, status: 'completed', conclusion: 'failure' } }),
      observeLatestJob: async q => ({ outcome: 'failure', run_id: 2, workflow_id: policy.workflowId, attempt: 1,
        check_run_id: checkRun, check_suite_id: 19, job_id: checkRun, job_name: q.name, runner_labels: ['ubuntu-latest'], matrix: {},
        workflow_path: policy.workflowPath, head, base, app_id: app.id }),
    } });
  let observer = makeObserver();
  cleanup.push(async () => { await observer.stop(); rig.close(); });
  const events = () => rig.missions.events(parent);
  return {
    rig, parent, events,
    ofKind: (kind: string) => events().filter(e => e.kind === kind),
    chain: () => readCiChain(rig.db, rig.missions.get(parent))!,
    stats: () => computeCiChainStats(rig.db).ci_chain_later_failures,
    async scan(id: number) { checkRun = id; await observer.scan(); },
    async restart() { await observer.stop(); observer = makeObserver(); },
  };
}

describe('later CI failures on a root Mission', () => {
  const first = 'ci_failure_observed';
  const later = 'ci_later_failure_observed';
  const dispatched = 'ci_repair_dispatched';

  it('records a different check during repair and preserves the child and chain state across replay', async () => {
    const f = ciEntry();
    await f.scan(41);
    const dispatch = f.ofKind(dispatched)[0]!;
    const { child } = JSON.parse(dispatch.payload_json) as { child: string };
    const childRow = f.rig.missions.get(child);
    expect(childRow.state).not.toBe('pr_opened');
    const childEvents = f.rig.missions.events(child);
    const chain = f.chain();
    await f.scan(42);
    for (let i = 0; i < 3; i++) await f.scan(42);
    expect(f.ofKind(first).map(e => JSON.parse(e.payload_json).job.check_run_id)).toEqual([41]);
    expect(f.ofKind(dispatched)).toEqual([dispatch]);
    expect(f.ofKind(later)).toHaveLength(1);
    const event = f.ofKind(later)[0]!;
    expect(event.seq).toBeGreaterThan(dispatch.seq);
    expect(JSON.parse(event.payload_json)).toMatchObject({ repository: SANDBOX_CI_POLICY.repository, pr: 7,
      head: oid('b'), base: oid('a'), branch: 'osstack/mission/later-failure',
      first_check_run_id: 41, job: { check_run_id: 42, job_id: 42 }, phase: 'during_repair' });
    expect(f.chain()).toEqual({ ...chain, later_failures: {
      counts: 'later CI failures with a check run different from the first failure; no repair is dispatched for them',
      count: 1, first_since: event.created_at, latest: { check_run_id: 42, job_name: 'check', head: oid('b'),
        phase: 'during_repair', since: event.created_at },
    } });
    expect(f.rig.missions.get(child)).toEqual(childRow);
    expect(f.rig.missions.events(child)).toEqual(childEvents);
    expect(f.rig.db.prepare("SELECT COUNT(*) AS n FROM engineering_contained_missions WHERE json_extract(spec_json,'$.ci_repair.root')=?")
      .get(f.parent)).toEqual({ n: 1 });
    expect(f.stats()).toMatchObject({ chains: 1, chains_with_later_failure: 1, later_failures: 1 });
  });

  it('deduplicates by check run across observer restarts', async () => {
    const f = ciEntry();
    await f.scan(41);
    await f.restart();
    await f.scan(42);
    expect(f.ofKind(later)).toHaveLength(1);
    await f.scan(42);
    await f.restart();
    await f.scan(42);
    expect(f.ofKind(later)).toHaveLength(1);
  });

  it.each(['ci_pr_merged_observed', 'ci_closed_unmerged'])('leaves the ledger alone after %s', async kind => {
    const f = ciEntry();
    await f.scan(41);
    f.rig.missions.record(f.parent, kind, { pr: 7 }, 2500);
    const chain = f.chain();
    const events = f.events();
    await f.scan(42);
    expect(f.events()).toEqual(events);
    expect(f.ofKind(later)).toHaveLength(0);
    expect(f.chain()).toEqual(chain);
  });

  it('records only the first failure on a fresh root without a dispatch port', async () => {
    const f = ciEntry(false);
    const events = f.events();
    await f.scan(41);
    expect(f.events().slice(events.length).map(e => e.kind)).toEqual([first]);
    expect(f.chain().later_failures).toBeUndefined();
    expect(f.stats()).toMatchObject({ chains: 1, chains_with_later_failure: 0, later_failures: 0 });
  });

  it('records different checks before dispatch and ignores a replay of the first check', async () => {
    const f = ciEntry(false);
    await f.scan(41);
    const chain = f.chain();
    await f.scan(42);
    const events = f.events();
    await f.scan(41);
    expect(f.events()).toEqual(events);
    await f.scan(43);
    const observations = f.ofKind(later);
    expect(observations.map(e => JSON.parse(e.payload_json))).toMatchObject([
      { first_check_run_id: 41, phase: 'before_dispatch', job: { check_run_id: 42 } },
      { first_check_run_id: 41, phase: 'before_dispatch', job: { check_run_id: 43 } },
    ]);
    expect(f.ofKind(first)).toHaveLength(1);
    expect(f.ofKind(dispatched)).toHaveLength(0);
    expect(f.chain()).toMatchObject({ ...chain, later_failures: { count: 2, first_since: observations[0]!.created_at,
      latest: { check_run_id: 43, since: observations[1]!.created_at } } });
    expect(f.stats()).toMatchObject({ chains: 1, chains_with_later_failure: 1, later_failures: 2 });
  });

  it('defers a later observation when ownership is lost', async () => {
    const f = ciEntry();
    await f.scan(41);
    const events = f.events();
    const owner = vi.spyOn(f.rig.attention, 'assertOwner').mockImplementation(() => { throw Error('not_owner'); });
    try {
      await expect(f.scan(42)).resolves.toBeUndefined();
      expect(owner).toHaveBeenCalled();
      expect(f.events()).toEqual(events);
    } finally { owner.mockRestore(); }
  });
});
