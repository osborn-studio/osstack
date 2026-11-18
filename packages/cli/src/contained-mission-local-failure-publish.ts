import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { RevisionChainStore, type ContainedMissionStore } from "@osstack/core";
import type { DeliveryCommandRunner } from "@osstack/github";
import { latestCiEvent, type RefreshCiPrincipal } from "./contained-mission-github-ci-approval.js";
import { unprovenOpId, type HostProcessKit } from "./contained-mission-host-process.js";
import { assertLocalFailureApproval, localPublicationFence } from "./contained-mission-local-failure-approval.js";
import { fencedDeliveryRunner } from "./contained-mission-ports.js";
import { remoteTargetOf } from "./contained-mission-remote-writes.js";
import {
  parseContainedMissionSpec,
  type ContainedMissionPorts,
  type ContainedMissionSpec,
  type ContainedPublicationResult,
} from "./contained-mission-runner.js";

const sha = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const invalid = "verify_publish_authority_invalid";
export const LOCAL_FAILURE_PUBLISH_STOPS = [
  invalid,
  "verify_source_revoked",
  "verify_stale_head",
  "verify_base_changed",
  "verify_push_not_written",
  "verify_push_uncertain",
] as const;
type Target = { pr: number; branch: string; head: string; base: string };
interface Dependencies {
  store: ContainedMissionStore;
  host: Pick<HostProcessKit, "recordForIntent">;
  runner: DeliveryCommandRunner;
  now(): number;
  refresh?: RefreshCiPrincipal;
  enabled(): boolean;
  repository: string;
  readPr(
    target: Target,
    signal: AbortSignal,
  ): Promise<{ state: string; head: { sha: string }; base: { sha: string } } | null>;
}
type Outcome = "confirmed" | "not_written" | "stale_head" | "base_changed" | "unknown";
function intended(spec: ContainedMissionSpec, candidate: string, repository: string) {
  const binding = spec.local_failure_repair;
  if (!binding || spec.publication?.repository !== repository) throw Error(invalid);
  return { candidate, previous: spec.start_commit, base: binding.base, branch: binding.branch, pr: binding.pr };
}
type Intent = ReturnType<typeof intended> & { intent_id: string };
function existing(store: ContainedMissionStore, id: string, facts: ReturnType<typeof intended>) {
  const intent = latestCiEvent<Intent>(store, id, "verify_repair_push_intent");
  if (
    intent !== undefined &&
    (!intent ||
      !/^vrp_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(intent.intent_id) ||
      !Object.entries(facts).every(([k, v]) => intent[k as keyof Intent] === v))
  )
    throw Error(invalid);
  return intent;
}
const targetOf = (i: ReturnType<typeof intended>): Target => ({
  pr: i.pr,
  branch: i.branch,
  base: i.base,
  head: i.previous,
});
async function remoteHead(runner: DeliveryCommandRunner, cwd: string, branch: string, signal: AbortSignal) {
  const ref = "refs/heads/" + branch;
  const r = await runner.run("git", ["ls-remote", "--refs", "--", "origin", ref], { cwd, signal, timeoutMs: 60_000 });
  if (r.exitCode === 0 && r.stdout.trim() === "") return null; // A successful lookup found no such ref.
  const match = /^([a-f0-9]{40}(?:[a-f0-9]{24})?)\t([^\r\n]+)$/.exec(r.stdout.trim());
  return r.exitCode === 0 && match?.[2] === ref ? match[1] : undefined;
}

async function readback(
  deps: Dependencies,
  id: string,
  cwd: string,
  intent: Intent,
  signal: AbortSignal,
  failed = false,
): Promise<Outcome> {
  try {
    const process = deps.host.recordForIntent(intent.intent_id);
    if (
      process?.state !== "stopped" ||
      process.released_at == null ||
      process.kind !== "git_push" ||
      process.mission_id !== id ||
      process.remote_target !== remoteTargetOf(deps.repository, intent.branch)
    )
      return "unknown";
    const pr = await deps.readPr(targetOf(intent), signal);
    const remote = await remoteHead(deps.runner, cwd, intent.branch, signal);
    if (pr?.state !== "open" || !sha.test(pr.head.sha) || !sha.test(pr.base.sha)) return "unknown";
    if (pr.base.sha !== intent.base) return "base_changed";
    if (!remote) return "unknown";
    if (
      ![intent.previous, intent.candidate].includes(remote) ||
      ![intent.previous, intent.candidate].includes(pr.head.sha)
    )
      return "stale_head";
    if (remote !== pr.head.sha) return "unknown";
    if (remote === intent.previous)
      return failed || (process.exit_code != null && process.exit_code !== 0) ? "not_written" : "unknown";
    deps.store.db.transaction(() => {
      deps.store.attention.assertOwner(deps.store.owner);
      const now = deps.now();
      if (latestCiEvent(deps.store, id, "verify_repair_push_confirmed") === undefined)
        deps.store.record(id, "verify_repair_push_confirmed", { ...intent, op_id: process.op_id }, now);
      new RevisionChainStore(deps.store.attention, deps.store.owner).confirmLocalRepairPush(
        { child_mission_id: id, new_head: intent.candidate }, now,
      );
    }).immediate();
    return "confirmed";
  } catch {
    return "unknown";
  }
}

