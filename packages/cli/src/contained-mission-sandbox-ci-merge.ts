import type { ContainedMission, ContainedMissionStore, HostProcessRecord } from '@osstack/core';
import { z } from 'zod';
import { latestCiEvent } from './contained-mission-github-ci-approval.js';
import type { SandboxCiPushIntent } from './contained-mission-github-ci-publish.js';
import { readSandboxCiJobs, type SandboxCiTarget } from './contained-mission-github-ci.js';
import type { AuthenticatedCiRest } from './contained-mission-local-failure-reader-transport.js';
import { readMissionPublication } from './contained-mission-publication.js';
import { remoteTargetOf } from './contained-mission-remote-writes.js';
import { parseContainedMissionSpec } from './contained-mission-runner.js';
import { APP_E_SANDBOX, executeSandboxAppEMerge, type SandboxAppEPorts, type SandboxMergeBinding,
  type SandboxMergerHandoff } from './contained-mission-sandbox-app-e.js';

const commentTTL = 30 * 60_000;
const safeId = z.number().int().positive().safe();
const comment = z.object({ id: safeId, body: z.string(), user: z.object({ id: safeId, type: z.string() }),
  created_at: z.string(), updated_at: z.string(), author_association: z.string() });
const sameTarget = (a: SandboxCiTarget, b: SandboxCiTarget) =>
  a.pr === b.pr && a.head === b.head && a.base === b.base && a.branch === b.branch;

function handoffFor(raw: unknown, binding: SandboxMergeBinding, pushedAt: number, now: number): SandboxMergerHandoff | null {
  const parsed = comment.safeParse(raw);
  if (!parsed.success) return null;
  const c = parsed.data;
  const timestamp = Date.parse(c.created_at);
  if (c.body !== `osstack-sandbox-merge ${binding.head} ${binding.base}` || c.user.id !== APP_E_SANDBOX.watcherId
    || c.user.type !== 'User' || !['COLLABORATOR', 'MEMBER', 'OWNER'].includes(c.author_association)
    || c.created_at !== c.updated_at || !Number.isSafeInteger(timestamp) || timestamp < pushedAt || timestamp > now
    || now >= timestamp + commentTTL) return null;
  return { id: String(c.id), binding, expiresAt: timestamp + commentTTL };
}

