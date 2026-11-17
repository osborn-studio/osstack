import { randomUUID } from 'node:crypto';
import { attentionDigest, ContainedMissionStore } from '@osstack/core';
import { vi } from 'vitest';

/** Seed fixture roots through SQL, as a pre-lineage writer did. Keep immutable triggers installed. */
export function withLegacyRoot<T>(setup: () => T): T {
  const stub = vi.spyOn(ContainedMissionStore.prototype, 'authorize').mockImplementation(function (this: ContainedMissionStore, principal, input, now) {
    return this.db.transaction(() => {
      const id = `cm_${randomUUID()}`;
      this.db.prepare(`INSERT INTO engineering_contained_missions(mission_id,scope_id,owner_principal_id,owner_client_session_id,spec_digest,spec_json,state,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'authorized',1,?,?)`).run(id, input.scope_id, principal.principal_id, principal.client_session_id, attentionDigest(input.spec), JSON.stringify(input.spec), now, now);
      this.db.prepare(`INSERT INTO engineering_workspace_claims(claim_id,mission_id,repo_identity,branch,worktree_identity,state,created_at)
        VALUES(?,?,?,?,?,'active',?)`).run(`wc_${randomUUID()}`, id, input.claim.repo_identity, input.claim.branch, input.claim.worktree_identity, now);
      this.record(id, 'contained_authorized', { spec_digest: attentionDigest(input.spec), supersedes: null }, now, principal.principal_id);
      this.record(id, 'workspace_claimed', input.claim, now);
      return this.get(id);
    })();
  });
  try { return setup(); } finally { stub.mockRestore(); }
}
