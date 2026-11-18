export const ENGINEERING_DIAGNOSIS_DDL = `
CREATE TABLE engineering_diagnosis_requests (
  request_id TEXT NOT NULL CHECK(typeof(request_id)='text' AND instr(request_id,char(0))=0 AND length(request_id) BETWEEN 1 AND 40 AND length(request_id)=40 AND request_id GLOB 'vdr_*' AND substr(request_id,5) NOT GLOB '*[^0-9a-f-]*') PRIMARY KEY,
  source_seq INTEGER NOT NULL UNIQUE REFERENCES engineering_verification_sources(seq),
  result_id TEXT NOT NULL CHECK(typeof(result_id)='text' AND instr(result_id,char(0))=0 AND length(result_id) BETWEEN 1 AND 36) UNIQUE,
  repository_id INTEGER NOT NULL CHECK(typeof(repository_id)='integer' AND repository_id>=1),
  repository TEXT NOT NULL CHECK(typeof(repository)='text' AND instr(repository,char(0))=0 AND length(repository) BETWEEN 1 AND 200),
  pr_number INTEGER NOT NULL CHECK(typeof(pr_number)='integer' AND pr_number>=1),
  head_sha TEXT NOT NULL CHECK(typeof(head_sha)='text' AND instr(head_sha,char(0))=0 AND length(head_sha) BETWEEN 1 AND 40 AND length(head_sha)=40 AND head_sha NOT GLOB '*[^0-9a-f]*'),
  base_sha TEXT NOT NULL CHECK(typeof(base_sha)='text' AND instr(base_sha,char(0))=0 AND length(base_sha) BETWEEN 1 AND 40 AND length(base_sha)=40 AND base_sha NOT GLOB '*[^0-9a-f]*'),
  base_ref TEXT NOT NULL CHECK(typeof(base_ref)='text' AND instr(base_ref,char(0))=0 AND length(base_ref) BETWEEN 1 AND 255),
  branch TEXT NOT NULL CHECK(typeof(branch)='text' AND instr(branch,char(0))=0 AND length(branch) BETWEEN 1 AND 255),
  skill_id TEXT NOT NULL CHECK(typeof(skill_id)='text' AND instr(skill_id,char(0))=0 AND length(skill_id) BETWEEN 1 AND 128),
  profile_id TEXT NOT NULL CHECK(typeof(profile_id)='text' AND instr(profile_id,char(0))=0 AND length(profile_id) BETWEEN 1 AND 128),
  profile_digest TEXT NOT NULL CHECK(typeof(profile_digest)='text' AND instr(profile_digest,char(0))=0 AND length(profile_digest) BETWEEN 1 AND 64 AND length(profile_digest)=64 AND profile_digest NOT GLOB '*[^0-9a-f]*'),
  trusted_source_digest TEXT NOT NULL CHECK(typeof(trusted_source_digest)='text' AND instr(trusted_source_digest,char(0))=0 AND length(trusted_source_digest) BETWEEN 1 AND 64 AND length(trusted_source_digest)=64 AND trusted_source_digest NOT GLOB '*[^0-9a-f]*'),
  trusted_repository TEXT NOT NULL CHECK(typeof(trusted_repository)='text' AND instr(trusted_repository,char(0))=0 AND length(trusted_repository) BETWEEN 1 AND 200),
  trusted_commit TEXT NOT NULL CHECK(typeof(trusted_commit)='text' AND instr(trusted_commit,char(0))=0 AND length(trusted_commit) BETWEEN 1 AND 40 AND length(trusted_commit)=40 AND trusted_commit NOT GLOB '*[^0-9a-f]*'),
  root_mission_id TEXT NOT NULL REFERENCES engineering_contained_missions(mission_id),
  expected_failures_json TEXT NOT NULL CHECK(json_valid(expected_failures_json) AND json_type(expected_failures_json)='array' AND length(CAST(expected_failures_json AS BLOB))<=40000) CHECK(json_array_length(expected_failures_json)<=128),
  allowed_codes_json TEXT NOT NULL CHECK(json_valid(allowed_codes_json) AND json_type(allowed_codes_json)='array' AND length(CAST(allowed_codes_json AS BLOB))<=20000),
  summary_reference_json TEXT NOT NULL CHECK(json_valid(summary_reference_json) AND json_type(summary_reference_json)='object' AND length(CAST(summary_reference_json AS BLOB))<=8192) CHECK(json_extract(summary_reference_json,'$.kind') IS 'external_reference' AND json_extract(summary_reference_json,'$.usage') IS 'reference_only'),
  owner_home TEXT NOT NULL CHECK(typeof(owner_home)='text' AND instr(owner_home,char(0))=0 AND length(owner_home) BETWEEN 1 AND 256),
  owner_instance TEXT NOT NULL CHECK(typeof(owner_instance)='text' AND instr(owner_instance,char(0))=0 AND length(owner_instance) BETWEEN 1 AND 256),
  owner_generation INTEGER NOT NULL CHECK(typeof(owner_generation)='integer' AND owner_generation>=1),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
  chain_id TEXT REFERENCES engineering_revision_chains(chain_id),
  state TEXT NOT NULL CHECK(state IN ('registered','awaiting_decision','admitted','diagnostic_closed','eligible')),
  reason TEXT CHECK(reason IS NULL OR (reason GLOB 'verify_?*' AND length(reason)<=128 AND instr(reason,char(0))=0)),
  intake_id TEXT UNIQUE REFERENCES engineering_local_failure_intakes(intake_id),
  receipt_id TEXT UNIQUE REFERENCES engineering_host_receipts(receipt_id),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=1),
  writer_instance TEXT NOT NULL CHECK(typeof(writer_instance)='text' AND instr(writer_instance,char(0))=0 AND length(writer_instance) BETWEEN 1 AND 256),
  writer_generation INTEGER NOT NULL CHECK(typeof(writer_generation)='integer' AND writer_generation>=1),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=0),
  CHECK(updated_at>=created_at AND ((state IN ('registered','admitted','eligible'))=(reason IS NULL))),
  CHECK(state NOT IN ('admitted','eligible') OR intake_id IS NOT NULL),
  CHECK(state<>'eligible' OR receipt_id IS NOT NULL)
);
CREATE TABLE engineering_host_receipts (
  receipt_id TEXT NOT NULL CHECK(typeof(receipt_id)='text' AND instr(receipt_id,char(0))=0 AND length(receipt_id) BETWEEN 1 AND 40 AND length(receipt_id)=40 AND receipt_id GLOB 'vhr_*' AND substr(receipt_id,5) NOT GLOB '*[^0-9a-f-]*') PRIMARY KEY,
  intake_id TEXT NOT NULL UNIQUE REFERENCES engineering_local_failure_intakes(intake_id),
  request_id TEXT NOT NULL UNIQUE REFERENCES engineering_diagnosis_requests(request_id),
  invocation_id TEXT NOT NULL CHECK(typeof(invocation_id)='text' AND instr(invocation_id,char(0))=0 AND length(invocation_id) BETWEEN 1 AND 256) UNIQUE,
  binding_json TEXT NOT NULL CHECK(json_valid(binding_json) AND json_type(binding_json)='object' AND length(CAST(binding_json AS BLOB))<=8192),
  profile_digest TEXT NOT NULL CHECK(typeof(profile_digest)='text' AND instr(profile_digest,char(0))=0 AND length(profile_digest) BETWEEN 1 AND 64 AND length(profile_digest)=64 AND profile_digest NOT GLOB '*[^0-9a-f]*'),
  trusted_source_digest TEXT NOT NULL CHECK(typeof(trusted_source_digest)='text' AND instr(trusted_source_digest,char(0))=0 AND length(trusted_source_digest) BETWEEN 1 AND 64 AND length(trusted_source_digest)=64 AND trusted_source_digest NOT GLOB '*[^0-9a-f]*'),
  run_identity_digest TEXT NOT NULL CHECK(typeof(run_identity_digest)='text' AND instr(run_identity_digest,char(0))=0 AND length(run_identity_digest) BETWEEN 1 AND 64 AND length(run_identity_digest)=64 AND run_identity_digest NOT GLOB '*[^0-9a-f]*'),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json)='object' AND length(CAST(receipt_json AS BLOB))<=32768),
  receipt_digest TEXT NOT NULL CHECK(typeof(receipt_digest)='text' AND instr(receipt_digest,char(0))=0 AND length(receipt_digest) BETWEEN 1 AND 64 AND length(receipt_digest)=64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'),
  evidence_digest TEXT NOT NULL CHECK(typeof(evidence_digest)='text' AND instr(evidence_digest,char(0))=0 AND length(evidence_digest) BETWEEN 1 AND 64 AND length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),
  stop_proof_ref TEXT NOT NULL CHECK(typeof(stop_proof_ref)='text' AND instr(stop_proof_ref,char(0))=0 AND length(stop_proof_ref) BETWEEN 1 AND 1024),
  stop_proof_digest TEXT NOT NULL CHECK(typeof(stop_proof_digest)='text' AND instr(stop_proof_digest,char(0))=0 AND length(stop_proof_digest) BETWEEN 1 AND 64 AND length(stop_proof_digest)=64 AND stop_proof_digest NOT GLOB '*[^0-9a-f]*'),
  outcome TEXT NOT NULL CHECK(typeof(outcome)='text' AND instr(outcome,char(0))=0 AND length(outcome) BETWEEN 1 AND 40),
  owner_home TEXT NOT NULL CHECK(typeof(owner_home)='text' AND instr(owner_home,char(0))=0 AND length(owner_home) BETWEEN 1 AND 256),
  owner_instance TEXT NOT NULL CHECK(typeof(owner_instance)='text' AND instr(owner_instance,char(0))=0 AND length(owner_instance) BETWEEN 1 AND 256),
  owner_generation INTEGER NOT NULL CHECK(typeof(owner_generation)='integer' AND owner_generation>=1),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
  consumed_at INTEGER CHECK(consumed_at IS NULL OR (typeof(consumed_at)='integer' AND consumed_at>=created_at)),
  consumed_by TEXT CHECK(consumed_by IS NULL OR (typeof(consumed_by)='text' AND length(consumed_by) BETWEEN 1 AND 256 AND instr(consumed_by,char(0))=0)),
  CHECK((consumed_at IS NULL)=(consumed_by IS NULL))
);
CREATE INDEX engineering_diagnosis_admitted ON engineering_diagnosis_requests(request_id) WHERE state='admitted';
CREATE TRIGGER engineering_diagnosis_no_replace BEFORE INSERT ON engineering_diagnosis_requests
WHEN EXISTS (SELECT 1 FROM engineering_diagnosis_requests WHERE request_id=NEW.request_id OR result_id=NEW.result_id OR source_seq=NEW.source_seq OR intake_id=NEW.intake_id OR receipt_id=NEW.receipt_id)
BEGIN SELECT RAISE(ABORT,'diagnosis_reused'); END;
CREATE TRIGGER engineering_diagnosis_insert BEFORE INSERT ON engineering_diagnosis_requests
WHEN NEW.state NOT IN ('registered','awaiting_decision','diagnostic_closed') OR NEW.revision<>1 OR NEW.created_at<>NEW.updated_at
  OR NEW.intake_id IS NOT NULL OR NEW.receipt_id IS NOT NULL
  OR (NEW.state='awaiting_decision' AND NEW.reason IS NOT 'verify_grant_missing')
  OR (NEW.state='diagnostic_closed' AND NEW.reason IS NOT 'verify_withdrawn')
  OR NEW.owner_instance<>NEW.writer_instance OR NEW.owner_generation<>NEW.writer_generation
  OR NOT EXISTS (SELECT 1 FROM daemon_owner WHERE singleton=1 AND home_id=NEW.owner_home AND instance_id=NEW.owner_instance AND generation=NEW.owner_generation)
  OR NOT EXISTS (SELECT 1 FROM engineering_verification_sources s WHERE s.seq=NEW.source_seq AND s.decision='accepted' AND s.outcome='failed'
    AND s.result_id=NEW.result_id AND s.repository_id=NEW.repository_id AND s.repository=NEW.repository AND s.pr_number=NEW.pr_number
    AND s.head_sha=NEW.head_sha AND s.base_sha=NEW.base_sha AND s.skill_id=NEW.skill_id AND s.summary_reference_json=NEW.summary_reference_json)
  OR EXISTS (SELECT 1 FROM json_each(NEW.expected_failures_json) WHERE type<>'object' OR json_type(value,'$.check_id') IS NOT 'text' OR json_type(value,'$.failure_code') IS NOT 'text')
BEGIN SELECT RAISE(ABORT,'diagnosis_insert_denied'); END;
CREATE TRIGGER engineering_diagnosis_update BEFORE UPDATE ON engineering_diagnosis_requests
WHEN OLD.request_id IS NOT NEW.request_id
  OR OLD.source_seq IS NOT NEW.source_seq
  OR OLD.result_id IS NOT NEW.result_id
  OR OLD.repository_id IS NOT NEW.repository_id
  OR OLD.repository IS NOT NEW.repository
  OR OLD.pr_number IS NOT NEW.pr_number
  OR OLD.head_sha IS NOT NEW.head_sha
  OR OLD.base_sha IS NOT NEW.base_sha
  OR OLD.base_ref IS NOT NEW.base_ref
  OR OLD.branch IS NOT NEW.branch
  OR OLD.skill_id IS NOT NEW.skill_id
  OR OLD.profile_id IS NOT NEW.profile_id
  OR OLD.profile_digest IS NOT NEW.profile_digest
  OR OLD.trusted_source_digest IS NOT NEW.trusted_source_digest
  OR OLD.trusted_repository IS NOT NEW.trusted_repository
  OR OLD.trusted_commit IS NOT NEW.trusted_commit
  OR OLD.root_mission_id IS NOT NEW.root_mission_id
  OR OLD.expected_failures_json IS NOT NEW.expected_failures_json
  OR OLD.allowed_codes_json IS NOT NEW.allowed_codes_json
  OR OLD.summary_reference_json IS NOT NEW.summary_reference_json
  OR OLD.owner_home IS NOT NEW.owner_home
  OR OLD.owner_instance IS NOT NEW.owner_instance
  OR OLD.owner_generation IS NOT NEW.owner_generation
  OR OLD.created_at IS NOT NEW.created_at
  OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at OR NOT EXISTS (SELECT 1 FROM daemon_owner WHERE singleton=1 AND home_id=NEW.owner_home AND instance_id=NEW.writer_instance AND generation=NEW.writer_generation)
  OR (OLD.intake_id IS NOT NULL AND OLD.intake_id IS NOT NEW.intake_id)
  OR (OLD.receipt_id IS NOT NULL AND OLD.receipt_id IS NOT NEW.receipt_id)
  OR (OLD.chain_id IS NOT NEW.chain_id AND (NEW.state<>'admitted' OR OLD.chain_id IS NOT NULL))
  OR NOT ((OLD.state='registered' AND NEW.state IN ('awaiting_decision','admitted','diagnostic_closed'))
    OR (OLD.state='awaiting_decision' AND OLD.reason IN ('verify_grant_missing','verify_grant_invalid','verify_budget_exhausted','verify_chain_busy') AND OLD.intake_id IS NULL AND NEW.state IN ('admitted','diagnostic_closed','awaiting_decision'))
    OR (OLD.state='admitted' AND NEW.state IN ('eligible','diagnostic_closed','awaiting_decision'))
    OR (OLD.state='admitted' AND NEW.state='admitted' AND OLD.receipt_id IS NULL AND NEW.receipt_id IS NOT NULL))
  OR (OLD.intake_id IS NULL AND NEW.intake_id IS NOT NULL AND (NEW.state<>'admitted' OR NOT EXISTS
    (SELECT 1 FROM engineering_local_failure_intakes i JOIN engineering_verification_sources s ON s.intake_id=i.intake_id
     WHERE s.seq=NEW.source_seq AND i.intake_id=NEW.intake_id AND i.state='reserved' AND i.chain_id=NEW.chain_id
     AND i.repository=NEW.repository AND i.pr_number=NEW.pr_number AND i.branch=NEW.branch AND i.base_ref=NEW.base_ref
     AND i.root_mission_id=NEW.root_mission_id AND i.head_sha=NEW.head_sha AND i.base_sha=NEW.base_sha
     AND i.profile_id=NEW.profile_id AND i.profile_digest=NEW.profile_digest AND i.trusted_source_digest=NEW.trusted_source_digest)))
  OR (NEW.receipt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM engineering_host_receipts WHERE receipt_id=NEW.receipt_id AND request_id=NEW.request_id))
BEGIN SELECT RAISE(ABORT,'diagnosis_update_denied'); END;
CREATE TRIGGER engineering_diagnosis_no_delete BEFORE DELETE ON engineering_diagnosis_requests
BEGIN SELECT RAISE(ABORT,'diagnosis_immutable'); END;
CREATE TRIGGER engineering_host_receipt_no_replace BEFORE INSERT ON engineering_host_receipts
WHEN EXISTS (SELECT 1 FROM engineering_host_receipts WHERE receipt_id=NEW.receipt_id OR intake_id=NEW.intake_id OR request_id=NEW.request_id OR invocation_id=NEW.invocation_id)
BEGIN SELECT RAISE(ABORT,'host_receipt_immutable'); END;
CREATE TRIGGER engineering_host_receipt_insert BEFORE INSERT ON engineering_host_receipts
WHEN NEW.consumed_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM daemon_owner WHERE singleton=1 AND home_id=NEW.owner_home AND instance_id=NEW.owner_instance AND generation=NEW.owner_generation)
  OR NOT EXISTS (SELECT 1 FROM engineering_local_failure_intakes i JOIN engineering_diagnosis_requests r ON r.intake_id=i.intake_id
    WHERE i.intake_id=NEW.intake_id AND r.request_id=NEW.request_id AND r.state='admitted' AND r.receipt_id IS NULL
    AND i.state='stopped' AND i.outcome<>'not_started' AND i.outcome=NEW.outcome AND i.proof_ref=NEW.stop_proof_ref
    AND i.proof_digest=NEW.stop_proof_digest AND i.evidence_digest=NEW.evidence_digest AND i.invocation_id=NEW.invocation_id
    AND i.profile_digest=NEW.profile_digest AND i.trusted_source_digest=NEW.trusted_source_digest
    AND json_extract(NEW.receipt_json,'$.started_at') IS i.started_at
    AND json_extract(NEW.receipt_json,'$.version') IS 1 AND json_extract(NEW.receipt_json,'$.stop.proven') IS 1
    AND json_extract(NEW.receipt_json,'$.stop.proof_ref') IS NEW.stop_proof_ref AND json_extract(NEW.receipt_json,'$.stop.proof_digest') IS NEW.stop_proof_digest
    AND json_extract(NEW.receipt_json,'$.evidence_digest') IS NEW.evidence_digest AND json_extract(NEW.receipt_json,'$.outcome') IS NEW.outcome
    AND json_extract(NEW.binding_json,'$.intake_id') IS i.intake_id AND json_extract(NEW.receipt_json,'$.intake_id') IS i.intake_id
    AND json_extract(NEW.binding_json,'$.chain_id') IS i.chain_id AND json_extract(NEW.receipt_json,'$.chain_id') IS i.chain_id
    AND json_extract(NEW.binding_json,'$.root_mission_id') IS i.root_mission_id AND json_extract(NEW.receipt_json,'$.root_mission_id') IS i.root_mission_id
    AND json_extract(NEW.binding_json,'$.grant_id') IS i.grant_id AND json_extract(NEW.receipt_json,'$.grant_id') IS i.grant_id
    AND json_extract(NEW.binding_json,'$.repository') IS i.repository AND json_extract(NEW.receipt_json,'$.repository') IS i.repository
    AND json_extract(NEW.binding_json,'$.pr') IS i.pr_number AND json_extract(NEW.receipt_json,'$.pr') IS i.pr_number
    AND json_extract(NEW.binding_json,'$.branch') IS i.branch AND json_extract(NEW.receipt_json,'$.branch') IS i.branch
    AND json_extract(NEW.binding_json,'$.head') IS i.head_sha AND json_extract(NEW.receipt_json,'$.head') IS i.head_sha
    AND json_extract(NEW.binding_json,'$.tree') IS i.tree_sha AND json_extract(NEW.receipt_json,'$.tree') IS i.tree_sha
    AND json_extract(NEW.binding_json,'$.base_ref') IS i.base_ref AND json_extract(NEW.receipt_json,'$.base_ref') IS i.base_ref
    AND json_extract(NEW.binding_json,'$.base_sha') IS i.base_sha AND json_extract(NEW.receipt_json,'$.base_sha') IS i.base_sha
    AND json_extract(NEW.binding_json,'$.profile_id') IS i.profile_id AND json_extract(NEW.receipt_json,'$.profile_id') IS i.profile_id
    AND json_extract(NEW.binding_json,'$.profile_digest') IS i.profile_digest AND json_extract(NEW.receipt_json,'$.profile_digest') IS i.profile_digest
    AND json_extract(NEW.binding_json,'$.trusted_source_digest') IS i.trusted_source_digest AND json_extract(NEW.receipt_json,'$.trusted_source_digest') IS i.trusted_source_digest
    AND json_extract(NEW.binding_json,'$.invocation_id') IS i.invocation_id AND json_extract(NEW.receipt_json,'$.invocation_id') IS i.invocation_id)
BEGIN SELECT RAISE(ABORT,'host_receipt_binding_invalid'); END;
CREATE TRIGGER engineering_host_receipt_update BEFORE UPDATE ON engineering_host_receipts
WHEN OLD.consumed_at IS NULL AND (OLD.receipt_id IS NOT NEW.receipt_id
  OR OLD.intake_id IS NOT NEW.intake_id
  OR OLD.request_id IS NOT NEW.request_id
  OR OLD.invocation_id IS NOT NEW.invocation_id
  OR OLD.binding_json IS NOT NEW.binding_json
  OR OLD.profile_digest IS NOT NEW.profile_digest
  OR OLD.trusted_source_digest IS NOT NEW.trusted_source_digest
  OR OLD.run_identity_digest IS NOT NEW.run_identity_digest
  OR OLD.receipt_json IS NOT NEW.receipt_json
  OR OLD.receipt_digest IS NOT NEW.receipt_digest
  OR OLD.evidence_digest IS NOT NEW.evidence_digest
  OR OLD.stop_proof_ref IS NOT NEW.stop_proof_ref
  OR OLD.stop_proof_digest IS NOT NEW.stop_proof_digest
  OR OLD.outcome IS NOT NEW.outcome
  OR OLD.owner_home IS NOT NEW.owner_home
  OR OLD.owner_instance IS NOT NEW.owner_instance
  OR OLD.owner_generation IS NOT NEW.owner_generation
  OR OLD.created_at IS NOT NEW.created_at OR NEW.consumed_at IS NULL OR NEW.consumed_by IS NULL OR NOT EXISTS (SELECT 1 FROM engineering_diagnosis_requests WHERE request_id=NEW.request_id AND state='eligible' AND receipt_id=NEW.receipt_id))
BEGIN SELECT RAISE(ABORT,'host_receipt_immutable'); END;
CREATE TRIGGER engineering_host_receipt_consumed BEFORE UPDATE ON engineering_host_receipts
WHEN OLD.consumed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'host_receipt_consumed'); END;
CREATE TRIGGER engineering_host_receipt_no_delete BEFORE DELETE ON engineering_host_receipts
BEGIN SELECT RAISE(ABORT,'host_receipt_immutable'); END;
`;
