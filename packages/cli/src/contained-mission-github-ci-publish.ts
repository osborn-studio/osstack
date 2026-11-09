import { randomUUID } from 'node:crypto';
import type { ContainedMission, ContainedMissionStore } from '@osstack/core';
import type { DeliveryCommandRunner } from '@osstack/github';
import { assertSandboxCiApproval, latestCiEvent, type RefreshCiPrincipal } from './contained-mission-github-ci-approval.js';
import { createSandboxCiReader, readSandboxCiJobs, readSandboxCiPr } from './contained-mission-github-ci.js';
import type { HostProcessKit } from './contained-mission-host-process.js';
import { fencedDeliveryRunner } from './contained-mission-ports.js';
import { remoteTargetOf } from './contained-mission-remote-writes.js';
import { GITHUB_CI_SANDBOX, type ContainedMissionPorts, type ContainedPublicationResult } from './contained-mission-runner.js';

type PushInput = Parameters<ContainedMissionPorts['publish']>[0];
export type SandboxCiPushIntent = { intent_id: string; candidate: string; previous: string; base: string; branch: string; pr: number };

export async function publishSandboxCiRepair(input: PushInput, deps: { store: ContainedMissionStore; host: Pick<HostProcessKit, 'recordForIntent'>;
  assertAutoGrant?: (mission: ContainedMission) => void;
  runner: DeliveryCommandRunner; now: () => number; refresh?: RefreshCiPrincipal; enabled: () => boolean;
  /** Test seam for the read-only forge observation. */
  readPr?: (target: Parameters<typeof readSandboxCiPr>[1], signal: AbortSignal) => ReturnType<typeof readSandboxCiPr> }): Promise<ContainedPublicationResult> {
  const { mission, spec, permit, signal } = input;
  const { store, now } = deps;
  const repair = spec.ci_repair;
  if (!repair || spec.publication?.repository !== GITHUB_CI_SANDBOX) throw Error('CI_REPAIR_STOPPED');
  const target = { pr: repair.pr, head: spec.start_commit, base: repair.base, branch: repair.branch };
  const ci = createSandboxCiReader();
  const actual = () => deps.readPr ? deps.readPr(target, signal) : readSandboxCiPr(ci, target, signal);
  const ref = `refs/heads/${repair.branch}`;
  const runOptions = { cwd: spec.worktree_path, timeoutMs: 60_000, signal };
  let intent = latestCiEvent<SandboxCiPushIntent>(store, mission.mission_id, 'ci_repair_push_intent');
  const checkApproval = () => {
    signal.throwIfAborted();
    store.attention.assertOwner(store.owner);
    const current = store.get(mission.mission_id);
    const recorded = latestCiEvent<{ child: string }>(store, repair.root, 'ci_repair_dispatched');
    if (!deps.enabled() || recorded?.child !== mission.mission_id || current.revision !== permit.revision || current.candidate_head !== permit.head
      || current.candidate_tree !== permit.tree || current.state !== 'delivering' || current.stop_obligation !== 0
      || store.claim(mission.mission_id).state !== 'active') throw Error('CI_REPAIR_STOPPED');
    assertSandboxCiApproval(store, current, spec, deps.refresh, now());
    if (latestCiEvent(store, current.mission_id, 'ci_auto_grant_reserved')) {
      if (!deps.assertAutoGrant) throw Error('CI_REPAIR_STOPPED');
      deps.assertAutoGrant(current);
    }
  };
  const runner = fencedDeliveryRunner(deps.runner, kind => {
    if (kind !== 'push' || !intent || latestCiEvent<SandboxCiPushIntent>(store, mission.mission_id, 'ci_repair_push_intent')?.intent_id !== intent.intent_id) throw Error('CI_REPAIR_STOPPED');
    checkApproval();
    input.beforeRemoteMutation('push');
  }, { remote: 'origin', repository: GITHUB_CI_SANDBOX, missionId: mission.mission_id, httpsOnly: true });
  async function observedHead(): Promise<string | null> {
    const result = await runner.run('git', ['ls-remote', '--refs', '--', 'origin', ref], runOptions);
    const match = /^([0-9a-f]{40})\t([^\r\n]+)$/.exec(result.stdout.trim());
    return result.exitCode === 0 && match?.[2] === ref ? match[1]! : null;
  }
  const intended = { candidate: permit.head, previous: spec.start_commit, base: repair.base, branch: repair.branch, pr: repair.pr };
  let pushFailed = false;
  if (intent) {
    if (!Object.entries(intended).every(([key, value]) => intent?.[key as keyof SandboxCiPushIntent] === value)) throw Error('CI_REPAIR_STOPPED');
  } else {
    checkApproval();
    const pr = await actual();
    if (pr?.state !== 'open' || pr.head.sha !== target.head || pr.base.sha !== target.base || await observedHead() !== target.head) throw Error('CI_REPAIR_STOPPED');
    if (latestCiEvent(store, mission.mission_id, 'ci_auto_grant_reserved')) {
      const observed = await readSandboxCiJobs(ci, target, signal);
      if (observed.kind !== 'failure' || observed.job.check_run_id !== repair.check_run_id) throw Error('CI_REPAIR_STOPPED');
    }
    checkApproval();
    intent = { intent_id: `ci_${randomUUID()}`, ...intended };
    store.record(mission.mission_id, 'ci_repair_push_intent', intent, now());
    // The admission port already proved a single parent. The lease also requires the exact published old head.
    const result = await runner.run('git', ['push', '--porcelain', `--force-with-lease=${ref}:${target.head}`, 'origin', `${permit.head}:${ref}`],
      { ...runOptions, intentId: intent.intent_id });
    pushFailed = result.exitCode !== 0;
  }
  const process = deps.host.recordForIntent(intent.intent_id);
  if (process?.state !== 'stopped' || process.released_at === null || process.mission_id !== mission.mission_id
    || process.kind !== 'git_push' || process.remote_target !== remoteTargetOf(GITHUB_CI_SANDBOX, repair.branch)) throw Error('CI_REPAIR_STOPPED');
  const pr = await actual();
  const remote = await observedHead();
  if (!pr || !remote) throw Error('CI_REPAIR_RECEIPT_UNAVAILABLE');
  if (pr.state !== 'open' || pr.base.sha !== target.base
    || ![permit.head, target.head].includes(pr.head.sha) || ![permit.head, target.head].includes(remote)) throw Error('CI_REPAIR_STOPPED');
  if (pr.head.sha !== permit.head || remote !== permit.head) {
    if (pushFailed && remote === target.head && pr.head.sha === target.head) throw Error('CI_REPAIR_STOPPED');
    throw Error('CI_REPAIR_RECEIPT_UNAVAILABLE');
  }
  // App A alone can update the protected Mission branch. Record the exact released write and readback together.
  if (!latestCiEvent(store, mission.mission_id, 'ci_repair_push_confirmed')) {
    store.record(mission.mission_id, 'ci_repair_push_confirmed', { ...intent, op_id: process.op_id }, now());
  }
  return { pushed_commit: permit.head, base_head: target.base, pr: { number: target.pr, reused: true,
    url: `https://github.com/${GITHUB_CI_SANDBOX}/pull/${target.pr}` }, stop_proof_scope: 'app_isolated' };
}
