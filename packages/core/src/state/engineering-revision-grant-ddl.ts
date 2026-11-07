/** Live revision-grant guards (bridge phase 5-A, appendix §4.2). Two triggers and one partial unique index: migration 53 adds no table and rebuilds nothing.
 *
 * `grant_json` of a live chain may only be replaced by a re-grant: the round allowance never shrinks, and the grant cannot be
 * rebound to another Mission, PR, repository or scope. A shadow chain's grant is a fixed marker. Every comparison is written so
 * a missing or malformed field cannot make the guard pass: `IS NOT` instead of `<>`, and the ordering test is wrapped in
 * `COALESCE(...,0)=0` (a NULL comparison would otherwise let the update through). The column CHECK from migration 51 still
 * requires `rounds` to be the integer 1 or 2 and `rounds_used<=rounds`, so a cap above 2 is refused by the database whatever the writer does. */
export const ENGINEERING_REVISION_GRANT_DDL = `
CREATE TRIGGER IF NOT EXISTS engineering_chain_grant_monotonic BEFORE UPDATE OF grant_json ON engineering_revision_chains
WHEN NEW.mode='live' AND (
  COALESCE(json_extract(NEW.grant_json,'$.rounds')>=json_extract(OLD.grant_json,'$.rounds'),0)=0
  OR json_extract(NEW.grant_json,'$.root_mission_id') IS NOT json_extract(OLD.grant_json,'$.root_mission_id')
  OR json_extract(NEW.grant_json,'$.pr_number') IS NOT json_extract(OLD.grant_json,'$.pr_number')
  OR json_extract(NEW.grant_json,'$.repository') IS NOT json_extract(OLD.grant_json,'$.repository')
  OR json_extract(NEW.grant_json,'$.scope_id') IS NOT json_extract(OLD.grant_json,'$.scope_id'))
BEGIN SELECT RAISE(ABORT,'grant_not_monotonic'); END;
CREATE TRIGGER IF NOT EXISTS engineering_chain_grant_shadow_fixed BEFORE UPDATE OF grant_json ON engineering_revision_chains
WHEN OLD.mode='shadow' AND NEW.grant_json IS NOT OLD.grant_json
BEGIN SELECT RAISE(ABORT,'grant_shadow_fixed'); END;
-- At most one pending push intent per chain (TLA+ finding D2): a second push cannot be recorded until the first is settled.
CREATE UNIQUE INDEX IF NOT EXISTS engineering_intent_one_pending_push ON engineering_publication_intents(chain_id) WHERE kind='push' AND state='pending';
`;
