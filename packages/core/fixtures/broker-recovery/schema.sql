-- JP-17a dedicated SQLite candidate 0 -> 1; not a registered/qualified deployment.
-- Execute only in a fresh isolated database, inside the caller's transaction.
CREATE TABLE broker_identity (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  broker_id TEXT NOT NULL UNIQUE CHECK(length(trim(broker_id)) BETWEEN 1 AND 256),
  schema_namespace TEXT NOT NULL CHECK(schema_namespace='osstack.resource-broker'),
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  owner_generation INTEGER NOT NULL CHECK(owner_generation BETWEEN 1 AND 9007199254740991),
  owner_ref TEXT NOT NULL CHECK(length(trim(owner_ref)) BETWEEN 1 AND 256)
) STRICT;
CREATE TRIGGER broker_identity_insert_guard BEFORE INSERT ON broker_identity
WHEN EXISTS(SELECT 1 FROM broker_identity)
BEGIN SELECT RAISE(ABORT,'broker identity already initialized'); END;
CREATE TRIGGER broker_identity_update_guard BEFORE UPDATE ON broker_identity
WHEN NEW.singleton IS NOT OLD.singleton OR NEW.broker_id IS NOT OLD.broker_id
  OR NEW.schema_namespace IS NOT OLD.schema_namespace OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.owner_generation<>OLD.owner_generation+1
BEGIN SELECT RAISE(ABORT,'broker identity immutable or generation conflict'); END;
CREATE TRIGGER broker_identity_no_delete BEFORE DELETE ON broker_identity
BEGIN SELECT RAISE(ABORT,'broker identity immutable'); END;

CREATE TABLE broker_leases (
  lease_id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(lease_id)) BETWEEN 1 AND 256),
  broker_id TEXT NOT NULL REFERENCES broker_identity(broker_id),
  home_id TEXT NOT NULL CHECK(length(trim(home_id)) BETWEEN 1 AND 256),
  scope_id TEXT NOT NULL CHECK(length(trim(scope_id)) BETWEEN 1 AND 256),
  tenant_id TEXT NOT NULL CHECK(length(trim(tenant_id)) BETWEEN 1 AND 256),
  resource_key TEXT NOT NULL CHECK(length(trim(resource_key)) BETWEEN 1 AND 1024),
  invocation_ref TEXT NOT NULL CHECK(length(trim(invocation_ref)) BETWEEN 1 AND 512),
  effect_id TEXT CHECK(effect_id IS NULL OR length(trim(effect_id)) BETWEEN 1 AND 256),
  grant_generation INTEGER NOT NULL CHECK(grant_generation BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('held_orphan','resolved_stopped')),
  recovery_revision INTEGER NOT NULL CHECK(recovery_revision BETWEEN 0 AND 9007199254740991),
  UNIQUE(broker_id,lease_id)
) STRICT;
-- One exact exclusive resource key only. Capacity/fairness/path-overlap scheduling is not implemented.
CREATE UNIQUE INDEX broker_one_held_resource ON broker_leases(broker_id,resource_key) WHERE state='held_orphan';
CREATE TRIGGER broker_lease_insert_guard BEFORE INSERT ON broker_leases
WHEN EXISTS(SELECT 1 FROM broker_leases WHERE lease_id=NEW.lease_id)
  OR NEW.state<>'held_orphan' OR NEW.recovery_revision<>0
  OR NOT EXISTS(SELECT 1 FROM broker_identity WHERE broker_id=NEW.broker_id AND owner_generation>=NEW.grant_generation)
BEGIN SELECT RAISE(ABORT,'broker lease identity or initial state conflict'); END;
CREATE TRIGGER broker_lease_no_delete BEFORE DELETE ON broker_leases
BEGIN SELECT RAISE(ABORT,'broker lease history immutable'); END;

