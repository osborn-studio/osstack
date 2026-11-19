// All substitutions are fixed schema identifiers or limits.
const bounded = (c: string, max = 128) =>
  `typeof(${c})='text' AND instr(${c},char(0))=0 AND length(${c}) BETWEEN 1 AND ${max}`;
const hex = (c: string, n: number) => `${bounded(c, n)} AND length(${c})=${n} AND ${c} NOT GLOB '*[^a-f0-9]*'`;
const integer = (c: string, min = 1) => `typeof(${c})='integer' AND ${c}>=${min}`;
const uuid = (c: string, prefix = "") => `${bounded(
  c,
  40
)} AND ${c} GLOB '${prefix}????????-????-????-????-????????????'
  AND substr(${c},${prefix.length + 1}) NOT GLOB '*[^0-9a-f-]*' AND length(replace(${c},'-',''))=${prefix.length + 32}`;
const fixed = [
  "recheck_id",
  "dispatch_id",
  "root_mission_id",
  "child_mission_id",
  "chain_id",
  "intake_id",
  "original_result_id",
  "original_source_seq",
  "repository_id",
  "repository",
  "pr_number",
  "base_sha",
  "new_head_sha",
  "skill_id",
  "skill_version",
  "skill_blob",
  "skill_manifest_digest",
  "profile_id",
  "profile_digest",
  "trusted_source_digest",
  "original_checks_json",
  "failed_check_id",
  "failed_failure_code",
  "owner_home",
  "owner_instance",
  "owner_generation",
  "created_at",
];
const table = "engineering_local_failure_rechecks";
export const ENGINEERING_LOCAL_FAILURE_RECHECK_DDL = `
CREATE TABLE engineering_local_failure_rechecks(
  recheck_id TEXT PRIMARY KEY NOT NULL CHECK(${uuid("recheck_id", "vrc_")}),
  dispatch_id TEXT NOT NULL UNIQUE REFERENCES engineering_local_failure_dispatches(dispatch_id) CHECK(${uuid(
    "dispatch_id",
    "vld_"
  )}),
  ${[
    "root_mission_id",
    "child_mission_id",
    "chain_id",
    "intake_id",
    "skill_id",
    "profile_id",
    "failed_check_id",
    "failed_failure_code",
    "owner_home",
    "owner_instance",
  ]
    .map((c) => `${c} TEXT NOT NULL CHECK(${bounded(c)})`)
    .join(",\n  ")},
  original_result_id TEXT NOT NULL CHECK(${uuid("original_result_id")}),
  original_source_seq INTEGER NOT NULL REFERENCES engineering_verification_sources(seq) CHECK(${integer(
    "original_source_seq"
  )}),
  ${["repository_id", "pr_number", "revision", "owner_generation"]
    .map((c) => `${c} INTEGER NOT NULL CHECK(${integer(c)})`)
    .join(",\n  ")},
  repository TEXT NOT NULL CHECK(${bounded("repository", 200)}),
  skill_version TEXT NOT NULL CHECK(${bounded("skill_version", 64)}),
  ${["base_sha", "new_head_sha", "skill_blob", "skill_manifest_digest", "profile_digest", "trusted_source_digest"]
    .map((c, i) => `${c} TEXT NOT NULL CHECK(${hex(c, i < 3 ? 40 : 64)})`)
    .join(",\n  ")},
  original_checks_json TEXT NOT NULL CHECK(${bounded(
    "original_checks_json",
    17000
  )} AND json_valid(original_checks_json)
    AND json_type(original_checks_json)='array' AND json_array_length(original_checks_json) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK(state IN ('reverify_pending','awaiting_decision','recheck_passed')),
  reason TEXT,
  missing_json TEXT NOT NULL CHECK(missing_json IN ('[]','["result"]','["actions"]','["host"]','["result","actions"]',
    '["result","host"]','["actions","host"]','["result","actions","host"]')),
  recheck_result_id TEXT CHECK(recheck_result_id IS NULL OR (${uuid("recheck_result_id")})),
  recheck_source_seq INTEGER REFERENCES engineering_verification_sources(seq) CHECK(recheck_source_seq IS NULL OR (${integer(
    "recheck_source_seq"
  )})),
  actions_attempt INTEGER CHECK(actions_attempt IS NULL OR (${integer("actions_attempt")})),
  actions_digest TEXT CHECK(actions_digest IS NULL OR (${hex("actions_digest", 64)})),
  host_receipt_id TEXT CHECK(host_receipt_id IS NULL OR (${bounded("host_receipt_id")})),
  host_receipt_digest TEXT CHECK(host_receipt_digest IS NULL OR (${hex("host_receipt_digest", 64)})),
  created_at INTEGER NOT NULL CHECK(${integer("created_at", 0)}),
  updated_at INTEGER NOT NULL CHECK(${integer("updated_at", 0)} AND updated_at>=created_at),
  CHECK((recheck_result_id IS NULL)=(recheck_source_seq IS NULL) AND (actions_attempt IS NULL)=(actions_digest IS NULL)
    AND (host_receipt_id IS NULL)=(host_receipt_digest IS NULL)),
  CHECK((state='reverify_pending' AND reason IS 'verify_recheck_missing' AND missing_json<>'[]'
    AND (recheck_result_id IS NULL)=(instr(missing_json,'"result"')>0) AND (actions_attempt IS NULL)=(instr(missing_json,'"actions"')>0)
    AND (host_receipt_id IS NULL)=(instr(missing_json,'"host"')>0))
    OR (state='awaiting_decision' AND reason IS NOT NULL AND reason IN ('verify_recheck_failed','verify_recheck_binding_changed') AND missing_json='[]' AND recheck_result_id IS NOT NULL)
    OR (state='recheck_passed' AND reason IS NULL AND missing_json='[]' AND recheck_result_id IS NOT NULL AND actions_attempt IS NOT NULL AND host_receipt_id IS NOT NULL))
) WITHOUT ROWID;
CREATE INDEX engineering_local_failure_recheck_chain ON ${table}(chain_id);
CREATE TRIGGER engineering_local_failure_recheck_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT,'recheck_immutable'); END;
CREATE TRIGGER engineering_local_failure_recheck_no_replace BEFORE INSERT ON ${table}
WHEN EXISTS (SELECT 1 FROM ${table} WHERE recheck_id=NEW.recheck_id OR dispatch_id=NEW.dispatch_id)
BEGIN SELECT RAISE(ABORT,'recheck_immutable'); END;
CREATE TRIGGER engineering_local_failure_recheck_insert BEFORE INSERT ON ${table}
WHEN NEW.state<>'reverify_pending' OR NEW.revision<>1 OR NEW.missing_json<>'["result","actions","host"]'
  OR NOT EXISTS (SELECT 1 FROM daemon_owner WHERE singleton=1 AND home_id=NEW.owner_home AND instance_id=NEW.owner_instance AND generation=NEW.owner_generation)
  OR NOT EXISTS (SELECT 1 FROM engineering_local_failure_dispatches WHERE dispatch_id=NEW.dispatch_id AND root_mission_id=NEW.root_mission_id
    AND child_mission_id=NEW.child_mission_id AND chain_id=NEW.chain_id AND check_id=NEW.failed_check_id AND failure_code=NEW.failed_failure_code)
  OR NOT EXISTS (SELECT 1 FROM json_each(NEW.original_checks_json) WHERE value=NEW.failed_check_id)
  OR EXISTS (SELECT 1 FROM json_each(NEW.original_checks_json) WHERE type<>'text' OR NOT (${bounded("value")})
    OR value NOT GLOB '[a-z]*' OR value GLOB '*[^a-z0-9_-]*' OR (key>0 AND value<=json_extract(NEW.original_checks_json,'$['||(key-1)||']')))
BEGIN SELECT RAISE(ABORT,'verify_recheck_binding_invalid'); END;
CREATE TRIGGER engineering_local_failure_recheck_update BEFORE UPDATE ON ${table}
WHEN OLD.state<>'reverify_pending' OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR ${fixed.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(" OR ")}
BEGIN SELECT RAISE(ABORT,'recheck_immutable'); END;
`;
