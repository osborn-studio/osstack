/** Additive contained-Mission ledger (W11 §4.1). Separate from the adopted-session
 * Mission tables so migration 50 never rebuilds a table that child rows reference. */
export const ENGINEERING_CONTAINED_DDL = `
CREATE TABLE engineering_contained_missions (
  mission_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES attention_scopes(scope_id),
  owner_principal_id TEXT NOT NULL, owner_client_session_id TEXT NOT NULL,
  spec_digest TEXT NOT NULL CHECK(length(spec_digest)=64), spec_json TEXT NOT NULL CHECK(length(spec_json)<=32768),
  state TEXT NOT NULL CHECK(state IN ('authorized','workspace_ready','executing','candidate_ready','verifying','verified','verify_failed',
    'revalidating','delivering','pr_opened','awaiting_decision','needs_reconciliation','stop_unknown','cancel_requested','cancelled','abandoned','failed')),
  revision INTEGER NOT NULL CHECK(revision>0),
  expected_head TEXT, candidate_head TEXT, candidate_tree TEXT, candidate_diff_digest TEXT,
  verify_attempts INTEGER NOT NULL DEFAULT 0 CHECK(verify_attempts>=0),
  repair_cycles INTEGER NOT NULL DEFAULT 0 CHECK(repair_cycles>=0),
  stop_obligation INTEGER NOT NULL DEFAULT 0 CHECK(stop_obligation IN (0,1)),
  supersedes TEXT REFERENCES engineering_contained_missions(mission_id),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK(state<>'cancelled' OR stop_obligation=0)
);
CREATE INDEX engineering_contained_scan ON engineering_contained_missions(created_at,mission_id);
CREATE TRIGGER engineering_contained_fixed BEFORE UPDATE ON engineering_contained_missions
WHEN OLD.mission_id<>NEW.mission_id OR OLD.scope_id<>NEW.scope_id OR OLD.owner_principal_id<>NEW.owner_principal_id
  OR OLD.owner_client_session_id<>NEW.owner_client_session_id OR OLD.spec_digest<>NEW.spec_digest OR OLD.spec_json<>NEW.spec_json
  OR OLD.created_at<>NEW.created_at OR OLD.supersedes IS NOT NEW.supersedes OR NEW.revision<>OLD.revision+1
  OR NEW.verify_attempts<OLD.verify_attempts OR NEW.repair_cycles<OLD.repair_cycles
BEGIN SELECT RAISE(ABORT,'contained_mission_immutable'); END;
CREATE TRIGGER engineering_contained_terminal BEFORE UPDATE ON engineering_contained_missions
WHEN OLD.state IN ('pr_opened','cancelled','abandoned','failed')
  AND (NEW.state<>OLD.state OR NOT (OLD.stop_obligation=1 AND NEW.stop_obligation=0))
BEGIN SELECT RAISE(ABORT,'contained_mission_terminal'); END;
CREATE TRIGGER engineering_contained_gates BEFORE UPDATE OF state ON engineering_contained_missions
WHEN NEW.state<>OLD.state AND ((NEW.state='verified' AND OLD.state<>'verifying')
  OR (NEW.state='delivering' AND OLD.state<>'revalidating') OR (NEW.state='pr_opened' AND OLD.state<>'delivering'))
BEGIN SELECT RAISE(ABORT,'contained_transition_denied'); END;
CREATE TABLE engineering_contained_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL REFERENCES engineering_contained_missions(mission_id),
  kind TEXT NOT NULL, actor TEXT, payload_json TEXT NOT NULL CHECK(length(payload_json)<=32768), created_at INTEGER NOT NULL
);
CREATE INDEX engineering_contained_events_mission ON engineering_contained_events(mission_id,seq);
CREATE TRIGGER engineering_contained_events_append_only BEFORE UPDATE ON engineering_contained_events
BEGIN SELECT RAISE(ABORT,'contained_event_immutable'); END;
CREATE TRIGGER engineering_contained_events_no_delete BEFORE DELETE ON engineering_contained_events
BEGIN SELECT RAISE(ABORT,'contained_event_immutable'); END;
CREATE TABLE engineering_workspace_claims (
  claim_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL UNIQUE REFERENCES engineering_contained_missions(mission_id),
  repo_identity TEXT NOT NULL, branch TEXT NOT NULL, worktree_identity TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','released')), created_at INTEGER NOT NULL,
  released_at INTEGER, release_reason TEXT,
  CHECK((state='active' AND released_at IS NULL AND release_reason IS NULL)
     OR (state='released' AND released_at IS NOT NULL AND release_reason IS NOT NULL))
);
CREATE UNIQUE INDEX engineering_claim_branch ON engineering_workspace_claims(repo_identity,branch) WHERE state='active';
CREATE UNIQUE INDEX engineering_claim_worktree ON engineering_workspace_claims(worktree_identity) WHERE state='active';
CREATE TRIGGER engineering_claim_release BEFORE UPDATE ON engineering_workspace_claims
WHEN OLD.state<>'active' OR NEW.state<>'released' OR OLD.claim_id<>NEW.claim_id OR OLD.mission_id<>NEW.mission_id
  OR OLD.repo_identity<>NEW.repo_identity OR OLD.branch<>NEW.branch OR OLD.worktree_identity<>NEW.worktree_identity
  OR OLD.created_at<>NEW.created_at
  OR NOT EXISTS (SELECT 1 FROM engineering_contained_missions m WHERE m.mission_id=OLD.mission_id
    AND m.state IN ('pr_opened','cancelled','abandoned','failed') AND m.stop_obligation=0)
BEGIN SELECT RAISE(ABORT,'claim_release_denied'); END;
CREATE TRIGGER engineering_claim_no_delete BEFORE DELETE ON engineering_workspace_claims
BEGIN SELECT RAISE(ABORT,'claim_release_denied'); END;
`;