CREATE TABLE broker_recovery_decisions (
  principal_ref TEXT NOT NULL CHECK(length(trim(principal_ref)) BETWEEN 1 AND 256),
  request_id TEXT NOT NULL CHECK(length(trim(request_id)) BETWEEN 1 AND 256),
  input_digest TEXT NOT NULL CHECK(length(input_digest)=64 AND input_digest NOT GLOB '*[^0-9a-f]*'),
  broker_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  prior_revision INTEGER NOT NULL CHECK(prior_revision BETWEEN 0 AND 9007199254740990),
  owner_generation INTEGER NOT NULL CHECK(owner_generation BETWEEN 1 AND 9007199254740991),
  decision TEXT NOT NULL CHECK(decision IN ('preserve_unknown','proven_stopped')),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB))<=1048576),
  PRIMARY KEY(principal_ref,request_id),
  UNIQUE(broker_id,lease_id,prior_revision),
  FOREIGN KEY(broker_id,lease_id) REFERENCES broker_leases(broker_id,lease_id),
  CHECK((json_type(receipt_json)='object'
    AND json_extract(receipt_json,'$.kind')='recovery_receipt'
    AND json_type(receipt_json,'$.schema_version')='integer' AND json_extract(receipt_json,'$.schema_version')=1
    AND json_extract(receipt_json,'$.target')='broker'
    AND json_extract(receipt_json,'$.prior_phase')='broker_unknown'
    AND json_extract(receipt_json,'$.prior_resolution') IN ('none','abandoned_unknown')
    AND json_type(receipt_json,'$.subject')='object'
    AND json_extract(receipt_json,'$.subject.kind')='broker_lease'
    AND json_extract(receipt_json,'$.subject.broker_id')=broker_id
    AND json_extract(receipt_json,'$.subject.lease_id')=lease_id
    AND json_extract(receipt_json,'$.subject.home_id')=json_extract(receipt_json,'$.target_home_id')
    AND json_type(receipt_json,'$.if_revision')='integer' AND json_extract(receipt_json,'$.if_revision')=prior_revision
    AND json_type(receipt_json,'$.owner_generation')='integer' AND json_extract(receipt_json,'$.owner_generation')=owner_generation
    AND json_type(receipt_json,'$.actual_target_schema')='integer' AND json_extract(receipt_json,'$.actual_target_schema')=1
    AND json_extract(receipt_json,'$.decision')=decision
    AND json_extract(receipt_json,'$.request_id')=request_id
    AND json_extract(receipt_json,'$.operator_ref')=principal_ref
    AND json_type(receipt_json,'$.proof_refs')='array' AND json_type(receipt_json,'$.proofs')='array') IS 1),
  CHECK(((decision='preserve_unknown' AND json_array_length(receipt_json,'$.proofs')=0 AND json_array_length(receipt_json,'$.proof_refs')=0)
    OR (decision='proven_stopped'
      AND json_array_length(receipt_json,'$.proofs')=1 AND json_array_length(receipt_json,'$.proof_refs')=1
      AND json_extract(receipt_json,'$.proofs[0].type')='invocation_contained'
      AND length(trim(json_extract(receipt_json,'$.proofs[0].record_ref')))>0
      AND json_extract(receipt_json,'$.proofs[0].record_ref')=json_extract(receipt_json,'$.proof_refs[0]')
      AND json_extract(receipt_json,'$.proofs[0].subject_digest')=json_extract(receipt_json,'$.subject_digest')
      AND length(json_extract(receipt_json,'$.proofs[0].evidence_digest'))=64
      AND json_extract(receipt_json,'$.proofs[0].evidence_digest') NOT GLOB '*[^0-9a-f]*'
      AND length(trim(json_extract(receipt_json,'$.proofs[0].producer_ref')))>0
      AND json_extract(receipt_json,'$.proofs[0].broker_identity.broker_id')=broker_id
      AND json_extract(receipt_json,'$.proofs[0].broker_identity.lease_id')=lease_id
      AND json_type(receipt_json,'$.proofs[0].broker_identity.schema')='integer'
      AND json_extract(receipt_json,'$.proofs[0].broker_identity.schema')=1
      AND json_type(receipt_json,'$.proofs[0].broker_identity.owner_generation')='integer'
      AND json_extract(receipt_json,'$.proofs[0].broker_identity.owner_generation')=owner_generation)) IS 1)
) STRICT;
CREATE TRIGGER broker_recovery_insert_guard BEFORE INSERT ON broker_recovery_decisions
WHEN EXISTS(SELECT 1 FROM broker_recovery_decisions WHERE principal_ref=NEW.principal_ref AND request_id=NEW.request_id)
  OR NOT EXISTS(SELECT 1 FROM broker_identity WHERE broker_id=NEW.broker_id AND owner_generation=NEW.owner_generation)
  OR NOT EXISTS(SELECT 1 FROM broker_leases WHERE broker_id=NEW.broker_id AND lease_id=NEW.lease_id
    AND state='held_orphan' AND recovery_revision=NEW.prior_revision
    AND home_id=json_extract(NEW.receipt_json,'$.subject.home_id')
    AND scope_id=json_extract(NEW.receipt_json,'$.scope_id') AND tenant_id=json_extract(NEW.receipt_json,'$.tenant_id'))
BEGIN SELECT RAISE(ABORT,'broker recovery request, identity, owner or revision conflict'); END;
CREATE TRIGGER broker_recovery_no_update BEFORE UPDATE ON broker_recovery_decisions
BEGIN SELECT RAISE(ABORT,'broker recovery history immutable'); END;
CREATE TRIGGER broker_recovery_no_delete BEFORE DELETE ON broker_recovery_decisions
BEGIN SELECT RAISE(ABORT,'broker recovery history immutable'); END;
CREATE TRIGGER broker_lease_update_guard BEFORE UPDATE ON broker_leases
WHEN NEW.lease_id IS NOT OLD.lease_id OR NEW.broker_id IS NOT OLD.broker_id
  OR NEW.home_id IS NOT OLD.home_id OR NEW.scope_id IS NOT OLD.scope_id OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.resource_key IS NOT OLD.resource_key OR NEW.invocation_ref IS NOT OLD.invocation_ref
  OR NEW.effect_id IS NOT OLD.effect_id OR NEW.grant_generation IS NOT OLD.grant_generation
  OR OLD.state<>'held_orphan' OR NEW.recovery_revision<>OLD.recovery_revision+1
  OR NOT EXISTS(SELECT 1 FROM broker_recovery_decisions d JOIN broker_identity b ON b.broker_id=d.broker_id
    WHERE d.broker_id=OLD.broker_id AND d.lease_id=OLD.lease_id AND d.prior_revision=OLD.recovery_revision
    AND d.owner_generation=b.owner_generation
    AND NEW.state=CASE d.decision WHEN 'preserve_unknown' THEN 'held_orphan' ELSE 'resolved_stopped' END)
BEGIN SELECT RAISE(ABORT,'broker projection requires an immutable current decision'); END;
CREATE TRIGGER broker_recovery_project AFTER INSERT ON broker_recovery_decisions
BEGIN
  UPDATE broker_leases SET recovery_revision=NEW.prior_revision+1,
    state=CASE NEW.decision WHEN 'preserve_unknown' THEN 'held_orphan' ELSE 'resolved_stopped' END
    WHERE broker_id=NEW.broker_id AND lease_id=NEW.lease_id AND recovery_revision=NEW.prior_revision;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'broker projection CAS failed') END;
END;
PRAGMA user_version=1;