export async function reconcileLocalFailurePush(missionId: string, deps: Dependencies): Promise<Outcome> {
  try {
    const mission = deps.store.get(missionId);
    const spec = parseContainedMissionSpec(mission.spec_json);
    const facts = intended(spec, mission.candidate_head ?? "", deps.repository);
    const intent = existing(deps.store, missionId, facts);
    if (!intent) return "unknown";
    return readback(deps, missionId, spec.worktree_path, intent, new AbortController().signal);
  } catch {
    return "unknown";
  }
}

export async function publishLocalFailureRepair(
  input: Parameters<ContainedMissionPorts["publish"]>[0],
  deps: Dependencies,
): Promise<ContainedPublicationResult> {
  const { spec, mission, permit, signal } = input;
  const { store, repository } = deps;
  const id = mission.mission_id;
  const facts = intended(spec, permit.head, repository);
  const ref = "refs/heads/" + facts.branch;
  const options = { cwd: spec.worktree_path, timeoutMs: 60_000, signal };
  function checkPermit() {
    try {
      store.attention.assertOwner(store.owner);
      const current = store.get(id);
      if (
        signal.aborted ||
        current.state !== "delivering" ||
        permit.mission_id !== id ||
        permit.spec_digest !== current.spec_digest ||
        !isDeepStrictEqual(spec, JSON.parse(current.spec_json)) ||
        current.candidate_head !== permit.head ||
        current.candidate_tree !== permit.tree ||
        current.stop_obligation !== 0 ||
        store.claim(id).state !== "active"
      )
        throw Error(invalid);
      return current;
    } catch {
      throw Error(invalid);
    }
  }
  function authority() {
    const now = deps.now();
    const fence = localPublicationFence(store, id, now);
    if (!fence.ok) throw Error(fence.reason);
    const current = checkPermit();
    try {
      if (!deps.enabled() || current.revision !== permit.revision || current.candidate_verified !== 1) throw Error(invalid);
      assertLocalFailureApproval(store, current, spec, deps.refresh, now);
    } catch {
      throw Error(invalid);
    }
  }
  let intent = existing(store, id, facts);
  let failed = false;
  if (intent) {
    checkPermit();
  } else {
    authority();
    const pr = await deps.readPr(targetOf(facts), signal).catch(() => null);
    if (pr?.state !== "open" || !sha.test(pr.head.sha) || !sha.test(pr.base.sha)) throw Error(invalid);
    if (pr.base.sha !== facts.base) throw Error("verify_base_changed");
    if (pr.head.sha !== facts.previous) throw Error("verify_stale_head");
    const remote = await remoteHead(deps.runner, options.cwd, facts.branch, signal).catch(() => undefined);
    if (remote === undefined) throw Error("verify_push_uncertain");
    if (remote !== facts.previous) throw Error("verify_stale_head");
    const parent = await deps.runner
      .run("git", ["rev-list", "--parents", "-n", "1", permit.head], options)
      .catch(() => null);
    if (parent?.exitCode !== 0 || parent.stdout.trim() !== permit.head + " " + facts.previous) throw Error(invalid);
    const fresh = store.db
      .transaction(() => {
        const prior = existing(store, id, facts);
        if (prior) {
          checkPermit();
          return { intent: prior, push: false };
        }
        authority();
        const intent = { ...facts, intent_id: "vrp_" + randomUUID() };
        store.record(id, "verify_repair_push_intent", intent, deps.now());
        return { intent, push: true };
      })
      .immediate();
    intent = fresh.intent;
    if (fresh.push) {
      const runner = fencedDeliveryRunner(
        deps.runner,
        (kind) => {
          authority();
          if (kind !== "push" || existing(store, id, facts)?.intent_id !== fresh.intent.intent_id) throw Error(invalid);
          try {
            input.beforeRemoteMutation("push");
          } catch {
            throw Error(invalid);
          }
        },
        { remote: "origin", repository, missionId: id, httpsOnly: true },
      );
      try {
        const push = await runner.run(
          "git",
          [
            "push",
            "--porcelain",
            "--force-with-lease=" + ref + ":" + facts.previous,
            "origin",
            permit.head + ":" + ref,
          ],
          { ...options, intentId: intent.intent_id },
        );
        failed = push.exitCode !== 0;
      } catch (error) {
        if (
          unprovenOpId(error) !== undefined ||
          LOCAL_FAILURE_PUBLISH_STOPS.some((s) => error instanceof Error && error.message === s)
        )
          throw error;
        // A lost command result proves no exit status. Use the durable process record and both reads.
      }
    }
  }
  const outcome = await readback(deps, id, options.cwd, intent, signal, failed);
  if (outcome !== "confirmed")
    throw Error(
      {
        not_written: "verify_push_not_written",
        stale_head: "verify_stale_head",
        base_changed: "verify_base_changed",
        unknown: "verify_push_uncertain",
      }[outcome],
    );
  return {
    pushed_commit: permit.head,
    base_head: facts.base,
    pr: { number: facts.pr, reused: true, url: "https://github.com/" + repository + "/pull/" + facts.pr },
    stop_proof_scope: "app_isolated",
  };
}
