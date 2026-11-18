const unsettled = "NOT (m.state IN ('pr_opened','cancelled','abandoned','failed') AND m.stop_obligation=0)";
const activeChild = (root: string) => `EXISTS (
  SELECT 1 FROM engineering_local_failure_dispatches d
  JOIN engineering_contained_missions m ON m.mission_id=d.child_mission_id
  WHERE d.root_mission_id=${root} AND ${unsettled})`;

export const ENGINEERING_LOCAL_FAILURE_DISPATCH_DDL = `
CREATE TABLE engineering_local_failure_dispatches(
  dispatch_id TEXT PRIMARY KEY NOT NULL CHECK(dispatch_id GLOB 'vld_*' AND length(dispatch_id)=40
    AND substr(dispatch_id,5) NOT GLOB '*[^0-9a-f-]*' AND instr(dispatch_id,char(0))=0
    AND dispatch_id GLOB 'vld_????????-????-????-????-????????????' AND length(replace(dispatch_id,'-',''))=36),
  request_id TEXT NOT NULL UNIQUE REFERENCES engineering_diagnosis_requests(request_id),
  receipt_id TEXT NOT NULL UNIQUE REFERENCES engineering_host_receipts(receipt_id),
  receipt_digest TEXT NOT NULL,
  root_mission_id TEXT NOT NULL UNIQUE REFERENCES engineering_contained_missions(mission_id),
  chain_id TEXT NOT NULL REFERENCES engineering_revision_chains(chain_id),
  child_mission_id TEXT NOT NULL UNIQUE REFERENCES engineering_contained_missions(mission_id),
  grant_id TEXT NOT NULL, grant_digest TEXT NOT NULL,
  check_id TEXT NOT NULL, failure_code TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE CHECK(idempotency_key='local_failure:'||root_mission_id),
  owner_home TEXT NOT NULL, owner_instance TEXT NOT NULL, owner_generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0)
) WITHOUT ROWID;
CREATE INDEX engineering_local_failure_dispatch_chain ON engineering_local_failure_dispatches(chain_id);
CREATE TRIGGER engineering_local_failure_dispatch_no_update BEFORE UPDATE ON engineering_local_failure_dispatches
BEGIN SELECT RAISE(ABORT,'dispatch_immutable'); END;
CREATE TRIGGER engineering_local_failure_dispatch_no_delete BEFORE DELETE ON engineering_local_failure_dispatches
BEGIN SELECT RAISE(ABORT,'dispatch_immutable'); END;
CREATE TRIGGER engineering_local_failure_dispatch_no_replace BEFORE INSERT ON engineering_local_failure_dispatches
WHEN EXISTS (SELECT 1 FROM engineering_local_failure_dispatches WHERE dispatch_id=NEW.dispatch_id
  OR request_id=NEW.request_id OR receipt_id=NEW.receipt_id OR root_mission_id=NEW.root_mission_id
  OR child_mission_id=NEW.child_mission_id OR idempotency_key=NEW.idempotency_key)
BEGIN SELECT RAISE(ABORT,'dispatch_immutable'); END;
CREATE TRIGGER engineering_local_failure_dispatch_binding BEFORE INSERT ON engineering_local_failure_dispatches
WHEN NOT EXISTS (SELECT 1 FROM daemon_owner WHERE singleton=1 AND home_id=NEW.owner_home
  AND instance_id=NEW.owner_instance AND generation=NEW.owner_generation)
  OR NOT EXISTS (SELECT 1 FROM engineering_diagnosis_requests r
    JOIN engineering_host_receipts h ON h.receipt_id=r.receipt_id AND h.request_id=r.request_id
    JOIN engineering_local_failure_intakes i ON i.intake_id=h.intake_id
    WHERE r.state='eligible' AND r.request_id=NEW.request_id AND r.root_mission_id=NEW.root_mission_id
      AND r.chain_id=NEW.chain_id AND h.receipt_id=NEW.receipt_id AND h.receipt_digest=NEW.receipt_digest
      AND h.consumed_by=NEW.dispatch_id AND i.grant_id=NEW.grant_id AND i.grant_digest=NEW.grant_digest
      AND EXISTS (SELECT 1 FROM json_each(r.expected_failures_json) WHERE json_extract(value,'$.check_id')=NEW.check_id
        AND json_extract(value,'$.failure_code')=NEW.failure_code))
  OR NOT EXISTS (SELECT 1 FROM engineering_mission_lineage l JOIN engineering_contained_missions m ON m.mission_id=l.mission_id
    WHERE m.mission_id=NEW.child_mission_id AND l.parent_mission_id=NEW.root_mission_id AND l.source_kind='local_failure'
      AND l.source_id=NEW.request_id AND l.idempotency_key=NEW.idempotency_key
      AND json_type(m.spec_json,'$.ci_repair') IS NULL AND json_extract(m.spec_json,'$.publication.preauthorized') IS 0
      AND json_extract(m.spec_json,'$.local_failure_repair.request_id')=NEW.request_id
      AND json_extract(m.spec_json,'$.local_failure_repair.root')=NEW.root_mission_id
      AND json_extract(m.spec_json,'$.local_failure_repair.receipt_id')=NEW.receipt_id
      AND json_extract(m.spec_json,'$.local_failure_repair.check_id')=NEW.check_id
      AND json_extract(m.spec_json,'$.local_failure_repair.failure_code')=NEW.failure_code)
  OR NOT EXISTS (SELECT 1 FROM engineering_revision_chains c, json_each(c.spent_json,'$.allocations') a
    WHERE c.chain_id=NEW.chain_id AND c.root_mission_id=NEW.root_mission_id AND c.rounds_used>0 AND a.key=NEW.child_mission_id)
BEGIN SELECT RAISE(ABORT,'dispatch_binding_invalid'); END;
CREATE TRIGGER engineering_local_failure_dispatch_review BEFORE INSERT ON engineering_revision_reservations
WHEN ${activeChild("(SELECT root_mission_id FROM engineering_revision_chains WHERE chain_id=NEW.chain_id)")}
BEGIN SELECT RAISE(ABORT,'chain_busy'); END;
CREATE TRIGGER engineering_local_failure_dispatch_actions BEFORE INSERT ON engineering_contained_missions
WHEN ${activeChild("json_extract(NEW.spec_json,'$.ci_repair.root')")}
BEGIN SELECT RAISE(ABORT,'verify_chain_busy'); END;
CREATE TRIGGER engineering_local_failure_dispatch_intake BEFORE INSERT ON engineering_local_failure_intakes
WHEN ${activeChild("NEW.root_mission_id")}
BEGIN SELECT RAISE(ABORT,'verify_chain_busy'); END;
CREATE TRIGGER engineering_local_failure_dispatch_exclusion BEFORE INSERT ON engineering_local_failure_dispatches
WHEN EXISTS (SELECT 1 FROM engineering_revision_chains c JOIN engineering_revision_reservations r ON r.chain_id=c.chain_id
  WHERE c.root_mission_id=NEW.root_mission_id AND r.state IN ('reserved','dispatched'))
  OR EXISTS (SELECT 1 FROM engineering_revision_chains c JOIN engineering_contained_missions m ON m.mission_id=c.current_mission_id
    WHERE c.root_mission_id=NEW.root_mission_id AND ${unsettled})
  OR EXISTS (SELECT 1 FROM engineering_contained_missions m WHERE json_extract(spec_json,'$.ci_repair.root')=NEW.root_mission_id AND ${unsettled})
  OR EXISTS (SELECT 1 FROM engineering_local_failure_intakes WHERE root_mission_id=NEW.root_mission_id AND state<>'stopped')
BEGIN SELECT RAISE(ABORT,'verify_chain_busy'); END;
`;
