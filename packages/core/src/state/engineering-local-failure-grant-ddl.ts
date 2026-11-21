/** Migration 64 protects the opt-in of live V2 chains, including direct SQL updates. */
export const ENGINEERING_LOCAL_FAILURE_GRANT_DDL = `
CREATE TRIGGER engineering_local_failure_grant_monotonic BEFORE UPDATE OF grant_json ON engineering_revision_chains
WHEN OLD.mode='live' AND json_extract(OLD.grant_json,'$.version') IS 2
BEGIN
  SELECT RAISE(ABORT,'grant_not_monotonic') WHERE NOT json_valid(NEW.grant_json);
  -- SQLite and the grant reader can select different values for a repeated object key.
  SELECT RAISE(ABORT,'grant_not_monotonic') WHERE EXISTS (
    SELECT 1 FROM json_tree(NEW.grant_json) GROUP BY parent,key HAVING count(*)>1);
  SELECT RAISE(ABORT,'grant_not_monotonic') WHERE
    json_type(NEW.grant_json,'$.version') IS NOT 'integer' OR json_extract(NEW.grant_json,'$.version') IS NOT 2
    OR json_type(NEW.grant_json,'$.local_failure.enabled') IS NOT 'true'
    OR json_type(NEW.grant_json,'$.local_failure.diagnostic_timeout_seconds') IS NOT 'integer'
    OR COALESCE(json_extract(NEW.grant_json,'$.local_failure.diagnostic_timeout_seconds') >=
                json_extract(OLD.grant_json,'$.local_failure.diagnostic_timeout_seconds'),0)=0
    OR (json_type(OLD.grant_json,'$.local_failure.recheck') IS NOT NULL AND
        COALESCE(json_extract(NEW.grant_json,'$.local_failure.recheck.timeout_seconds') >=
                 json_extract(OLD.grant_json,'$.local_failure.recheck.timeout_seconds'),0)=0)
    OR (json_type(NEW.grant_json,'$.local_failure.recheck') IS NOT NULL AND (
        json_type(NEW.grant_json,'$.local_failure.recheck.enabled') IS NOT 'true'
        OR json_type(NEW.grant_json,'$.local_failure.recheck.timeout_seconds') IS NOT 'integer'
        OR json_extract(NEW.grant_json,'$.local_failure.recheck.timeout_seconds') NOT BETWEEN 1 AND 120));
  SELECT RAISE(ABORT,'grant_opt_in_changed') WHERE
    EXISTS (SELECT 1 FROM engineering_local_failure_intakes WHERE chain_id=OLD.chain_id) AND (
    json_extract(NEW.grant_json,'$.local_failure.profile_id') IS NOT json_extract(OLD.grant_json,'$.local_failure.profile_id')
    OR json_extract(NEW.grant_json,'$.local_failure.profile_digest') IS NOT json_extract(OLD.grant_json,'$.local_failure.profile_digest')
    OR json_extract(NEW.grant_json,'$.local_failure.trusted_source.repository') IS NOT json_extract(OLD.grant_json,'$.local_failure.trusted_source.repository')
    OR json_extract(NEW.grant_json,'$.local_failure.trusted_source.commit') IS NOT json_extract(OLD.grant_json,'$.local_failure.trusted_source.commit')
    OR json_extract(NEW.grant_json,'$.local_failure.trusted_source.artifact_digest') IS NOT json_extract(OLD.grant_json,'$.local_failure.trusted_source.artifact_digest'));
END;
`;
