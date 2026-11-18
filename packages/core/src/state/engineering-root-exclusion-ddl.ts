/** Additive guards for writers that bypass the shared root admission function. */
export const ENGINEERING_ROOT_EXCLUSION_DDL = `
CREATE TRIGGER engineering_root_exclusion_review BEFORE INSERT ON engineering_revision_reservations
WHEN EXISTS (SELECT 1 FROM engineering_revision_chains c WHERE c.chain_id=NEW.chain_id AND (
  EXISTS (SELECT 1 FROM engineering_local_failure_intakes i WHERE i.root_mission_id=c.root_mission_id AND i.state<>'stopped')
  OR EXISTS (SELECT 1 FROM engineering_contained_missions m
    WHERE json_type(m.spec_json,'$.ci_repair.root')='text' AND json_extract(m.spec_json,'$.ci_repair.root')=c.root_mission_id
      AND NOT (m.state IN ('pr_opened','cancelled','abandoned','failed') AND m.stop_obligation=0))))
BEGIN SELECT RAISE(ABORT,'chain_busy'); END;

CREATE TRIGGER engineering_root_exclusion_actions BEFORE INSERT ON engineering_contained_missions
WHEN COALESCE(json_type(NEW.spec_json,'$.ci_repair.root')='text',0)=1 AND (
  EXISTS (SELECT 1 FROM engineering_local_failure_intakes i
    WHERE i.root_mission_id=json_extract(NEW.spec_json,'$.ci_repair.root') AND i.state<>'stopped')
  OR EXISTS (SELECT 1 FROM engineering_revision_chains c JOIN engineering_revision_reservations r ON r.chain_id=c.chain_id
    WHERE c.root_mission_id=json_extract(NEW.spec_json,'$.ci_repair.root') AND c.mode='live' AND r.state IN ('reserved','dispatched'))
  OR EXISTS (SELECT 1 FROM engineering_contained_missions m
    WHERE json_type(m.spec_json,'$.ci_repair.root')='text'
      AND json_extract(m.spec_json,'$.ci_repair.root')=json_extract(NEW.spec_json,'$.ci_repair.root')
      AND NOT (m.state IN ('pr_opened','cancelled','abandoned','failed') AND m.stop_obligation=0)))
BEGIN SELECT RAISE(ABORT,'verify_chain_busy'); END;

CREATE TRIGGER engineering_root_exclusion_intake BEFORE INSERT ON engineering_local_failure_intakes
WHEN EXISTS (SELECT 1 FROM engineering_contained_missions m
  WHERE json_type(m.spec_json,'$.ci_repair.root')='text' AND json_extract(m.spec_json,'$.ci_repair.root')=NEW.root_mission_id
    AND NOT (m.state IN ('pr_opened','cancelled','abandoned','failed') AND m.stop_obligation=0))
BEGIN SELECT RAISE(ABORT,'verify_chain_busy'); END;
`;
