import { withRootDepth, withLegacyRoot } from './contained-mission-lineage.testkit.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContainedMissionStore } from '@osstack/core';
import { createRig, oid } from './contained-mission-bridge-shadow.testkit.js';
import { setup as revisionSetup } from './contained-mission-revision.testkit.js';
import { createSandboxCiObserver } from './contained-mission-github-ci.js';
import { SANDBOX_CI_POLICY } from './contained-mission-ci-policy.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
interface Entry {
  store: ContainedMissionStore; parent: string; source: string;
  dispatch(): Promise<string | undefined>;
  waiting(): string | undefined;
}
function ciEntry(): Entry {
  const rig = createRig(); const policy = SANDBOX_CI_POLICY;
  const head = oid('b'), base = oid('a'), branch = 'osstack/mission/lineage';
  const repoPath = join(rig.root, 'repo'); mkdirSync(repoPath);
  const parent = rig.seedMission({ pr_number: 7, head, base_head: base, repository: policy.repository, branch,
    spec: { goal: 'fixture', repo_path: repoPath, base_ref: 'main', start_commit: base, branch,
      worktree_path: join(rig.root, 'seed'), allowed_paths: ['PROBE_FAIL'], verification_mode: 'github_actions', verify: { argv: [] }, max_repair_cycles: 0,
      publication: { remote: 'origin', repository: policy.repository, base: 'main', draft: false, preauthorized: true } } });
  rig.missions.record(parent, 'ci_delivery_evidence', { head, base_head: base, evidence_digest: 'fixture' }, 1100);
  rig.missions.record(parent, 'pr_opened', { verification_kind: 'github_actions', evidence_digest: 'fixture', pr: { number: 7 } }, 1101);
  const repo = { id: policy.repositoryId, full_name: policy.repository }; const app = { id: policy.actionsAppId };
  const observer = createSandboxCiObserver({ store: rig.missions, scopeId: rig.scope.scope_id, enabled: () => true, now: () => 2000, log: () => {},
    refresh: () => ({ ...rig.principal, operator_scopes: [rig.scope.scope_id] }), worktreesRoot: join(rig.root, 'worktrees'),
    ci: {
      rest: async path => {
        if (path.endsWith('/pulls/7')) return { ok: true, body: { number: 7, state: 'open', merged: false,
          head: { sha: head, ref: branch, repo }, base: { sha: base, ref: 'main', repo }, user: { id: policy.publisherActorId, type: 'Bot' } } };
        if (path.includes('/contents/')) return { ok: true, body: { sha: policy.workflowBlob, type: 'file' } };
        if (path.includes('/check-suites?')) return { ok: true, body: { total_count: 1, check_suites: [{ id: 19, app, head_sha: head }] } };
        if (path.includes('/check-runs?')) return { ok: true, body: { total_count: 1, check_runs: [{ id: 41, name: 'check', app, head_sha: head,
          check_suite: { id: 19 }, status: 'completed', conclusion: 'failure' }] } };
        return { ok: false };
      },
      latestAttempt: async q => ({ ...q, complete: true, requests_used: 1, latest: { check_suite_id: 19, check_run_id: 41, status: 'completed', conclusion: 'failure' } }),
      observeLatestJob: async q => ({ outcome: 'failure', run_id: 2, workflow_id: policy.workflowId, attempt: 1,
        check_run_id: 41, check_suite_id: 19, job_id: 41, job_name: q.name, runner_labels: ['ubuntu-latest'], matrix: {},
        workflow_path: policy.workflowPath, head, base, app_id: app.id }),
    } });
  cleanup.push(async () => { await observer.stop(); rig.close(); });
  return { store: rig.missions, parent, source: 'github_actions',
    async dispatch() { await observer.scan(); const e = rig.missions.events(parent).find(e => e.kind === 'ci_repair_dispatched'); return e ? (JSON.parse(e.payload_json) as { child: string }).child : undefined; },
    waiting() { const e = rig.missions.events(parent).find(e => e.kind === 'mission_lineage_unknown'); return e ? (JSON.parse(e.payload_json) as { reason: string }).reason : undefined; } };
}
function reviewEntry(): Entry {
  const f = revisionSetup();
  return { store: f.rig.missions, parent: f.rootId, source: 'review',
    async dispatch() { await f.dispatch(); return f.rig.chains.get(f.chain.chain_id).current_mission_id ?? undefined; },
    waiting() { return f.rig.chains.get(f.chain.chain_id).stop_reason ?? undefined; } };
}
const entries = [{ name: 'CI repair', setup: ciEntry }, { name: 'review revision', setup: reviewEntry }];
describe.each(entries)('$name lineage contract', ({ setup }) => {
  it('inherits parent depth and origin and redelivery adds no Mission, claim, lineage or event', async () => {
    const f = setup(); const parent = f.store.lineage(f.parent)!; const child = await f.dispatch(); expect(child).toBeDefined();
    expect(f.store.lineage(child!)).toMatchObject({ parent_mission_id: f.parent, origin_mission_id: parent.origin_mission_id, chain_depth: parent.chain_depth + 1, source_kind: f.source });
    const counts = () => ['engineering_contained_missions', 'engineering_workspace_claims', 'engineering_mission_lineage', 'engineering_contained_events'].map(t => f.store.db.prepare(`SELECT count(*) n FROM ${t}`).get());
    const before = counts(); expect(await f.dispatch()).toBe(child); expect(counts()).toEqual(before);
  });
  it('registers one stop without consuming the dispatch on repeat scans', async () => {
    const f = withRootDepth(7, setup);
    const chains = () => f.store.db.prepare('SELECT * FROM engineering_revision_chains').all();
    const before = chains();
    const scan = async () => {
      expect(await f.dispatch()).toBeUndefined();
      expect(chains()).toEqual(before);
      expect(f.store.db.prepare("SELECT state FROM engineering_contained_missions JOIN engineering_mission_lineage USING(mission_id) WHERE chain_depth=8").all())
        .toEqual([{ state: 'awaiting_decision' }]);
      return f.store.db.prepare('SELECT * FROM engineering_contained_events ORDER BY seq').all() as { kind: string; mission_id: string; payload_json: string }[];
    };
    const first = await scan();
    expect(first.map(e => e.kind)).not.toContain('ci_repair_dispatch_refused');
    const second = await scan();
    if (f.source === 'github_actions') {
      expect(second.slice(0, -1)).toEqual(first);
      const refusal = second.at(-1)!;
      expect(refusal).toMatchObject({ kind: 'ci_repair_dispatch_refused', mission_id: f.parent });
      expect(JSON.parse(refusal.payload_json)).toMatchObject({ reason: 'verify_chain_busy', holder: 'actions_repair', check_run_id: 41 });
    } else expect(second).toEqual(first);
    expect(await scan()).toEqual(second);
  });
  it('creates nothing for unknown parent lineage and reports the waiting reason', async () => {
    const f = withLegacyRoot(() => setup());
    const counts = () => ['engineering_contained_missions', 'engineering_workspace_claims', 'engineering_mission_lineage'].map(t => f.store.db.prepare(`SELECT count(*) n FROM ${t}`).get());
    const before = counts(); expect(await f.dispatch()).toBeUndefined(); expect(await f.dispatch()).toBeUndefined();
    expect(counts()).toEqual(before); expect(f.waiting()).toBe('verify_chain_lineage_unknown');
  });
});