export function createSandboxCiMerge(input: {
  store: ContainedMissionStore; scopeId: string; enabled: () => boolean; now: () => number;
  ci: Parameters<typeof readSandboxCiJobs>[0];
  github: (signal: AbortSignal) => Pick<SandboxAppEPorts, 'observe' | 'merge' | 'readback'>;
}) {
  const { store, scopeId, enabled, now, ci } = input;
  const repo = APP_E_SANDBOX.repository;
  const record = (mission: string, kind: string) => store.db.prepare(
    'SELECT created_at,payload_json FROM engineering_contained_events WHERE mission_id=? AND kind=? ORDER BY seq DESC LIMIT 1')
    .get(mission, kind) as { created_at: number; payload_json: string } | undefined;

  function pushReceipt(root: ContainedMission, child: ContainedMission, target: SandboxCiTarget) {
    if (!enabled() || root.scope_id !== scopeId || child.scope_id !== scopeId || root.state !== 'pr_opened' || child.state !== 'pr_opened'
      || store.get(root.mission_id).revision !== root.revision || store.get(child.mission_id).revision !== child.revision
      || root.stop_obligation !== 0 || child.stop_obligation !== 0 || child.candidate_head !== target.head
      || !record(child.mission_id, 'ci_auto_grant_reserved')) return null;
    const parent = readMissionPublication(store, root.mission_id);
    const publication = readMissionPublication(store, child.mission_id);
    const spec = parseContainedMissionSpec(child.spec_json);
    const repair = spec.ci_repair;
    if (spec.publication?.repository !== repo || repair?.root !== root.mission_id || repair.pr !== target.pr
      || repair.base !== target.base || repair.branch !== target.branch
      || parent?.kind !== 'github_ci_opened' || parent.pr.number !== target.pr || parent.pr.reused || parent.pushed_commit !== spec.start_commit
      || parent.base_head !== target.base || publication?.kind !== 'github_ci_opened' || !publication.pr.reused
      || publication.pr.number !== target.pr || publication.pushed_commit !== target.head || publication.base_head !== target.base) return null;
    const row = record(child.mission_id, 'ci_repair_push_confirmed');
    if (!row) return null;
    const receipt = JSON.parse(row.payload_json) as SandboxCiPushIntent & { op_id: string };
    const intent = latestCiEvent<SandboxCiPushIntent>(store, child.mission_id, 'ci_repair_push_intent');
    if (!intent || receipt.intent_id !== intent.intent_id || receipt.previous !== spec.start_commit || receipt.previous !== intent.previous
      || !sameTarget({ ...receipt, head: receipt.candidate }, target) || !sameTarget({ ...intent, head: intent.candidate }, target)) return null;
    const process = store.db.prepare('SELECT * FROM engineering_host_processes WHERE intent_id=?').get(receipt.intent_id) as HostProcessRecord | undefined;
    if (process?.op_id !== receipt.op_id || process?.state !== 'stopped' || process.released_at === null || process.mission_id !== child.mission_id
      || process.kind !== 'git_push' || process.remote_target !== remoteTargetOf(repo, target.branch)) return null;
    return row;
  }

  function reservedFor(root: ContainedMission, target: SandboxCiTarget) {
    const handoff = latestCiEvent<SandboxMergerHandoff>(store, root.mission_id, 'ci_app_e_merge_reserved');
    return handoff?.binding.repository === repo && handoff.binding.repositoryId === APP_E_SANDBOX.repositoryId && sameTarget(handoff.binding, target)
      ? handoff : null;
  }

  return {
    async request(root: ContainedMission, child: ContainedMission, target: SandboxCiTarget, signal: AbortSignal) {
      if (record(root.mission_id, 'ci_app_e_merge_reserved') || signal.aborted) return;
      const push = pushReceipt(root, child, target);
      if (!push) return;
      const binding = { ...target, repository: repo, repositoryId: APP_E_SANDBOX.repositoryId };
      // The shared GitHub user supplies a wake-up only. It cannot grant merge authority.
      const rest: AuthenticatedCiRest = ci.rest;
      const endpoint = `repos/${repo}/issues/${target.pr}/comments`;
      const list = await rest(`${endpoint}?per_page=100&page=1`, { signal });
      if (!list.ok || !Array.isArray(list.body) || list.body.length >= 100) return;
      if (list.body.some(raw => {
        const parsed = comment.safeParse(raw);
        return parsed.success && parsed.data.user.id === APP_E_SANDBOX.watcherId && /merge[ _-]+after/iu.test(parsed.data.body);
      })) return;
      const matching = list.body.map(raw => handoffFor(raw, binding, push.created_at, now())).filter(h => h !== null);
      if (matching.length !== 1 || !matching[0]) return;
      const handoff = matching[0];
      const authenticateHandoff = async (h: SandboxMergerHandoff) => {
        if (!enabled() || signal.aborted || !pushReceipt(root, child, target) || h.id !== handoff.id) return false;
        const current = await rest(`repos/${repo}/issues/comments/${h.id}`, { signal });
        const reread = current.ok ? handoffFor(current.body, binding, push.created_at, now()) : null;
        return reread?.id === h.id && reread.expiresAt === h.expiresAt && !signal.aborted && enabled();
      };
      const github = input.github(signal);
      const result = await executeSandboxAppEMerge(handoff, {
        ...github, now, authenticateHandoff,
        merge: (request, beforeWrite) => github.merge(request, async () => {
          await beforeWrite();
          store.db.transaction(() => {
            store.attention.assertOwner(store.owner);
            if (!enabled() || signal.aborted || handoff.expiresAt <= now() || !pushReceipt(root, child, target)
              || reservedFor(root, target)?.id !== handoff.id || record(root.mission_id, 'ci_app_e_merge_released')) {
              throw Error('SANDBOX_APP_E_RELEASE_REFUSED');
            }
            store.record(root.mission_id, 'ci_app_e_merge_released', handoff, now());
          }).immediate();
        }),
        verifyCurrentPublicationAndCi: async b => !!pushReceipt(root, child, b)
          && (await readSandboxCiJobs(ci, b, signal)).kind === 'success',
        reserveOnce: (key, h) => Promise.resolve(store.db.transaction(() => {
          store.attention.assertOwner(store.owner);
          if (!enabled() || signal.aborted || !pushReceipt(root, child, target) || h.expiresAt <= now()
            || key !== `${APP_E_SANDBOX.repositoryId}:${target.pr}`
            || store.db.prepare(`SELECT 1 FROM engineering_contained_events WHERE kind='ci_app_e_merge_reserved'
              AND json_extract(payload_json,'$.binding.repositoryId')=? AND json_extract(payload_json,'$.binding.pr')=? LIMIT 1`)
              .get(APP_E_SANDBOX.repositoryId, target.pr)) return false;
          store.record(root.mission_id, 'ci_app_e_merge_reserved', h, now());
          return true;
        }).immediate()),
      });
      if (result.kind === 'merged') store.record(root.mission_id, 'ci_app_e_merge_confirmed', { pr: target.pr, head: target.head, sha: result.sha }, now());
    },
    acceptsMerge(root: ContainedMission, child: ContainedMission, target: SandboxCiTarget, actor: { id: number; type: string }, mergeSha: string) {
      const handoff = reservedFor(root, target);
      const released = latestCiEvent<SandboxMergerHandoff>(store, root.mission_id, 'ci_app_e_merge_released');
      if (!handoff || released?.id !== handoff.id || !sameTarget(released.binding, target)
        || actor.id !== APP_E_SANDBOX.actorId || actor.type !== 'Bot' || !pushReceipt(root, child, target)) return null;
      const confirmed = latestCiEvent<{ pr: number; head: string; sha: string }>(store, root.mission_id, 'ci_app_e_merge_confirmed');
      if (confirmed && (confirmed.pr !== target.pr || confirmed.head !== target.head || confirmed.sha !== mergeSha)) return null;
      return { handoff_comment_id: Number(handoff.id), app_id: APP_E_SANDBOX.appId };
    },
  };
}
