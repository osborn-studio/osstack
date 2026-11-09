import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SandboxCiAutoGrant } from './contained-mission-ci-auto-grant.js';
import { createRig } from './contained-mission-bridge-shadow.testkit.js';
import { GITHUB_CI_SANDBOX, type ContainedMissionSpec } from './contained-mission-runner.js';
import type { ContainedMissionState } from '@osstack/core';
import { ContainedMissionService } from './contained-mission-rpc.js';
import type { ContainedMissionHost } from './contained-mission-host.js';
import type { EngineeringAccess } from './engineering-access.js';
import { publishSandboxCiRepair } from './contained-mission-github-ci-publish.js';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ci-auto-grant-')); dirs.push(dir);
  const path = join(dir, 'grant.json');
  const grant = { version: 1, grant_id: 'test-grant', scope_id: 'a'.repeat(64), root_mission_id: 'cm_00000000-0000-4000-8000-000000000001',
    principal_id: 'owner', client_session_id: 'console', issued_at: 100, expires_at: 1000 };
  const write = (over = {}) => writeFileSync(path, JSON.stringify({ ...grant, ...over }), { mode: 0o600 });
  write(); return { path, grant, write, reader: new SandboxCiAutoGrant(path, grant.scope_id) };
}
it('reloads revocation and expiry and rejects insecure or linked authority', () => {
  const f = fixture();
  expect(f.reader.read(101)).toEqual(f.grant);
  expect(() => f.reader.read(1000)).toThrow();
  expect(() => f.reader.read(99)).toThrow();
  f.write({ scope_id: 'b'.repeat(64) }); expect(() => f.reader.read(101)).toThrow();
  f.write(); chmodSync(dirs[0]!, 0o755); expect(() => f.reader.read(101)).toThrow();
  chmodSync(dirs[0]!, 0o700); chmodSync(f.path, 0o644); expect(() => f.reader.read(101)).toThrow();
  chmodSync(f.path, 0o600); rmSync(f.path); expect(() => f.reader.read(101)).toThrow();
  const other = join(dirs[0]!, 'other'); writeFileSync(other, JSON.stringify(f.grant), { mode: 0o600 });
  symlinkSync(other, f.path); expect(() => f.reader.read(101)).toThrow();
});
it('rejects broad, malformed and overlong grants', () => {
  const f = fixture();
  for (const over of [{ scope_id: undefined }, { expires_at: 100 + 900001 }, { version: 2 }, { pr: 7 }]) {
    f.write(over); expect(() => f.reader.read(101)).toThrow();
  }
});

it('accepts a host grant prebound to one isolated scope before its new root exists', () => {
  const f = fixture(); f.write({ root_mission_id: undefined });
  expect(f.reader.read(101).root_mission_id).toBeUndefined();
});

