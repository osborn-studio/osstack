/** Additive shadow ledger. This migration grants no execution authority. */
export const ENGINEERING_VERIFICATION_SOURCE_DDL = `
CREATE TABLE engineering_verification_sources (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('check_run')),
  object_id INTEGER NOT NULL CHECK(typeof(object_id)='integer' AND object_id>0),
  repository_id INTEGER NOT NULL CHECK(typeof(repository_id)='integer' AND repository_id>0),
  repository TEXT NOT NULL CHECK(length(repository) BETWEEN 1 AND 200 AND instr(repository,char(0))=0),
  pr_number INTEGER NOT NULL CHECK(typeof(pr_number)='integer' AND pr_number>0),
  observed_head_sha TEXT NOT NULL CHECK(instr(observed_head_sha,char(0))=0 AND length(observed_head_sha)=40 AND observed_head_sha NOT GLOB '*[^0-9a-f]*'),
  app_id INTEGER NOT NULL CHECK(typeof(app_id)='integer' AND app_id>0),
  check_name TEXT NOT NULL CHECK(length(check_name) BETWEEN 1 AND 255 AND instr(check_name,char(0))=0),
  response_digest TEXT NOT NULL CHECK(instr(response_digest,char(0))=0 AND length(response_digest)=64 AND response_digest NOT GLOB '*[^0-9a-f]*'),
  contract_digest TEXT CHECK(contract_digest IS NULL OR (instr(contract_digest,char(0))=0 AND length(contract_digest)=64 AND contract_digest NOT GLOB '*[^0-9a-f]*')),
  result_id TEXT CHECK(result_id IS NULL OR (instr(result_id,char(0))=0 AND length(result_id)=36 AND result_id NOT GLOB '*[^0-9a-f-]*' AND substr(result_id,9,1)='-' AND substr(result_id,14,1)='-' AND substr(result_id,19,1)='-' AND substr(result_id,24,1)='-' AND length(replace(result_id,'-',''))=32)),
  withdraws_result_id TEXT CHECK(withdraws_result_id IS NULL OR (instr(withdraws_result_id,char(0))=0 AND length(withdraws_result_id)=36 AND withdraws_result_id NOT GLOB '*[^0-9a-f-]*' AND substr(withdraws_result_id,9,1)='-' AND substr(withdraws_result_id,14,1)='-' AND substr(withdraws_result_id,19,1)='-' AND substr(withdraws_result_id,24,1)='-' AND length(replace(withdraws_result_id,'-',''))=32)),
  supersedes_result_id TEXT CHECK(supersedes_result_id IS NULL OR (instr(supersedes_result_id,char(0))=0 AND length(supersedes_result_id)=36 AND supersedes_result_id NOT GLOB '*[^0-9a-f-]*' AND substr(supersedes_result_id,9,1)='-' AND substr(supersedes_result_id,14,1)='-' AND substr(supersedes_result_id,19,1)='-' AND substr(supersedes_result_id,24,1)='-' AND length(replace(supersedes_result_id,'-',''))=32)),
  attempt INTEGER CHECK(attempt IS NULL OR (typeof(attempt)='integer' AND attempt>0)),
  skill_id TEXT CHECK(skill_id IS NULL OR (instr(skill_id,char(0))=0 AND length(skill_id) BETWEEN 1 AND 128 AND skill_id GLOB '[a-z]*' AND skill_id NOT GLOB '*[^a-z0-9_-]*')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('passed','failed','blocked','cancelled')),
  head_sha TEXT CHECK(head_sha IS NULL OR (instr(head_sha,char(0))=0 AND length(head_sha)=40 AND head_sha NOT GLOB '*[^0-9a-f]*')),
  base_sha TEXT CHECK(base_sha IS NULL OR (instr(base_sha,char(0))=0 AND length(base_sha)=40 AND base_sha NOT GLOB '*[^0-9a-f]*')),
  dedup_key TEXT CHECK(dedup_key IS NULL OR (instr(dedup_key,char(0))=0 AND length(dedup_key)=64 AND dedup_key NOT GLOB '*[^0-9a-f]*')),
  decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected','duplicate')),
  reason_code TEXT,
  original_seq INTEGER REFERENCES engineering_verification_sources(seq),
  withdraws_seq INTEGER REFERENCES engineering_verification_sources(seq),
  summary_reference_json TEXT CHECK(summary_reference_json IS NULL OR (json_valid(summary_reference_json) AND length(CAST(summary_reference_json AS BLOB))<=8192)),
  intake_id TEXT CHECK(intake_id IS NULL OR (intake_id GLOB 'lfi_*' AND length(intake_id)=40 AND substr(intake_id,5) NOT GLOB '*[^0-9a-f-]*' AND instr(intake_id,char(0))=0)),
  observed_at INTEGER NOT NULL CHECK(typeof(observed_at)='integer' AND observed_at>=0),
  recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at>=0),
  CHECK((result_id IS NULL AND attempt IS NULL AND skill_id IS NULL AND outcome IS NULL AND head_sha IS NULL AND base_sha IS NULL AND dedup_key IS NULL AND summary_reference_json IS NULL AND withdraws_result_id IS NULL AND supersedes_result_id IS NULL) OR (result_id IS NOT NULL AND attempt IS NOT NULL AND skill_id IS NOT NULL AND outcome IS NOT NULL AND head_sha IS NOT NULL AND base_sha IS NOT NULL AND dedup_key IS NOT NULL AND summary_reference_json IS NOT NULL)),
  CHECK((decision='accepted' AND reason_code IS NULL) OR (decision='duplicate' AND reason_code IS NOT NULL AND reason_code='verify_duplicate') OR (decision='rejected' AND reason_code IS NOT NULL AND reason_code IN ('verify_contract_invalid','verify_skill_unregistered','verify_evidence_invalid','verify_scope_unregistered','verify_producer_untrusted','verify_stale_head','verify_base_changed','verify_result_expired','verify_read_incomplete','verify_attempt_ambiguous'))),
  CHECK((decision='duplicate' AND original_seq IS NOT NULL) OR (decision!='duplicate' AND original_seq IS NULL)),
  CHECK(withdraws_seq IS NULL OR decision='accepted'),
  CHECK(decision='rejected' OR result_id IS NOT NULL),
  UNIQUE(source_kind,object_id,response_digest)
);
CREATE INDEX engineering_verification_sources_pr ON engineering_verification_sources(repository_id,pr_number,seq);
CREATE INDEX engineering_verification_sources_result ON engineering_verification_sources(result_id);
CREATE UNIQUE INDEX engineering_verification_sources_registration ON engineering_verification_sources(result_id) WHERE decision='accepted';
CREATE TRIGGER engineering_verification_sources_no_delete BEFORE DELETE ON engineering_verification_sources
BEGIN SELECT RAISE(ABORT,'verification_source_immutable'); END;
CREATE TRIGGER engineering_verification_sources_no_update BEFORE UPDATE ON engineering_verification_sources
WHEN NOT (OLD.intake_id IS NULL AND NEW.intake_id IS NOT NULL AND OLD.decision='accepted'
  AND NEW.seq IS OLD.seq
  AND NEW.source_kind IS OLD.source_kind
  AND NEW.object_id IS OLD.object_id
  AND NEW.repository_id IS OLD.repository_id
  AND NEW.repository IS OLD.repository
  AND NEW.pr_number IS OLD.pr_number
  AND NEW.observed_head_sha IS OLD.observed_head_sha
  AND NEW.app_id IS OLD.app_id
  AND NEW.check_name IS OLD.check_name
  AND NEW.response_digest IS OLD.response_digest
  AND NEW.contract_digest IS OLD.contract_digest
  AND NEW.result_id IS OLD.result_id
  AND NEW.withdraws_result_id IS OLD.withdraws_result_id
  AND NEW.supersedes_result_id IS OLD.supersedes_result_id
  AND NEW.attempt IS OLD.attempt
  AND NEW.skill_id IS OLD.skill_id
  AND NEW.outcome IS OLD.outcome
  AND NEW.head_sha IS OLD.head_sha
  AND NEW.base_sha IS OLD.base_sha
  AND NEW.dedup_key IS OLD.dedup_key
  AND NEW.decision IS OLD.decision
  AND NEW.reason_code IS OLD.reason_code
  AND NEW.original_seq IS OLD.original_seq
  AND NEW.withdraws_seq IS OLD.withdraws_seq
  AND NEW.summary_reference_json IS OLD.summary_reference_json
  AND NEW.observed_at IS OLD.observed_at
  AND NEW.recorded_at IS OLD.recorded_at)
BEGIN SELECT RAISE(ABORT,'verification_source_immutable'); END;
`;
