/** Keep historical lineage and state intact. Updates freeze every legacy Mission at depth
 * eight or above: its only permitted destinations are awaiting_decision and abandoned. */
export const ENGINEERING_CHAIN_DEPTH_GATE_DDL = `
CREATE TRIGGER engineering_mission_lineage_depth_cap BEFORE INSERT ON engineering_mission_lineage
WHEN NEW.chain_depth > 8 OR (NEW.chain_depth >= 8 AND NEW.source_kind = 'supersede')
BEGIN SELECT RAISE(ABORT,'verify_chain_depth_limit'); END;
CREATE TRIGGER engineering_mission_depth_stop BEFORE UPDATE OF state ON engineering_contained_missions
WHEN NEW.state NOT IN ('awaiting_decision','abandoned') AND EXISTS (
  SELECT 1 FROM engineering_mission_lineage WHERE mission_id=NEW.mission_id AND chain_depth >= 8
)
BEGIN SELECT RAISE(ABORT,'verify_chain_depth_limit'); END;
`;
