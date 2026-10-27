-- Candidate 47 -> 48. Specification fixture only; not a registered migration.
CREATE TABLE operator_recovery_decisions (
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 256),
  input_digest TEXT NOT NULL CHECK(length(input_digest)=64 AND input_digest NOT GLOB '*[^0-9a-f]*'),
  subject_digest TEXT NOT NULL CHECK(length(subject_digest)=64 AND subject_digest NOT GLOB '*[^0-9a-f]*'),
  subject_json TEXT NOT NULL CHECK(json_valid(subject_json) AND length(CAST(subject_json AS BLOB))<=8192),
  prior_revision INTEGER NOT NULL CHECK(prior_revision BETWEEN 0 AND 9007199254740991),
  owner_generation INTEGER NOT NULL CHECK(owner_generation BETWEEN 1 AND 9007199254740991),
  decision TEXT NOT NULL CHECK(decision IN ('preserve_unknown','proven_not_started','proven_stopped','applied_observed')),
  post_state TEXT NOT NULL CHECK(post_state IN ('unknown','cancelled_before_dispatch','resolved_stopped','applied_observed')),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB))<=1048576),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(principal_ref,request_id),
  UNIQUE(subject_digest,prior_revision),
  CHECK((decision='preserve_unknown' AND post_state='unknown')
    OR (decision='proven_not_started' AND post_state='cancelled_before_dispatch')
    OR (decision='proven_stopped' AND post_state='resolved_stopped')
    OR (decision='applied_observed' AND post_state='applied_observed')),
  CHECK((json_type(receipt_json)='object' AND json_type(subject_json)='object'
    AND json_type(receipt_json,'$.kind')='text'
    AND json_type(receipt_json,'$.schema_version')='integer'
    AND json_type(receipt_json,'$.target')='text'
    AND json_type(receipt_json,'$.subject')='object'
    AND json_type(receipt_json,'$.subject_digest')='text'
    AND json_type(receipt_json,'$.if_revision')='integer'
    AND json_type(receipt_json,'$.owner_generation')='integer'
    AND json_type(receipt_json,'$.decision')='text'
    AND json_type(receipt_json,'$.request_id')='text'
    AND json_type(receipt_json,'$.operator_ref')='text'
    AND json_type(receipt_json,'$.observed_at_ms')='integer'
    AND json_type(subject_json,'$.kind')='text'
    AND json_extract(receipt_json,'$.kind')='recovery_receipt'
    AND json_extract(receipt_json,'$.schema_version')=1
    AND json_extract(receipt_json,'$.target')='home'
    AND json_extract(subject_json,'$.kind') IN ('effect','attention_action')
    AND json_type(subject_json,'$.home_id')='text'
    AND json_type(receipt_json,'$.target_home_id')='text'
    AND json_extract(receipt_json,'$.target_home_id')=json_extract(subject_json,'$.home_id')
    AND json_extract(receipt_json,'$.prior_phase') IN ('reserved','dispatch_committed','legacy_unknown')
    AND json_extract(receipt_json,'$.prior_resolution') IN ('none','abandoned_unknown')
    AND (decision='preserve_unknown' OR (decision='proven_not_started' AND json_extract(receipt_json,'$.prior_phase')='reserved' AND json_extract(receipt_json,'$.prior_resolution')='none') OR (decision IN ('proven_stopped','applied_observed') AND json_extract(receipt_json,'$.prior_phase')='dispatch_committed'))
    AND (json_extract(receipt_json,'$.prior_phase')<>'legacy_unknown' OR (json_extract(subject_json,'$.kind')='attention_action' AND json_type(receipt_json,'$.binding_generation')='null' AND json_type(receipt_json,'$.support_profile_digest')='null'))
    AND json(subject_json)=json_extract(receipt_json,'$.subject')
    AND json_extract(receipt_json,'$.subject_digest')=subject_digest
    AND json_extract(receipt_json,'$.if_revision')=prior_revision
    AND json_extract(receipt_json,'$.owner_generation')=owner_generation
    AND json_extract(receipt_json,'$.decision')=decision
    AND json_extract(receipt_json,'$.request_id')=request_id
    AND json_extract(receipt_json,'$.operator_ref')=principal_ref
    AND json_extract(receipt_json,'$.observed_at_ms')=created_at_ms) IS 1)
) STRICT;
CREATE TRIGGER operator_recovery_insert_guard BEFORE INSERT ON operator_recovery_decisions
WHEN EXISTS(SELECT 1 FROM operator_recovery_decisions WHERE principal_ref=NEW.principal_ref AND request_id=NEW.request_id)
  OR NEW.prior_revision<>COALESCE((SELECT MAX(prior_revision)+1 FROM operator_recovery_decisions WHERE subject_digest=NEW.subject_digest),0)
  OR EXISTS(SELECT 1 FROM operator_recovery_decisions WHERE subject_digest=NEW.subject_digest AND decision<>'preserve_unknown')
BEGIN SELECT RAISE(ABORT,'operator recovery history immutable or revision conflict'); END;
CREATE TRIGGER operator_recovery_no_update BEFORE UPDATE ON operator_recovery_decisions
  BEGIN SELECT RAISE(ABORT,'operator recovery history immutable'); END;
CREATE TRIGGER operator_recovery_no_delete BEFORE DELETE ON operator_recovery_decisions
  BEGIN SELECT RAISE(ABORT,'operator recovery history immutable'); END;
CREATE TABLE operator_upgrade_journal (
  operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 512),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
  owner_generation INTEGER NOT NULL CHECK(owner_generation BETWEEN 1 AND 9007199254740991),
  schema_spec_digest TEXT NOT NULL CHECK(length(schema_spec_digest)=64 AND schema_spec_digest NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('fenced','verified','installed_inactive','failed')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='object' AND length(CAST(evidence_json AS BLOB))<=1048576),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(operation_id,revision)
) STRICT;
CREATE TRIGGER operator_upgrade_insert_guard BEFORE INSERT ON operator_upgrade_journal
WHEN NOT ((NEW.revision=0 AND NEW.state='fenced' AND NOT EXISTS(SELECT 1 FROM operator_upgrade_journal WHERE operation_id=NEW.operation_id))
  OR (NEW.revision=COALESCE((SELECT MAX(revision)+1 FROM operator_upgrade_journal WHERE operation_id=NEW.operation_id),-1)
    AND EXISTS(SELECT 1 FROM operator_upgrade_journal WHERE operation_id=NEW.operation_id AND revision=NEW.revision-1
      AND owner_generation=NEW.owner_generation AND schema_spec_digest=NEW.schema_spec_digest
      AND ((state='fenced' AND NEW.state IN ('verified','failed')) OR (state='verified' AND NEW.state IN ('installed_inactive','failed'))))))
BEGIN SELECT RAISE(ABORT,'upgrade transition conflict'); END;
CREATE TRIGGER operator_upgrade_no_update BEFORE UPDATE ON operator_upgrade_journal
  BEGIN SELECT RAISE(ABORT,'upgrade history immutable'); END;
CREATE TRIGGER operator_upgrade_no_delete BEFORE DELETE ON operator_upgrade_journal
  BEGIN SELECT RAISE(ABORT,'upgrade history immutable'); END;
