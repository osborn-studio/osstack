/** Unregistered, additive diagnostic journal. This DDL does not enable intake, authorize a
 * process, change review reservations, or integrate the shared grant budget. */
export const ENGINEERING_LOCAL_FAILURE_INTAKE_DDL = `
CREATE TABLE engineering_local_failure_intakes (
  intake_id TEXT NOT NULL PRIMARY KEY CHECK(intake_id GLOB 'lf_*' AND length(intake_id) BETWEEN 4 AND 128),
  chain_id TEXT NOT NULL REFERENCES engineering_revision_chains(chain_id),
  chain_revision INTEGER NOT NULL CHECK(typeof(chain_revision)='integer' AND chain_revision>0),
  root_mission_id TEXT NOT NULL REFERENCES engineering_contained_missions(mission_id),
  repository TEXT NOT NULL CHECK(length(repository) BETWEEN 1 AND 200),
  pr_number INTEGER NOT NULL CHECK(typeof(pr_number)='integer' AND pr_number>0),
  branch TEXT NOT NULL CHECK(length(branch) BETWEEN 1 AND 255),
  head_sha TEXT NOT NULL CHECK(length(head_sha)=40 AND head_sha NOT GLOB '*[^0-9a-f]*'),
  tree_sha TEXT NOT NULL CHECK(length(tree_sha)=40 AND tree_sha NOT GLOB '*[^0-9a-f]*'),
  base_ref TEXT NOT NULL CHECK(length(base_ref) BETWEEN 1 AND 255),
  base_sha TEXT NOT NULL CHECK(length(base_sha)=40 AND base_sha NOT GLOB '*[^0-9a-f]*'),
  profile_id TEXT NOT NULL CHECK(length(profile_id) BETWEEN 1 AND 256),
  profile_digest TEXT NOT NULL CHECK(length(profile_digest)=64 AND profile_digest NOT GLOB '*[^0-9a-f]*'),
  trusted_source_digest TEXT NOT NULL CHECK(length(trusted_source_digest)=64 AND trusted_source_digest NOT GLOB '*[^0-9a-f]*'),
  grant_id TEXT NOT NULL CHECK(length(grant_id) BETWEEN 1 AND 128),
  grant_json TEXT NOT NULL CHECK(json_valid(grant_json) AND length(grant_json)<=4096),
  grant_digest TEXT NOT NULL CHECK(length(grant_digest)=64 AND grant_digest NOT GLOB '*[^0-9a-f]*'),
  ci_hint_json TEXT NOT NULL CHECK(json_valid(ci_hint_json) AND json_type(ci_hint_json)='object' AND length(ci_hint_json)<=4096),
  invocation_id TEXT NOT NULL UNIQUE CHECK(length(invocation_id) BETWEEN 1 AND 256),
  journal_ref TEXT NOT NULL CHECK(length(journal_ref) BETWEEN 1 AND 1024),
  owner_home TEXT NOT NULL, owner_instance TEXT NOT NULL,
  owner_generation INTEGER NOT NULL CHECK(typeof(owner_generation)='integer' AND owner_generation>0),
  writer_instance TEXT NOT NULL, writer_generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','running','stop_unknown','stopped')),
  reason TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
  container_cap_seconds INTEGER NOT NULL CHECK(typeof(container_cap_seconds)='integer' AND container_cap_seconds BETWEEN 1 AND 9007199254740991),
  container_used_seconds INTEGER CHECK(container_used_seconds IS NULL OR
    (typeof(container_used_seconds)='integer' AND container_used_seconds BETWEEN 0 AND container_cap_seconds)),
  stop_obligation INTEGER NOT NULL CHECK(stop_obligation IN (0,1)),
  started_at INTEGER CHECK(started_at IS NULL OR (typeof(started_at)='integer' AND started_at>=created_at)),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('passed','reproducible_failure','infrastructure_error','cancelled','not_started')),
  receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND length(receipt_json)<=32768)),
  receipt_digest TEXT CHECK(receipt_digest IS NULL OR (length(receipt_digest)=64 AND receipt_digest NOT GLOB '*[^0-9a-f]*')),
  evidence_digest TEXT CHECK(evidence_digest IS NULL OR (length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^0-9a-f]*')),
  proof_ref TEXT CHECK(proof_ref IS NULL OR length(proof_ref) BETWEEN 1 AND 1024),
  proof_digest TEXT CHECK(proof_digest IS NULL OR (length(proof_digest)=64 AND proof_digest NOT GLOB '*[^0-9a-f]*')),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=created_at),
  CHECK((state='stopped' AND stop_obligation=0 AND container_used_seconds IS NOT NULL
      AND outcome IS NOT NULL AND proof_ref IS NOT NULL AND proof_digest IS NOT NULL
      AND ((outcome='not_started' AND container_used_seconds=0 AND receipt_json IS NULL AND receipt_digest IS NULL AND evidence_digest IS NULL)
        OR (outcome<>'not_started' AND receipt_json IS NOT NULL AND receipt_digest IS NOT NULL AND evidence_digest IS NOT NULL)))
    OR (state<>'stopped' AND stop_obligation=1 AND container_used_seconds IS NULL AND outcome IS NULL
      AND receipt_json IS NULL AND receipt_digest IS NULL AND evidence_digest IS NULL AND proof_ref IS NULL AND proof_digest IS NULL)),
  CHECK(state<>'stop_unknown' OR reason IS NOT NULL),
  CHECK(state<>'reserved' OR started_at IS NULL),
  CHECK(state<>'running' OR started_at IS NOT NULL),
  CHECK(state<>'stopped' OR ((outcome='not_started')=(started_at IS NULL)))
);
CREATE UNIQUE INDEX engineering_local_failure_head_profile ON engineering_local_failure_intakes(chain_id,head_sha,profile_digest);
CREATE UNIQUE INDEX engineering_local_failure_active_chain ON engineering_local_failure_intakes(chain_id) WHERE state<>'stopped';

-- Also guard REPLACE: SQLite can otherwise delete a conflicting immutable row without DELETE triggers.
CREATE TRIGGER engineering_local_failure_no_replace BEFORE INSERT ON engineering_local_failure_intakes
WHEN EXISTS (SELECT 1 FROM engineering_local_failure_intakes i WHERE i.intake_id=NEW.intake_id
  OR i.invocation_id=NEW.invocation_id OR (i.chain_id=NEW.chain_id AND
    (i.state<>'stopped' OR (i.head_sha=NEW.head_sha AND i.profile_digest=NEW.profile_digest))))
BEGIN SELECT RAISE(ABORT,'intake_reused'); END;
CREATE TRIGGER engineering_local_failure_insert BEFORE INSERT ON engineering_local_failure_intakes
WHEN NEW.state<>'reserved' OR NEW.revision<>1 OR NEW.reason IS NOT NULL OR NEW.created_at<>NEW.updated_at
  OR NEW.started_at IS NOT NULL OR NEW.owner_instance IS NOT NEW.writer_instance OR NEW.owner_generation IS NOT NEW.writer_generation
  OR NOT EXISTS (SELECT 1 FROM daemon_owner d WHERE d.singleton=1 AND d.home_id=NEW.owner_home
    AND d.instance_id=NEW.owner_instance AND d.generation=NEW.owner_generation)
BEGIN SELECT RAISE(ABORT,'intake_insert_denied'); END;
CREATE TRIGGER engineering_local_failure_binding BEFORE INSERT ON engineering_local_failure_intakes
WHEN NOT EXISTS (SELECT 1 FROM engineering_revision_chains c WHERE c.chain_id=NEW.chain_id
  AND c.mode='live' AND c.state='awaiting_review' AND c.revision=NEW.chain_revision
  AND c.root_mission_id=NEW.root_mission_id AND c.repository=NEW.repository AND c.pr_number=NEW.pr_number
  AND c.branch=NEW.branch AND c.base_ref=NEW.base_ref AND c.published_head=NEW.head_sha AND c.published_base=NEW.base_sha
  AND c.grant_json=NEW.grant_json AND c.rounds_used<json_extract(c.grant_json,'$.rounds')
  AND (c.review_deadline IS NULL OR NEW.created_at<c.review_deadline))
  OR EXISTS (SELECT 1 FROM engineering_revision_reservations r WHERE r.chain_id=NEW.chain_id AND r.state IN ('reserved','dispatched'))
  OR EXISTS (SELECT 1 FROM engineering_revision_chains c JOIN engineering_contained_missions m ON m.mission_id=c.current_mission_id
    WHERE c.chain_id=NEW.chain_id AND NOT (m.state IN ('pr_opened','cancelled','abandoned','failed') AND m.stop_obligation=0))
BEGIN SELECT RAISE(ABORT,'intake_binding_denied'); END;
-- Structural opt-in only. Signature, principal/session/scope and trusted profile verification belong to admission.
CREATE TRIGGER engineering_local_failure_opt_in BEFORE INSERT ON engineering_local_failure_intakes
WHEN COALESCE(json_type(NEW.grant_json,'$.version')='integer' AND json_extract(NEW.grant_json,'$.version')=2
  AND json_extract(NEW.grant_json,'$.grant_id')=NEW.grant_id
  AND json_type(NEW.grant_json,'$.local_failure.enabled')='true'
  AND json_extract(NEW.grant_json,'$.local_failure.profile_id')=NEW.profile_id
  AND json_extract(NEW.grant_json,'$.local_failure.profile_digest')=NEW.profile_digest
  AND json_extract(NEW.grant_json,'$.local_failure.trusted_source.artifact_digest')=NEW.trusted_source_digest
  AND json_type(NEW.grant_json,'$.local_failure.max_diagnostics_per_head')='integer'
  AND json_extract(NEW.grant_json,'$.local_failure.max_diagnostics_per_head')=1
  AND json_type(NEW.grant_json,'$.local_failure.diagnostic_timeout_seconds')='integer'
  AND NEW.container_cap_seconds<=json_extract(NEW.grant_json,'$.local_failure.diagnostic_timeout_seconds')
  AND json_type(NEW.grant_json,'$.budget.max_container_seconds')='integer'
  AND NEW.container_cap_seconds + COALESCE((SELECT SUM(CASE WHEN state='stopped' THEN container_used_seconds ELSE container_cap_seconds END)
    FROM engineering_local_failure_intakes WHERE chain_id=NEW.chain_id),0)<=json_extract(NEW.grant_json,'$.budget.max_container_seconds')
  AND json_type(NEW.grant_json,'$.expires_at')='integer' AND NEW.created_at<json_extract(NEW.grant_json,'$.expires_at'),0)=0
BEGIN SELECT RAISE(ABORT,'intake_opt_in_denied'); END;
CREATE TRIGGER engineering_local_failure_fixed BEFORE UPDATE ON engineering_local_failure_intakes
WHEN OLD.state='stopped' OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR OLD.intake_id IS NOT NEW.intake_id OR OLD.chain_id IS NOT NEW.chain_id OR OLD.chain_revision IS NOT NEW.chain_revision
  OR OLD.root_mission_id IS NOT NEW.root_mission_id OR OLD.repository IS NOT NEW.repository OR OLD.pr_number IS NOT NEW.pr_number
  OR OLD.branch IS NOT NEW.branch OR OLD.head_sha IS NOT NEW.head_sha OR OLD.tree_sha IS NOT NEW.tree_sha
  OR OLD.base_ref IS NOT NEW.base_ref OR OLD.base_sha IS NOT NEW.base_sha OR OLD.profile_id IS NOT NEW.profile_id
  OR OLD.profile_digest IS NOT NEW.profile_digest OR OLD.trusted_source_digest IS NOT NEW.trusted_source_digest
  OR OLD.grant_id IS NOT NEW.grant_id OR OLD.grant_json IS NOT NEW.grant_json OR OLD.grant_digest IS NOT NEW.grant_digest
  OR OLD.ci_hint_json IS NOT NEW.ci_hint_json OR OLD.invocation_id IS NOT NEW.invocation_id OR OLD.journal_ref IS NOT NEW.journal_ref
  OR OLD.owner_home IS NOT NEW.owner_home OR OLD.owner_instance IS NOT NEW.owner_instance OR OLD.owner_generation IS NOT NEW.owner_generation
  OR OLD.container_cap_seconds IS NOT NEW.container_cap_seconds OR OLD.created_at IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT,'intake_immutable'); END;
CREATE TRIGGER engineering_local_failure_flow BEFORE UPDATE ON engineering_local_failure_intakes
WHEN NOT ((OLD.state='reserved' AND NEW.state IN ('running','stop_unknown','stopped'))
  OR (OLD.state='running' AND NEW.state IN ('stop_unknown','stopped')) OR (OLD.state='stop_unknown' AND NEW.state='stopped'))
  OR (NOT (OLD.state='reserved' AND NEW.state='running') AND OLD.started_at IS NOT NEW.started_at)
  OR (NEW.state='running' AND NEW.started_at IS NOT NEW.updated_at)
  OR NOT EXISTS (SELECT 1 FROM daemon_owner d WHERE d.singleton=1 AND d.home_id=NEW.owner_home
    AND d.instance_id=NEW.writer_instance AND d.generation=NEW.writer_generation)
BEGIN SELECT RAISE(ABORT,'intake_state_denied'); END;
CREATE TRIGGER engineering_local_failure_start BEFORE UPDATE ON engineering_local_failure_intakes
WHEN NEW.state='running' AND (NEW.writer_instance IS NOT OLD.owner_instance OR NEW.writer_generation IS NOT OLD.owner_generation
  OR NOT EXISTS (SELECT 1 FROM engineering_revision_chains c WHERE c.chain_id=OLD.chain_id AND c.revision=OLD.chain_revision
    AND c.state='awaiting_review' AND c.grant_json=OLD.grant_json AND c.published_head=OLD.head_sha AND c.published_base=OLD.base_sha
    AND c.rounds_used<json_extract(c.grant_json,'$.rounds') AND NEW.updated_at<json_extract(c.grant_json,'$.expires_at')
    AND (c.review_deadline IS NULL OR NEW.updated_at<c.review_deadline))
  OR EXISTS (SELECT 1 FROM engineering_revision_reservations r WHERE r.chain_id=OLD.chain_id AND r.state IN ('reserved','dispatched')))
BEGIN SELECT RAISE(ABORT,'intake_start_denied'); END;
CREATE TRIGGER engineering_local_failure_no_delete BEFORE DELETE ON engineering_local_failure_intakes
BEGIN SELECT RAISE(ABORT,'intake_immutable'); END;
`;
