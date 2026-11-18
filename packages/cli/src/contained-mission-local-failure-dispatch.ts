import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { scratchPath } from "@osstack/core";
import {
  LocalFailureDispatchStore,
  diagnosisProfile,
  parseLocalFailureRevisionGrant,
  verifyDiagnosisGrant,
  type DispatchInput,
  type DiagnosisProfile,
} from "@osstack/core/verification-intake";
import {
  compileMissionGlob,
  missionProtectedSetDigest,
} from "@osstack/governance";
import { checkLocalFailureRepairPaths } from "./contained-mission-local-failure-paths.js";
import type { DiagnosisPorts } from "./contained-mission-diagnosis.js";
import { validateContainedStart } from "./contained-mission-host.js";
import { parseContainedMissionSpec } from "./contained-mission-runner.js";

export interface LocalFailureDispatchPorts extends Pick<DiagnosisPorts, "store" | "now" | "keys" | "access"> {
  loadInstalledProfile(binding: DiagnosisProfile): {
    binding: DiagnosisProfile;
    profile: {
      checks: readonly { check_id: string }[];
      limits: { timeout_seconds: number };
    };
  };
  launchCaps: DispatchInput["launchCaps"];
  worktreesRoot?: string;
  locations?: readonly string[];
  fault?: DispatchInput["fault"];
}

export { LOCAL_FAILURE_PROTECTED_GLOBS, checkLocalFailureRepairPaths } from "./contained-mission-local-failure-paths.js";

export function recoverLocalFailureDispatch(
  p: Pick<LocalFailureDispatchPorts, "store">,
  requestId: string,
): ReturnType<LocalFailureDispatchStore["recover"]> {
  return new LocalFailureDispatchStore(p.store).recover(requestId);
}

export function dispatchLocalFailureRepair(
  p: LocalFailureDispatchPorts,
  requestId: string,
): ReturnType<LocalFailureDispatchStore["dispatch"]> {
  return new LocalFailureDispatchStore(p.store).dispatch({
    request_id: requestId,
    now: () => p.now(),
    launchCaps: p.launchCaps,
    ...(p.locations !== undefined && { locations: p.locations }),
    ...(p.fault && { fault: p.fault }),
    verify: (r, chain) => {
      const grant = parseLocalFailureRevisionGrant(chain.grant_json);
      const principal = p.access.refresh(grant.principal_id, grant.client_session_id);
      const installed = p.loadInstalledProfile(diagnosisProfile(r));
      const intake = p.store.intakes.get(r.intake_id!);
      const verified = verifyDiagnosisGrant({
        grant_json: chain.grant_json,
        budget_json: chain.budget_json,
        keys: p.keys(),
        now: p.now(),
        principal,
        request: { ...r, ...diagnosisProfile(r) },
        installed: installed.binding,
        timeout_seconds: installed.profile.limits.timeout_seconds,
        tree_sha: intake.tree_sha,
        candidate: {
          ...r,
          repository: chain.repository,
          branch: chain.branch,
          base_ref: chain.base_ref,
          pr_number: chain.pr_number,
          root_mission_id: chain.root_mission_id,
          tree_sha: intake.tree_sha,
        },
      });
      if (
        !verified.ok ||
        grant.protected_set_digest !== missionProtectedSetDigest() ||
        (grant.renews && grant.renews.chain_id !== chain.chain_id)
      )
        throw Error("verify_grant_invalid");
      return {
        grant_digest: verified.grant_digest,
        principal,
        check_ids: installed.profile.checks.map((c) => c.check_id),
      };
    },
    checkPaths: checkLocalFailureRepairPaths,
    withinAllowed: (path, globs) => globs.some((glob) => compileMissionGlob(glob).test(path)),
    buildChild: ({ rootSpec, head, goal, binding, locations }) => {
      const {
        ci_repair: _ci,
        publish_target: _target,
        revision_feedback: _feedback,
        local_failure_repair: _local,
        ...root
      } = parseContainedMissionSpec(rootSpec);
      if (!root.publication) throw Error("CONTAINED_SPEC_INVALID");
      const name = `local-failure-${randomUUID()}`;
      const worktrees = p.worktreesRoot ?? scratchPath("worktrees");
      const spec = {
        ...root,
        start_commit: head,
        goal,
        allowed_paths: [...locations],
        branch: `osstack/mission/${name}`,
        worktree_path: join(worktrees, name),
        publication: { ...root.publication, preauthorized: false },
        local_failure_repair: binding,
      };
      parseContainedMissionSpec(JSON.stringify(spec));
      return { spec, claim: validateContainedStart(spec, worktrees).claim };
    },
  });
}
