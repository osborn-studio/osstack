import { isDeepStrictEqual } from "node:util";
import type { ContainedMission, ContainedMissionStore, EngineeringPrincipal } from "@osstack/core";
import { DiagnosisStore, LocalFailureDispatchStore } from "@osstack/core/verification-intake";
import { latestCiEvent, type RefreshCiPrincipal } from "./contained-mission-github-ci-approval.js";
import { parseContainedMissionSpec, type ContainedMissionSpec } from "./contained-mission-runner.js";

const invalid = "verify_publish_authority_invalid";
const refused = "verify_repair_approval_refused";

function operator(actor: EngineeringPrincipal, scope: string) {
  return (
    actor.read_scopes.includes(scope) && actor.write_scopes.includes(scope) && actor.operator_scopes.includes(scope)
  );
}

export function localPublicationFence(store: ContainedMissionStore, id: string, now: number) {
  return new LocalFailureDispatchStore(new DiagnosisStore(store.attention, store.owner)).publicationFence(id, now);
}

function binding(
  mission: ContainedMission,
  spec: ContainedMissionSpec,
  fence: ReturnType<typeof localPublicationFence>,
) {
  const target = spec.local_failure_repair;
  if (
    !target ||
    !spec.publication ||
    !mission.candidate_head ||
    !mission.candidate_tree ||
    !fence.ok ||
    target.root !== fence.root_mission_id ||
    target.request_id !== fence.request_id ||
    target.base !== fence.base_sha ||
    spec.start_commit !== fence.head_sha
  )
    throw Error(invalid);
  return {
    repository: spec.publication.repository,
    pr: target.pr,
    branch: target.branch,
    base: target.base,
    old: spec.start_commit,
    candidate: mission.candidate_head,
    tree: mission.candidate_tree,
    spec_digest: mission.spec_digest,
    dispatch_id: fence.dispatch_id,
    result_id: fence.result_id,
    source_seq: fence.source_seq,
  };
}

type Approval = ReturnType<typeof binding> & { principal: string; session: string; expires_at: number };

export function approveLocalFailureRepair(
  store: ContainedMissionStore,
  actor: EngineeringPrincipal,
  missionId: string,
  candidate: string,
  now: number,
) {
  let fenceReason: string | undefined;
  try {
    return store.db
      .transaction(() => {
        store.attention.assertOwner(store.owner);
        const mission = store.readable(actor, missionId);
        const spec = parseContainedMissionSpec(mission.spec_json);
        if (
          !operator(actor, mission.scope_id) ||
          !spec.local_failure_repair ||
          !spec.publication ||
          mission.state !== "awaiting_decision" ||
          latestCiEvent<{ reason: string }>(store, missionId, "halted")?.reason !== "publication_pending" ||
          mission.stop_obligation !== 0 ||
          mission.candidate_verified !== 1 ||
          mission.candidate_head !== candidate ||
          store.claim(missionId).state !== "active" ||
          latestCiEvent(store, missionId, "verify_repair_approval") !== undefined ||
          latestCiEvent(store, missionId, "verify_repair_push_intent") !== undefined
        )
          throw Error(refused);
        const fence = localPublicationFence(store, missionId, now);
        if (!fence.ok) {
          fenceReason = fence.reason;
          throw Error(fence.reason);
        }
        const facts = binding(mission, spec, fence);
        const approval: Approval = {
          ...facts,
          principal: actor.principal_id,
          session: actor.client_session_id,
          expires_at: now + 15 * 60_000,
        };
        store.record(missionId, "verify_repair_approval", approval, now, actor.principal_id);
        return store.transition(
          missionId,
          {
            if_revision: mission.revision,
            to: "revalidating",
            actor: actor.principal_id,
            event: { kind: "verify_repair_approved", payload: facts },
          },
          now,
        );
      })
      .immediate();
  } catch {
    throw Error(fenceReason ?? refused);
  }
}

export function assertLocalFailureApproval(
  store: ContainedMissionStore,
  mission: ContainedMission,
  spec: ContainedMissionSpec,
  refresh: RefreshCiPrincipal | undefined,
  now: number,
) {
  try {
    const approval = latestCiEvent<Approval>(store, mission.mission_id, "verify_repair_approval");
    if (!refresh || !approval || !Number.isSafeInteger(approval.expires_at) || now >= approval.expires_at)
      throw Error(invalid);
    const current = store.get(mission.mission_id);
    if (
      mission.spec_digest !== current.spec_digest ||
      mission.candidate_head !== current.candidate_head ||
      mission.candidate_tree !== current.candidate_tree ||
      !isDeepStrictEqual(spec, JSON.parse(current.spec_json))
    )
      throw Error(invalid);
    const facts = binding(current, spec, localPublicationFence(store, mission.mission_id, now));
    if (!Object.entries(facts).every(([k, v]) => approval[k as keyof Approval] === v)) throw Error(invalid);
    const actor = refresh(approval.principal, approval.session);
    if (
      actor.principal_id !== approval.principal ||
      actor.client_session_id !== approval.session ||
      !operator(actor, current.scope_id)
    )
      throw Error(invalid);
  } catch {
    throw Error(invalid);
  }
}
