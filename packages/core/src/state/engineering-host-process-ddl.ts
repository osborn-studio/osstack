/**
 * W13-A: host child-process ledger (design docs/design/2026-11-06-w13-host-git-survival.md section 3.3).
 *
 * Registered as migration 54 ("engineering_host_processes") in migrations.ts.
 *
 * Additive only: new table, indexes and triggers. Nothing in the migration-50 tables is rebuilt.
 *
 * Every CHECK is written so a NULL operand cannot make it pass vacuously (SQLite treats a NULL
 * CHECK result as satisfied): nullable columns are always guarded with IS NOT NULL.
 */
export const ENGINEERING_HOST_PROCESS_DDL = `
CREATE TABLE engineering_host_processes (
  op_id TEXT NOT NULL PRIMARY KEY CHECK(op_id LIKE 'hp\\_%' ESCAPE '\\' AND length(op_id)<=128),
  mission_id TEXT NOT NULL REFERENCES engineering_contained_missions(mission_id),
  kind TEXT NOT NULL CHECK(kind IN ('git_push','gh_pr_create','git_update_ref','git_worktree_add','git_index_write')),
  remote_target TEXT CHECK(remote_target IS NULL OR length(remote_target) BETWEEN 1 AND 1024),
  local_target TEXT NOT NULL CHECK(length(local_target) BETWEEN 1 AND 1024),
  intent_id TEXT CHECK(intent_id IS NULL OR length(intent_id) BETWEEN 1 AND 256),
  argv_digest TEXT NOT NULL CHECK(length(argv_digest)=64),
  owner_home TEXT NOT NULL, owner_instance TEXT NOT NULL,
  owner_generation INTEGER NOT NULL CHECK(typeof(owner_generation)='integer' AND owner_generation>0),
  boot_id TEXT NOT NULL CHECK(length(boot_id) BETWEEN 1 AND 256),
  marker_path TEXT NOT NULL CHECK(length(marker_path) BETWEEN 1 AND 1024),
  marker_dev TEXT NOT NULL CHECK(length(marker_dev) BETWEEN 1 AND 32),
  marker_ino TEXT NOT NULL CHECK(length(marker_ino) BETWEEN 1 AND 32),
  state TEXT NOT NULL CHECK(state IN ('launching','registered','released','stopped')),
  pid INTEGER CHECK(pid IS NULL OR typeof(pid)='integer'),
  pgid INTEGER CHECK(pgid IS NULL OR typeof(pgid)='integer'),
  leader_start TEXT CHECK(leader_start IS NULL OR length(leader_start) BETWEEN 1 AND 256),
  released_at INTEGER CHECK(released_at IS NULL OR (typeof(released_at)='integer' AND released_at>=0)),
  exit_code INTEGER CHECK(exit_code IS NULL OR typeof(exit_code)='integer'),
  exit_signal TEXT CHECK(exit_signal IS NULL OR length(exit_signal) BETWEEN 1 AND 32),
  stop_proof TEXT CHECK(stop_proof IS NULL OR length(stop_proof) BETWEEN 1 AND 64),
  stop_detail_json TEXT CHECK(stop_detail_json IS NULL OR (length(stop_detail_json)<=4096 AND json_valid(stop_detail_json))),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=0),
  CHECK(kind NOT IN ('git_push','gh_pr_create') OR remote_target IS NOT NULL),
  CHECK((pid IS NULL) = (pgid IS NULL)),
  CHECK(pid IS NULL OR (pgid = pid AND pid > 1)),
  CHECK(leader_start IS NULL OR pid IS NOT NULL),
  CHECK(state NOT IN ('registered','released') OR (pid IS NOT NULL AND pgid IS NOT NULL AND pgid = pid AND pid > 1)),
  CHECK(state <> 'launching' OR (pid IS NULL AND released_at IS NULL)),
  CHECK(released_at IS NULL OR pid IS NOT NULL),
  CHECK(released_at IS NULL OR state IN ('released','stopped')),
  CHECK(state <> 'released' OR released_at IS NOT NULL),
  CHECK(state <> 'stopped' OR stop_proof IS NOT NULL),
  CHECK(state = 'stopped' OR (stop_proof IS NULL AND stop_detail_json IS NULL AND exit_code IS NULL AND exit_signal IS NULL))
);
CREATE UNIQUE INDEX engineering_host_process_mission_open ON engineering_host_processes(mission_id) WHERE state <> 'stopped';
CREATE UNIQUE INDEX engineering_host_process_remote_open ON engineering_host_processes(remote_target)
  WHERE state <> 'stopped' AND remote_target IS NOT NULL;
CREATE UNIQUE INDEX engineering_host_process_intent ON engineering_host_processes(intent_id) WHERE intent_id IS NOT NULL;
CREATE INDEX engineering_host_process_open ON engineering_host_processes(state, created_at) WHERE state <> 'stopped';

CREATE TRIGGER engineering_host_process_fixed BEFORE UPDATE ON engineering_host_processes
WHEN OLD.op_id IS NOT NEW.op_id OR OLD.mission_id IS NOT NEW.mission_id OR OLD.kind IS NOT NEW.kind
  OR OLD.remote_target IS NOT NEW.remote_target OR OLD.local_target IS NOT NEW.local_target OR OLD.intent_id IS NOT NEW.intent_id
  OR OLD.argv_digest IS NOT NEW.argv_digest OR OLD.owner_home IS NOT NEW.owner_home OR OLD.owner_instance IS NOT NEW.owner_instance
  OR OLD.owner_generation IS NOT NEW.owner_generation OR OLD.boot_id IS NOT NEW.boot_id
  OR OLD.marker_path IS NOT NEW.marker_path OR OLD.marker_dev IS NOT NEW.marker_dev OR OLD.marker_ino IS NOT NEW.marker_ino
  OR OLD.created_at IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT,'host_process_immutable'); END;

CREATE TRIGGER engineering_host_process_flow BEFORE UPDATE ON engineering_host_processes
WHEN NOT ((OLD.state='launching' AND NEW.state IN ('registered','stopped'))
       OR (OLD.state='registered' AND NEW.state IN ('released','stopped'))
       OR (OLD.state='released' AND NEW.state='stopped'))
  OR (NOT (OLD.state='launching' AND NEW.state='registered')
      AND (OLD.pid IS NOT NEW.pid OR OLD.pgid IS NOT NEW.pgid OR OLD.leader_start IS NOT NEW.leader_start))
  OR (OLD.state='launching' AND NEW.state='registered' AND (OLD.pid IS NOT NULL OR OLD.pgid IS NOT NULL OR OLD.leader_start IS NOT NULL))
  OR (NOT (OLD.state='registered' AND NEW.state='released') AND OLD.released_at IS NOT NEW.released_at)
  OR (OLD.state='registered' AND NEW.state='released' AND OLD.released_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'host_process_flow'); END;

CREATE TRIGGER engineering_host_process_proof BEFORE UPDATE ON engineering_host_processes
WHEN NEW.state='stopped' AND (
     (NEW.stop_proof IN ('never_released') AND OLD.released_at IS NOT NULL)
  OR (NEW.stop_proof IN ('never_spawned','never_registered+marker_unheld') AND OLD.state<>'launching'))
BEGIN SELECT RAISE(ABORT,'host_process_proof_mismatch'); END;

CREATE TRIGGER engineering_host_process_no_delete BEFORE DELETE ON engineering_host_processes
BEGIN SELECT RAISE(ABORT,'host_process_immutable'); END;

CREATE TRIGGER engineering_host_process_insert_shape BEFORE INSERT ON engineering_host_processes
WHEN NEW.state IS NOT 'launching' OR NEW.pid IS NOT NULL OR NEW.pgid IS NOT NULL OR NEW.leader_start IS NOT NULL
  OR NEW.released_at IS NOT NULL OR NEW.exit_code IS NOT NULL OR NEW.exit_signal IS NOT NULL
  OR NEW.stop_proof IS NOT NULL OR NEW.stop_detail_json IS NOT NULL
BEGIN SELECT RAISE(ABORT,'host_process_insert_invalid'); END;

CREATE TRIGGER engineering_host_process_insert_gate BEFORE INSERT ON engineering_host_processes
WHEN NOT EXISTS (SELECT 1 FROM engineering_contained_missions m WHERE m.mission_id=NEW.mission_id
  AND m.state NOT IN ('pr_opened','cancelled','abandoned','failed','stop_unknown','cancel_requested') AND m.stop_obligation=0)
BEGIN SELECT RAISE(ABORT,'host_process_launch_denied'); END;

-- INSERT OR REPLACE deletes the conflicting row without firing DELETE triggers (recursive_triggers is off), so the
-- uniqueness rules and the claim/Mission guards are also enforced on INSERT, before any conflict resolution.
CREATE TRIGGER engineering_host_process_insert_mission_busy BEFORE INSERT ON engineering_host_processes
WHEN EXISTS (SELECT 1 FROM engineering_host_processes h WHERE h.mission_id=NEW.mission_id AND h.state<>'stopped')
BEGIN SELECT RAISE(ABORT,'host_process_mission_busy'); END;
CREATE TRIGGER engineering_host_process_insert_remote_busy BEFORE INSERT ON engineering_host_processes
WHEN NEW.remote_target IS NOT NULL AND EXISTS (SELECT 1 FROM engineering_host_processes h WHERE h.remote_target=NEW.remote_target AND h.state<>'stopped')
BEGIN SELECT RAISE(ABORT,'host_process_remote_busy'); END;
CREATE TRIGGER engineering_host_process_insert_intent_reused BEFORE INSERT ON engineering_host_processes
WHEN NEW.intent_id IS NOT NULL AND EXISTS (SELECT 1 FROM engineering_host_processes h WHERE h.intent_id=NEW.intent_id)
BEGIN SELECT RAISE(ABORT,'host_process_intent_reused'); END;
CREATE TRIGGER engineering_host_process_insert_op_exists BEFORE INSERT ON engineering_host_processes
WHEN EXISTS (SELECT 1 FROM engineering_host_processes h WHERE h.op_id=NEW.op_id)
BEGIN SELECT RAISE(ABORT,'host_process_op_exists'); END;

-- REPLACE may delete a claim of ANOTHER Mission through a claim_id, branch or worktree conflict: check every conflicting owner.
CREATE TRIGGER engineering_claim_replace_host_processes BEFORE INSERT ON engineering_workspace_claims
WHEN EXISTS (SELECT 1 FROM engineering_host_processes h JOIN engineering_workspace_claims c ON c.mission_id=h.mission_id
  WHERE h.state<>'stopped' AND (c.mission_id=NEW.mission_id OR c.claim_id=NEW.claim_id
    OR (c.state='active' AND NEW.state='active' AND ((c.repo_identity=NEW.repo_identity AND c.branch=NEW.branch) OR c.worktree_identity=NEW.worktree_identity))))
BEGIN SELECT RAISE(ABORT,'claim_release_denied'); END;
CREATE TRIGGER engineering_contained_host_process_replace BEFORE INSERT ON engineering_contained_missions
WHEN EXISTS (SELECT 1 FROM engineering_host_processes h WHERE h.mission_id=NEW.mission_id AND h.state<>'stopped')
BEGIN SELECT RAISE(ABORT,'host_process_unproven'); END;

CREATE TRIGGER engineering_claim_release_host_processes BEFORE UPDATE OF state ON engineering_workspace_claims
WHEN NEW.state='released' AND EXISTS (SELECT 1 FROM engineering_host_processes h WHERE h.mission_id=OLD.mission_id AND h.state<>'stopped')
BEGIN SELECT RAISE(ABORT,'claim_release_denied'); END;

CREATE TRIGGER engineering_contained_host_process_gate BEFORE UPDATE ON engineering_contained_missions
WHEN ((NEW.state<>OLD.state AND NEW.state IN ('cancelled','pr_opened')) OR (OLD.stop_obligation=1 AND NEW.stop_obligation=0))
  AND EXISTS (SELECT 1 FROM engineering_host_processes h WHERE h.mission_id=OLD.mission_id AND h.state<>'stopped')
BEGIN SELECT RAISE(ABORT,'host_process_unproven'); END;
`;
