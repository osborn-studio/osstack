import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { ContainedMission, ContainedMissionStore, EngineeringPrincipal } from '@osstack/core';
import { z } from 'zod';
import { GITHUB_CI_PILOT_REPOSITORY, PILOT_PATH } from './contained-mission-ci-policy.js';
import { approveSandboxCiRepair, latestCiEvent, type RefreshCiPrincipal } from './contained-mission-github-ci-approval.js';
import { parseContainedMissionSpec, type ContainedMissionSpec } from './contained-mission-runner.js';

const number = z.number().int().positive().safe();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const paths = z.array(z.string().max(256).regex(PILOT_PATH)).min(1).max(24);
const profile = z.object({
  version: z.literal(1), scope_id: sha256, paths, publisher_installation_id: number,
  merger_installation_id: number, merger_key_path: z.string().refine(isAbsolute),
  main_quality_ruleset_id: number, main_update_ruleset_id: number,
  mission_writers_ruleset_id: number, mission_history_ruleset_id: number,
}).strict();
const release = z.object({
  version: z.literal(1), profile_sha256: sha256, issued_at: number, expires_at: number,
  principal_id: z.string().min(1).max(200), client_session_id: z.string().min(1).max(200),
}).strict();
type PilotProfile = z.infer<typeof profile>;
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const refusal = () => Error('CI_PILOT_NOT_AUTHORIZED');

function readPrivate(path: string): string {
  if (realpathSync(path) !== path) throw refusal();
  const directory = statSync(dirname(path));
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) throw refusal();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 8192) throw refusal();
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

export class ProductionCiPilot {
  readonly config: PilotProfile;
  readonly profileDigest: string;
  private readonly profilePath: string;
  private readonly releasePath: string;

  constructor(home: string, private readonly live: boolean, private readonly draining: () => boolean) {
    const bridge = join(realpathSync(home), 'bridge');
    this.profilePath = join(bridge, 'ci-pilot.json');
    this.releasePath = join(bridge, 'ci-pilot-release.json');
    const raw = readPrivate(this.profilePath);
    this.config = profile.parse(JSON.parse(raw));
    this.profileDigest = digest(raw);
    const c = this.config;
    if (new Set(c.paths).size !== c.paths.length
      || new Set([c.main_quality_ruleset_id, c.main_update_ruleset_id, c.mission_writers_ruleset_id, c.mission_history_ruleset_id]).size !== 4
      || c.publisher_installation_id === c.merger_installation_id) throw refusal();
  }

  private permit(spec: ContainedMissionSpec, scope: string, now: number) {
    if (!this.live || this.draining() || scope !== this.config.scope_id || spec.publication?.repository !== GITHUB_CI_PILOT_REPOSITORY
      || spec.allowed_paths.length === 0 || !spec.allowed_paths.every(path => this.config.paths.includes(path))
      || digest(readPrivate(this.profilePath)) !== this.profileDigest) throw refusal();
    const repo = realpathSync(spec.repo_path);
    for (const path of [this.profilePath, this.releasePath, realpathSync(this.config.merger_key_path)]) {
      if (path === repo || path.startsWith(`${repo}/`) || path === spec.worktree_path || path.startsWith(`${spec.worktree_path}/`)) throw refusal();
    }
    const raw = readPrivate(this.releasePath);
    const parsed = release.parse(JSON.parse(raw));
    if (parsed.profile_sha256 !== this.profileDigest || now < parsed.issued_at || now >= parsed.expires_at
      || parsed.expires_at - parsed.issued_at > 72 * 60 * 60_000) throw refusal();
    return { ...parsed, digest: digest(raw) };
  }

  private assertPrincipal(actor: EngineeringPrincipal, scope: string, grant: { principal_id: string; client_session_id: string }) {
    if (actor.principal_id !== grant.principal_id || actor.client_session_id !== grant.client_session_id
      || ![actor.read_scopes, actor.write_scopes, actor.operator_scopes].every(scopes => scopes.includes(scope))) throw refusal();
  }

  bindNewRoot(store: ContainedMissionStore, actor: EngineeringPrincipal, scope: string, spec: ContainedMissionSpec, now: number) {
    const grant = this.permit(spec, scope, now);
    this.assertPrincipal(actor, scope, grant);
    if (!spec.publication?.preauthorized) throw refusal();
    // Count all consumed slots, including a failed or cancelled root. A fresh release file cannot
    // reset the limit for this scope. The host records the binding in the admission transaction.
    const row = store.db.prepare(`SELECT count(*) AS n FROM engineering_contained_events e
      JOIN engineering_contained_missions m ON m.mission_id=e.mission_id
      WHERE m.scope_id=? AND e.kind='ci_pilot_root_bound'`).get(scope) as { n: number };
    const unsettledWrite = store.db.prepare(`SELECT 1 FROM engineering_host_processes p
      JOIN engineering_contained_missions m ON m.mission_id=p.mission_id
      WHERE m.scope_id=? AND p.released_at IS NOT NULL AND p.kind IN ('git_push','gh_pr_create')
      AND EXISTS (SELECT 1 FROM engineering_contained_events e WHERE e.mission_id=m.mission_id AND e.kind='ci_pilot_root_bound')
      AND NOT EXISTS (SELECT 1 FROM engineering_contained_events e WHERE e.mission_id=m.mission_id
        AND e.kind IN ('ci_closed_unmerged','ci_pr_merged_observed')) LIMIT 1`).get(scope);
    if (row.n >= 5 || unsettledWrite) throw refusal();
    return { release_digest: grant.digest, profile_digest: this.profileDigest };
  }

  assertWrite(store: ContainedMissionStore, mission: ContainedMission, refresh: RefreshCiPrincipal, now: number) {
    store.attention.assertOwner(store.owner);
    const spec = parseContainedMissionSpec(mission.spec_json);
    const grant = this.permit(spec, mission.scope_id, now);
    const root = spec.ci_repair ? store.get(spec.ci_repair.root) : mission;
    const bound = latestCiEvent<{ release_digest: string; profile_digest: string }>(store, root.mission_id, 'ci_pilot_root_bound');
    if (bound?.release_digest !== grant.digest || bound.profile_digest !== this.profileDigest
      || root.scope_id !== mission.scope_id || root.owner_principal_id !== grant.principal_id || root.owner_client_session_id !== grant.client_session_id
      || mission.owner_principal_id !== grant.principal_id || mission.owner_client_session_id !== grant.client_session_id) throw refusal();
    if (spec.ci_repair && latestCiEvent<{ child: string }>(store, root.mission_id, 'ci_repair_dispatched')?.child !== mission.mission_id) throw refusal();
    const actor = refresh(grant.principal_id, grant.client_session_id);
    this.assertPrincipal(actor, mission.scope_id, grant);
    return { actor, digest: grant.digest };
  }

  approveRepair(store: ContainedMissionStore, child: ContainedMission, refresh: RefreshCiPrincipal, now: number) {
    return store.db.transaction(() => {
      store.attention.assertOwner(store.owner);
      const grant = this.assertWrite(store, child, refresh, now);
      const spec = parseContainedMissionSpec(child.spec_json);
      if (!spec.ci_repair || latestCiEvent(store, child.mission_id, 'ci_repair_push_intent') || !child.candidate_head) throw refusal();
      const grantId = `pilot-${spec.ci_repair.root}`;
      const approved = approveSandboxCiRepair(store, grant.actor, child.mission_id, child.candidate_head, now, grantId);
      store.record(child.mission_id, 'ci_auto_grant_reserved', { grant_id: grantId, digest: grant.digest, child: child.mission_id }, now);
      return approved;
    }).immediate();
  }
}
