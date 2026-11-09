// Host-only opt-in. Candidate workspaces and RPC clients cannot issue this authority.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { ContainedMission, ContainedMissionStore } from '@osstack/core';
import { z } from 'zod';
import { approveSandboxCiRepair, latestCiEvent, type RefreshCiPrincipal } from './contained-mission-github-ci-approval.js';
import { readMissionPublication } from './contained-mission-publication.js';
import { GITHUB_CI_SANDBOX, parseContainedMissionSpec } from './contained-mission-runner.js';

const schema = z.object({ version: z.literal(1), grant_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  scope_id: z.string().regex(/^[a-f0-9]{64}$/), root_mission_id: z.string().regex(/^cm_[a-f0-9-]{36}$/).optional(),
  principal_id: z.string().min(1), client_session_id: z.string().min(1),
  issued_at: z.number().int().nonnegative(), expires_at: z.number().int().nonnegative(),
}).strict();
type Reservation = { grant_id: string; digest: string; child: string };
export class SandboxCiAutoGrant {
  private readonly canonical: string;
  constructor(private readonly path: string, private readonly scope: string) {
    if (!isAbsolute(path)) throw Error('ci_auto_grant_invalid');
    this.canonical = join(realpathSync(dirname(path)), basename(path));
  }
  read(now: number) {
    let fd: number | undefined;
    try {
      if (realpathSync(this.path) !== this.canonical) throw Error();
      const parent = statSync(dirname(this.canonical));
      if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) throw Error();
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 8192) throw Error();
      const grant = schema.parse(JSON.parse(readFileSync(fd, 'utf8')));
      if (grant.scope_id !== this.scope || now < grant.issued_at || now >= grant.expires_at
        || grant.expires_at <= grant.issued_at || grant.expires_at - grant.issued_at > 900000) throw Error();
      return grant;
    } catch { throw Error('ci_auto_grant_invalid'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  assert(store: ContainedMissionStore, child: ContainedMission, refresh: RefreshCiPrincipal, now: number) {
    const grant = this.read(now);
    const spec = parseContainedMissionSpec(child.spec_json);
    const repair = spec.ci_repair;
    if (!repair) throw Error('ci_auto_grant_binding');
    const roots = store.db.prepare("SELECT mission_id FROM engineering_contained_missions WHERE scope_id=? AND json_type(spec_json,'$.ci_repair') IS NULL")
      .all(grant.scope_id) as { mission_id: string }[];
    // A scope-only grant requires an empty scope at issuance and exactly one new root thereafter.
    if (roots.length !== 1 || roots[0]?.mission_id !== repair.root
      || (grant.root_mission_id !== undefined && grant.root_mission_id !== repair.root)) throw Error('ci_auto_grant_binding');
    const root = store.get(repair.root);
    const rootSpec = parseContainedMissionSpec(root.spec_json);
    const canonicalRepo = realpathSync(rootSpec.repo_path);
    for (const workspace of [canonicalRepo, rootSpec.worktree_path, spec.worktree_path]) {
      if (this.canonical === workspace || this.canonical.startsWith(`${workspace}/`)) throw Error('ci_auto_grant_invalid');
    }
    const publication = readMissionPublication(store, root.mission_id);
    const dispatch = latestCiEvent<{ child: string }>(store, root.mission_id, 'ci_repair_dispatched');
    const failure = latestCiEvent<{ head: string; base: string; pr: number; job: { check_run_id: number } }>(store, root.mission_id, 'ci_failure_observed');
    if (!repair || repair.root !== root.mission_id || root.created_at <= grant.issued_at || root.scope_id !== grant.scope_id
      || child.scope_id !== grant.scope_id || root.state !== 'pr_opened' || rootSpec.ci_repair
      || root.owner_principal_id !== grant.principal_id || root.owner_client_session_id !== grant.client_session_id
      || child.owner_principal_id !== grant.principal_id || child.owner_client_session_id !== grant.client_session_id
      || publication?.kind !== 'github_ci_opened' || rootSpec.publication?.repository !== GITHUB_CI_SANDBOX
      || publication.pushed_commit !== spec.start_commit || publication.pushed_commit !== root.candidate_head
      || publication.base_head !== repair.base || rootSpec.start_commit !== repair.base || publication.pr.number !== repair.pr
      || rootSpec.branch !== repair.branch || dispatch?.child !== child.mission_id
      || failure?.head !== spec.start_commit || failure.base !== repair.base || failure.pr !== repair.pr
      || failure.job.check_run_id !== repair.check_run_id) throw Error('ci_auto_grant_binding');
    const actor = refresh(grant.principal_id, grant.client_session_id);
    if (![actor.read_scopes, actor.write_scopes, actor.operator_scopes].every(scopes => scopes.includes(grant.scope_id))) throw Error('permission_denied');
    const digest = createHash('sha256').update(JSON.stringify(grant)).digest('hex');
    const rows = store.db.prepare("SELECT payload_json FROM engineering_contained_events WHERE kind='ci_auto_grant_reserved' AND json_extract(payload_json,'$.grant_id')=?")
      .all(grant.grant_id) as { payload_json: string }[];
    if (rows.length > 1 || rows.some(row => {
      const reserved = JSON.parse(row.payload_json) as Reservation;
      return reserved.digest !== digest || reserved.child !== child.mission_id;
    })) throw Error('ci_auto_grant_consumed');
    return { actor, reservation: { grant_id: grant.grant_id, digest, child: child.mission_id }, reserved: rows.length === 1 };
  }
  approve(store: ContainedMissionStore, child: ContainedMission, refresh: RefreshCiPrincipal, now: number) {
    return store.db.transaction(() => {
      store.attention.assertOwner(store.owner);
      const live = this.assert(store, child, refresh, now);
      // Reservation and exact-candidate approval commit together. No renewal or retry after a reservation.
      if (live.reserved || latestCiEvent(store, child.mission_id, 'ci_repair_push_intent')) throw Error('ci_auto_grant_consumed');
      const approved = approveSandboxCiRepair(store, live.actor, child.mission_id, child.candidate_head!, now, live.reservation.grant_id);
      store.record(child.mission_id, 'ci_auto_grant_reserved', live.reservation, now);
      return approved;
    }).immediate();
  }
}
