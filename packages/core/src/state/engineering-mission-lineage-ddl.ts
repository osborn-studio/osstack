/** Additive lineage ledger. Existing Missions receive no inferred lineage. */
export const ENGINEERING_MISSION_LINEAGE_DDL = `
CREATE TABLE engineering_mission_lineage (
  mission_id TEXT PRIMARY KEY REFERENCES engineering_contained_missions(mission_id),
  origin_mission_id TEXT NOT NULL REFERENCES engineering_contained_missions(mission_id),
  parent_mission_id TEXT REFERENCES engineering_contained_missions(mission_id),
  chain_depth INTEGER NOT NULL CHECK(chain_depth>=0),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('local_root','supersede','review','github_actions','local_failure','verification','patrol')),
  source_id TEXT CHECK(source_id IS NULL OR length(source_id) BETWEEN 1 AND 256),
  idempotency_key TEXT UNIQUE CHECK(idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 256),
  created_at INTEGER NOT NULL,
  CHECK((parent_mission_id IS NULL)=(chain_depth=0)),
  CHECK(parent_mission_id IS NULL OR (parent_mission_id<>mission_id AND origin_mission_id<>mission_id)),
  CHECK(source_kind IN ('local_root','supersede') OR (parent_mission_id IS NOT NULL AND idempotency_key IS NOT NULL))
);
CREATE INDEX engineering_mission_lineage_parent ON engineering_mission_lineage(parent_mission_id);
CREATE INDEX engineering_mission_lineage_origin ON engineering_mission_lineage(origin_mission_id);
CREATE TRIGGER engineering_mission_lineage_no_update BEFORE UPDATE ON engineering_mission_lineage
BEGIN SELECT RAISE(ABORT,'mission_lineage_immutable'); END;
CREATE TRIGGER engineering_mission_lineage_no_delete BEFORE DELETE ON engineering_mission_lineage
BEGIN SELECT RAISE(ABORT,'mission_lineage_immutable'); END;
CREATE TRIGGER engineering_mission_lineage_insert_gate BEFORE INSERT ON engineering_mission_lineage
WHEN NOT EXISTS (SELECT 1 FROM engineering_contained_missions WHERE mission_id=NEW.mission_id AND revision=1 AND state='authorized')
BEGIN SELECT RAISE(ABORT,'mission_lineage_late'); END;
`;
