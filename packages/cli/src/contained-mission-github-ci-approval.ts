import type { ContainedMission, ContainedMissionStore, EngineeringPrincipal } from '@osstack/core';
import { GITHUB_CI_SANDBOX, parseContainedMissionSpec, type ContainedMissionSpec } from './contained-mission-runner.js';

export type RefreshCiPrincipal = (principalId: string, sessionId: string) => EngineeringPrincipal;
const TTL = 15 * 60_000;

export function latestCiEvent<T>(store: ContainedMissionStore, missionId: string, kind: string): T | undefined {
  const row = store.db.prepare(`SELECT payload_json FROM engineering_contained_events WHERE mission_id=? AND kind=? ORDER BY seq DESC LIMIT 1`)
    .get(missionId, kind) as { payload_json: string } | undefined;
  return row ? JSON.parse(row.payload_json) as T : undefined;
}

function binding(mission: ContainedMission, spec: ContainedMissionSpec) {
  const target = spec.ci_repair;
  if (!target || !mission.candidate_head || !mission.candidate_tree) throw Error('ci_repair_candidate_missing');
  return { repository: GITHUB_CI_SANDBOX, pr: target.pr, branch: target.branch, base: target.base,
    old: spec.start_commit, candidate: mission.candidate_head, tree: mission.candidate_tree, spec_digest: mission.spec_digest };
}
type Approval = ReturnType<typeof binding> & { principal: string; session: string; expires_at: number };
function requireOperator(actor: EngineeringPrincipal, scope: string) {
  if (!actor.read_scopes.includes(scope) || !actor.write_scopes.includes(scope) || !actor.operator_scopes.includes(scope)) throw Error('permission_denied');
}

export function approveSandboxCiRepair(store: ContainedMissionStore, actor: EngineeringPrincipal,
  missionId: string, candidate: string, now: number): ContainedMission {
  return store.db.transaction(() => {
    store.attention.assertOwner(store.owner);
    const mission = store.readable(actor, missionId);
    requireOperator(actor, mission.scope_id);
    const spec = parseContainedMissionSpec(mission.spec_json);
    const facts = binding(mission, spec);
    const halt = latestCiEvent<{ reason: string }>(store, missionId, 'halted');
    if (mission.state !== 'awaiting_decision' || halt?.reason !== 'publication_pending' || mission.stop_obligation !== 0
      || mission.candidate_verified !== 1 || facts.candidate !== candidate || store.claim(missionId).state !== 'active'
      || latestCiEvent(store, missionId, 'ci_repair_approval')) throw Error('ci_repair_approval_refused');
    const approved: Approval = { ...facts, principal: actor.principal_id, session: actor.client_session_id, expires_at: now + TTL };
    store.record(missionId, 'ci_repair_approval', approved, now, actor.principal_id);
    return store.transition(missionId, { if_revision: mission.revision, to: 'revalidating',
      event: { kind: 'ci_repair_approved', payload: facts }, actor: actor.principal_id }, now);
  }).immediate();
}

export function assertSandboxCiApproval(store: ContainedMissionStore, mission: ContainedMission, spec: ContainedMissionSpec,
  refresh: RefreshCiPrincipal | undefined, now: number): void {
  const approval = latestCiEvent<Approval>(store, mission.mission_id, 'ci_repair_approval');
  if (!refresh || !approval || !Number.isSafeInteger(approval.expires_at) || now >= approval.expires_at
    || !Object.entries(binding(mission, spec)).every(([key, value]) => approval[key as keyof Approval] === value)) throw Error('ci_repair_approval_invalid');
  requireOperator(refresh(approval.principal, approval.session), mission.scope_id);
}
