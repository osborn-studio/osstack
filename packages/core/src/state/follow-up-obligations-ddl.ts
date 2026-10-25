/** Migration 44 SQL. Preserve its lineage; never apply from a service constructor. */
export const FOLLOW_UP_OBLIGATIONS_DDL = `
CREATE TABLE IF NOT EXISTS follow_up_obligations (
  obligation_id TEXT PRIMARY KEY NOT NULL,
  repo_path TEXT NOT NULL CHECK(length(CAST(repo_path AS BLOB)) BETWEEN 1 AND 4096),
  tenant TEXT NOT NULL CHECK(tenant = 'default'),
  source_session_id TEXT NOT NULL CHECK(length(CAST(source_session_id AS BLOB)) BETWEEN 1 AND 256),
  source_task_id TEXT NOT NULL CHECK(length(CAST(source_task_id AS BLOB)) BETWEEN 1 AND 256),
  source_run_id TEXT NOT NULL CHECK(length(CAST(source_run_id AS BLOB)) BETWEEN 1 AND 256),
  source_creation_version INTEGER NOT NULL CHECK(typeof(source_creation_version)='integer' AND source_creation_version BETWEEN 1 AND 9007199254740990),
  source_identity_digest TEXT NOT NULL CHECK(length(source_identity_digest)=64 AND source_identity_digest NOT GLOB '*[^0-9a-f]*'),
  actor TEXT NOT NULL CHECK(length(CAST(actor AS BLOB)) BETWEEN 1 AND 128),
  promise TEXT NOT NULL CHECK(length(CAST(promise AS BLOB)) BETWEEN 1 AND 4096),
  destination_ref TEXT NOT NULL CHECK(destination_ref='local_operator'),
  resolution_condition TEXT NOT NULL CHECK(resolution_condition IN ('manual','session_completed')),
  due_at INTEGER CHECK(due_at IS NULL OR (typeof(due_at)='integer' AND due_at BETWEEN 0 AND 8640000000000000)),
  idempotency_key TEXT NOT NULL CHECK(length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 128),
  create_digest TEXT NOT NULL CHECK(length(create_digest)=64 AND create_digest NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('open','drafted','fulfilled_local','waived')),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740990),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 8640000000000000),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN created_at AND 8640000000000000),
  draft_json TEXT CHECK(draft_json IS NULL OR (json_valid(draft_json) AND length(CAST(draft_json AS BLOB))<=32768)),
  resolution_json TEXT CHECK(resolution_json IS NULL OR (json_valid(resolution_json) AND length(CAST(resolution_json AS BLOB))<=16384)),
  UNIQUE(repo_path,tenant,idempotency_key),
  CHECK((state IN ('fulfilled_local','waived')) = (resolution_json IS NOT NULL)),
  CHECK(state != 'drafted' OR draft_json IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS follow_up_scope_page ON follow_up_obligations(repo_path,tenant,created_at,obligation_id);
CREATE INDEX IF NOT EXISTS follow_up_scope_due ON follow_up_obligations(repo_path,tenant,state,due_at);
CREATE TABLE IF NOT EXISTS follow_up_obligation_events (
  obligation_id TEXT NOT NULL REFERENCES follow_up_obligations(obligation_id),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740990),
  transition TEXT NOT NULL CHECK(transition IN ('created','drafted','fulfilled_local','waived')),
  actor TEXT NOT NULL CHECK(length(CAST(actor AS BLOB)) BETWEEN 1 AND 128),
  content_digest TEXT NOT NULL CHECK(length(content_digest)=64 AND content_digest NOT GLOB '*[^0-9a-f]*'),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND length(CAST(evidence_json AS BLOB))<=32768),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY(obligation_id,revision)
);
CREATE TRIGGER IF NOT EXISTS follow_up_identity_immutable BEFORE UPDATE OF obligation_id,repo_path,tenant,source_session_id,source_task_id,source_run_id,source_creation_version,source_identity_digest,actor,promise,destination_ref,resolution_condition,due_at,idempotency_key,create_digest,created_at ON follow_up_obligations
BEGIN SELECT RAISE(ABORT,'follow up identity immutable'); END;
CREATE TRIGGER IF NOT EXISTS follow_up_terminal_sealed BEFORE UPDATE ON follow_up_obligations WHEN OLD.state IN ('fulfilled_local','waived')
BEGIN SELECT RAISE(ABORT,'follow up terminal immutable'); END;
CREATE TRIGGER IF NOT EXISTS follow_up_no_delete BEFORE DELETE ON follow_up_obligations BEGIN SELECT RAISE(ABORT,'follow up history immutable'); END;
CREATE TRIGGER IF NOT EXISTS follow_up_events_no_update BEFORE UPDATE ON follow_up_obligation_events BEGIN SELECT RAISE(ABORT,'follow up events immutable'); END;
CREATE TRIGGER IF NOT EXISTS follow_up_events_no_delete BEFORE DELETE ON follow_up_obligation_events BEGIN SELECT RAISE(ABORT,'follow up events immutable'); END;
`;