function boundFixture() {
  const f = fixture(); const rig = createRig();
  const base = 'a'.repeat(40), head = 'b'.repeat(40);
  const rootSpec: ContainedMissionSpec = { goal: 'fixture', repo_path: rig.root, base_ref: 'main', start_commit: base,
    branch: 'osstack/mission/seed', worktree_path: join(rig.root, 'seed'), allowed_paths: ['PROBE_FAIL'],
    verification_mode: 'github_actions', verify: { argv: [] }, max_repair_cycles: 0,
    publication: { remote: 'origin', repository: GITHUB_CI_SANDBOX, base: 'main', draft: false } };
  const rootId = rig.seedMission({ pr_number: 7, head, base_head: base, repository: GITHUB_CI_SANDBOX,
    spec: rootSpec as unknown as Record<string, unknown> });
  rig.missions.record(rootId, 'ci_delivery_evidence', { head, base_head: base, evidence_digest: 'fixture' }, 1100);
  rig.missions.record(rootId, 'pr_opened', { verification_kind: 'github_actions', evidence_digest: 'fixture', pr: { number: 7 } }, 1101);
  const spec = { ...rootSpec, branch: 'osstack/mission/repair', start_commit: head, worktree_path: join(rig.root, 'repair'),
    ci_repair: { root: rootId, pr: 7, branch: rootSpec.branch, base, check_run_id: 9 } };
  let child = rig.missions.authorize(rig.principal, { scope_id: rig.scope.scope_id, spec: spec as unknown as Record<string, unknown>,
    claim: { repo_identity: 'repair', branch: spec.branch, worktree_identity: spec.worktree_path } }, 1200);
  const step = (to: ContainedMissionState, extra = {}) => { child = rig.missions.transition(child.mission_id,
    { if_revision: child.revision, to, event: { kind: `to_${to}`, payload: {} }, ...extra }, 1201); };
  step('workspace_ready'); step('executing', { expected_head: head });
  child = rig.missions.recordStopEvidence(child.mission_id, child.revision, { stop_proof: 'test' }, 1202);
  step('candidate_ready', { candidate: { head: 'c'.repeat(40), tree: 'd'.repeat(40), diff_digest: 'e'.repeat(64) } });
  step('verifying'); child = rig.missions.recordStopEvidence(child.mission_id, child.revision, { stop_proof: 'test' }, 1203);
  step('verified'); step('awaiting_decision');
  rig.missions.record(child.mission_id, 'halted', { reason: 'publication_pending' }, 1204);
  rig.missions.record(rootId, 'ci_repair_dispatched', { child: child.mission_id }, 1204);
  rig.missions.record(rootId, 'ci_failure_observed', { head, base, pr: 7, job: { check_run_id: 9 } }, 1204);
  f.write({ scope_id: rig.scope.scope_id, root_mission_id: rootId, principal_id: 'human', client_session_id: 'cli', expires_at: 9000 });
  const reader = new SandboxCiAutoGrant(f.path, rig.scope.scope_id);
  const actor = { ...rig.principal, operator_scopes: [rig.scope.scope_id] };
  return { ...f, reader, rig, child, actor, rootId };
}
it('persists one exact-candidate approval and rejects a second use and authority removal', () => {
  const f = boundFixture();
  try {
    const approved = f.reader.approve(f.rig.missions, f.child, () => f.actor, 2000);
    expect(approved.state).toBe('revalidating');
    expect(f.reader.assert(f.rig.missions, approved, () => f.actor, 2001).reserved).toBe(true);
    expect(() => f.reader.approve(f.rig.missions, approved, () => f.actor, 2001)).toThrow('ci_auto_grant_consumed');
    expect(() => f.reader.assert(f.rig.missions, approved, () => ({ ...f.actor, operator_scopes: [] }), 2001)).toThrow('permission_denied');
    f.write({ scope_id: f.rig.scope.scope_id, root_mission_id: f.rootId, principal_id: 'human', client_session_id: 'cli', expires_at: 9500 });
    expect(() => f.reader.assert(f.rig.missions, approved, () => f.actor, 2001)).toThrow('ci_auto_grant_consumed');
    rmSync(f.path); expect(() => f.reader.assert(f.rig.missions, approved, () => f.actor, 2001)).toThrow();
  } finally { f.rig.close(); }
});
it.each(['old-root', 'wrong-owner', 'wrong-head', 'wrong-job', 'second-root'])('fails closed for %s', fault => {
  const f = boundFixture();
  try {
    if (fault === 'old-root') f.write({ scope_id: f.rig.scope.scope_id, root_mission_id: f.rootId, principal_id: 'human', client_session_id: 'cli', issued_at: 1500, expires_at: 9000 });
    if (fault === 'wrong-owner') f.write({ scope_id: f.rig.scope.scope_id, root_mission_id: f.rootId, expires_at: 9000 });
    if (fault === 'wrong-head' || fault === 'wrong-job') f.rig.missions.record(f.rootId, 'ci_failure_observed',
      { head: fault === 'wrong-head' ? 'f'.repeat(40) : 'b'.repeat(40), base: 'a'.repeat(40), pr: 7, job: { check_run_id: fault === 'wrong-job' ? 10 : 9 } }, 2000);
    if (fault === 'second-root') f.rig.seedMission({ pr_number: 8, head: 'b'.repeat(40), base_head: 'a'.repeat(40) });
    expect(() => f.reader.approve(f.rig.missions, f.child, () => f.actor, 2000)).toThrow();
    expect(f.rig.missions.get(f.child.mission_id).state).toBe('awaiting_decision');
  } finally { f.rig.close(); }
});

it('normal service ticks run the optional grant scan before host work and stop after drain', async () => {
  const calls: string[] = []; let draining = false;
  const service = new ContainedMissionService({
    host: { tick: async () => { calls.push('host'); } } as unknown as ContainedMissionHost,
    access: {} as EngineeringAccess, draining: () => draining,
    autoApproveCiRepair: async () => { calls.push('grant'); },
  });
  await service.tick(); expect(calls).toEqual(['grant', 'host']);
  calls.length = 0;
  const pending = service.tick(); draining = true; await pending;
  expect(calls).toEqual(['grant']);
  await service.tick(); expect(calls).toEqual(['grant']);
});

it.each(['missing-hook', 'revoked'])('refuses auto publication before any forge or git call when %s', async fault => {
  const f = boundFixture();
  try {
    let child = f.reader.approve(f.rig.missions, f.child, () => f.actor, 2000);
    child = f.rig.missions.transition(child.mission_id, { if_revision: child.revision, to: 'delivering', event: { kind: 'delivery_intent', payload: {} } }, 2001);
    if (fault === 'revoked') rmSync(f.path);
    const spec = JSON.parse(child.spec_json) as ContainedMissionSpec;
    let calls = 0;
    await expect(publishSandboxCiRepair({ mission: child, spec,
      permit: { mission_id: child.mission_id, revision: child.revision, head: child.candidate_head!, tree: child.candidate_tree!, spec_digest: child.spec_digest },
      body: '', signal: new AbortController().signal, beforeRemoteMutation: () => { calls++; } }, {
      store: f.rig.missions, now: () => 2002, enabled: () => true, refresh: () => f.actor,
      ...(fault === 'missing-hook' ? {} : { assertAutoGrant: () => { f.reader.assert(f.rig.missions, child, () => f.actor, 2002); } }),
      runner: { gated: true, run: async () => { calls++; throw Error('unexpected git'); } },
      host: { recordForIntent: () => undefined }, readPr: async () => { calls++; return null; },
    })).rejects.toThrow();
    expect(calls).toBe(0);
    expect(f.rig.missions.events(child.mission_id, 0, 100).some(e => e.kind === 'ci_repair_push_intent')).toBe(false);
  } finally { f.rig.close(); }
});
