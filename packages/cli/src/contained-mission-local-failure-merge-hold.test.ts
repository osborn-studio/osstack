import { ContainedMissionStore } from '@osstack/core';
import { publishedRecheck, runFixture } from '@osstack/core/dist/state/local-failure-recheck.testkit.js';
import { expect, it } from 'vitest';
import { readLocalFailureMergeHold } from './contained-mission-local-failure-merge-hold.js';
import { reserveFixtureIntake, setup } from './contained-mission-revision.testkit.js';

const held = (reason: string) => ({ held: true, reason });
it('ignores absent chains, shadow grants and live review-only grants', () => {
  const { rig, chain } = setup();
  const target = { repository: chain.repository, pr: chain.pr_number, root_mission_id: chain.root_mission_id,
    head: chain.published_head, base: chain.published_base };
  expect(readLocalFailureMergeHold(rig.missions, { ...target, repository: 'another/repo', root_mission_id: 'other' })).toEqual({ held: false });
  rig.chains.createShadowChain(chain, 100);
  expect(readLocalFailureMergeHold(rig.missions, target)).toEqual({ held: false });
});

it('holds both grant markers across chain states and either target identity', () => {
  const { rig, chain } = setup();
  const read = (repository: string, pr: number, root_mission_id: string) => readLocalFailureMergeHold(rig.missions,
    { repository, pr, root_mission_id, head: chain.published_head, base: chain.published_base });
  // Allow direct grant changes in this fixture, including a partial historical opt-in.
  rig.db.exec('DROP TRIGGER engineering_local_failure_grant_monotonic');
  const grant = rig.db.prepare('UPDATE engineering_revision_chains SET grant_json=?,revision=revision+1 WHERE chain_id=?');
  grant.run(JSON.stringify({ ...JSON.parse(chain.grant_json), local_failure: null }), chain.chain_id);
  expect(read(chain.repository, chain.pr_number, 'other')).toEqual(held('verification_pending'));
  grant.run(JSON.stringify({ ...JSON.parse(chain.grant_json), version: 2 }), chain.chain_id);
  for (const state of ['awaiting_review', 'awaiting_decision', 'closed']) {
    rig.db.prepare("UPDATE engineering_revision_chains SET state=?,stop_reason='fixture',revision=revision+1 WHERE chain_id=?").run(state, chain.chain_id);
    expect(read(chain.repository.toUpperCase(), chain.pr_number, 'other')).toEqual(held('verification_pending'));
    expect(read('other/repo', 99, chain.root_mission_id)).toEqual(held('verification_pending'));
  }
});

it('holds on intake evidence even after the stored grant returns to version one', () => {
  const { rig, chain, clock } = setup();
  // The intake fixture installs a version two grant directly before restoring version one.
  rig.db.exec('DROP TRIGGER engineering_local_failure_grant_monotonic');
  reserveFixtureIntake(rig, chain.chain_id, clock.now);
  const target = { repository: chain.repository, pr: chain.pr_number, root_mission_id: 'other',
    head: chain.published_head, base: chain.published_base };
  expect(readLocalFailureMergeHold(rig.missions, target)).toEqual(held('verification_pending'));
});

it('holds for every persisted recheck state and reason, including a current pass', () => {
  for (const reason of ['verify_recheck_missing', 'verify_recheck_failed', 'verify_recheck_binding_changed', null]) {
    const d = publishedRecheck();
    const store = new ContainedMissionStore(d.f.attention, d.f.owner);
    d.recordConfirmation();
    d.confirm();
    const c = d.chain();
    const target = { repository: c.repository, pr: c.pr_number, root_mission_id: c.root_mission_id,
      head: c.published_head, base: c.published_base };
    const read = (over = {}) => readLocalFailureMergeHold(store, { ...target, ...over });
    expect(read()).toEqual(held('verify_recheck_missing'));
    const row = d.open();
    const recheck_id = row.recheck_id;
    if (reason === 'verify_recheck_binding_changed' || reason === 'verify_recheck_failed') {
      const result = d.add(reason === 'verify_recheck_binding_changed' ? { skill_version: '2.0.0' }
        : { outcome: 'failed', checks: d.f.v.checks });
      d.ledger.evaluate({ recheck_id, now: d.now, result });
    } else if (reason === null) {
      const run = runFixture(d, row);
      const reserved = run.runs.reserve(run.input).run;
      run.settle(run.runs.start(reserved.run_id, reserved.revision));
      d.ledger.evaluate({ recheck_id, now: d.now, result: d.add(), host: run.runs.hostProof(recheck_id)!,
        actions: { head_sha: row.new_head_sha, attempt: 1, complete: true, conclusion: 'success', digest: 'a'.repeat(64) } });
    }
    expect(read()).toEqual(held(reason ?? 'verify_approval_required'));
    if (!reason) {
      expect(read({ head: 'other' })).toEqual(held('verify_recheck_missing'));
      expect(read({ base: 'other' })).toEqual(held('verify_recheck_missing'));
      store.db.prepare('UPDATE engineering_revision_chains SET published_base=?,revision=revision+1 WHERE chain_id=?')
        .run('f'.repeat(40), c.chain_id);
      expect(read()).toEqual(held('verify_recheck_missing'));
    }
  }
});

it('fails closed when a matched grant cannot be read', () => {
  const { rig, chain } = setup();
  // Simulate a corrupt persisted grant that bypassed validation.
  rig.db.exec('DROP TRIGGER engineering_chain_grant_monotonic; DROP TRIGGER engineering_local_failure_grant_monotonic');
  rig.db.pragma('ignore_check_constraints=ON');
  rig.db.prepare("UPDATE engineering_revision_chains SET grant_json='{',revision=revision+1 WHERE chain_id=?").run(chain.chain_id);
  expect(readLocalFailureMergeHold(rig.missions, { repository: chain.repository, pr: chain.pr_number,
    root_mission_id: chain.root_mission_id, head: chain.published_head, base: chain.published_base })).toEqual(held('verify_merge_unverified'));
});
