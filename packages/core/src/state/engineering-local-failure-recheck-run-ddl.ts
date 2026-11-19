// All interpolated identifiers are fixed by migration 63.
const table = "engineering_local_failure_recheck_runs";
const ledger = "engineering_local_failure_rechecks";
const prefix = "engineering_local_failure_recheck_run";
const bounded = (c: string, max = 128) =>
  `typeof(${c})='text' AND instr(${c},char(0))=0 AND length(${c}) BETWEEN 1 AND ${max}`;
const hex = (c: string, n: number) => `${bounded(c, n)} AND length(${c})=${n} AND ${c} NOT GLOB '*[^0-9a-f]*'`;
const uuid = (c: string, p: string) => `${bounded(c, 40)} AND ${c} GLOB '${p}????????-????-????-????-????????????'
  AND substr(${c},${p.length + 1}) NOT GLOB '*[^0-9a-f-]*' AND length(replace(${c},'-',''))=${p.length + 32}`;
const ledgerColumns = [
  "recheck_id",
  "dispatch_id",
  "root_mission_id",
  "child_mission_id",
  "chain_id",
  "intake_id",
  "repository",
  "repository_id",
  "pr_number",
  "base_sha",
  "profile_id",
  "profile_digest",
  "trusted_source_digest",
  "skill_id",
  "skill_version",
  "skill_blob",
  "skill_manifest_digest",
  "original_result_id",
  "original_source_seq",
  "failed_check_id",
  "original_checks_json"
];
const fixed = [
  ...ledgerColumns,
  "run_id",
  "attempt",
  "chain_revision",
  "branch",
  "base_ref",
  "head_sha",
  "tree_sha",
  "grant_id",
  "grant_digest",
  "invocation_id",
  "journal_ref",
  "container_cap_seconds",
  "owner_home",
  "owner_instance",
  "owner_generation",
  "created_at"
];
const receipts = ["receipt_id", "receipt_digest", "receipt_json", "run_identity_digest"];
const debit = (
  t: string
) => `(SELECT COALESCE(SUM(CASE WHEN state='stopped' THEN container_used_seconds ELSE container_cap_seconds END),0)
  FROM ${t} WHERE chain_id=NEW.chain_id)`;
const unsettledMission = "NOT (m.state IN ('pr_opened','cancelled','abandoned','failed') AND m.stop_obligation=0)";
const currentOwner = `EXISTS (SELECT 1 FROM daemon_owner WHERE singleton=1 AND home_id=NEW.owner_home
  AND instance_id=NEW.writer_instance AND generation=NEW.writer_generation)`;
const currentChain = `EXISTS (SELECT 1 FROM engineering_revision_chains c WHERE c.chain_id=NEW.chain_id AND c.mode='live'
  AND c.state='awaiting_review' AND c.revision=NEW.chain_revision AND c.root_mission_id=NEW.root_mission_id
  AND c.repository=NEW.repository AND c.pr_number=NEW.pr_number AND c.branch=NEW.branch AND c.base_ref=NEW.base_ref
  AND c.published_head=NEW.head_sha AND c.published_base=NEW.base_sha AND json_extract(c.grant_json,'$.grant_id')=NEW.grant_id)`;

export const ENGINEERING_LOCAL_FAILURE_RECHECK_RUN_DDL = `
CREATE TABLE ${table} (
  run_id TEXT PRIMARY KEY NOT NULL CHECK(${uuid("run_id", "vrn_")}),
  recheck_id TEXT NOT NULL REFERENCES ${ledger}(recheck_id) CHECK(${uuid("recheck_id", "vrc_")}),
  attempt INTEGER NOT NULL CHECK(typeof(attempt)='integer' AND attempt BETWEEN 1 AND 3),
  dispatch_id TEXT NOT NULL CHECK(${uuid("dispatch_id", "vld_")}),
  original_result_id TEXT NOT NULL CHECK(${uuid("original_result_id", "")}),
  ${[
    "root_mission_id",
    "child_mission_id",
    "chain_id",
    "intake_id",
    "profile_id",
    "skill_id",
    "failed_check_id",
    "grant_id",
    "owner_home",
    "owner_instance",
    "writer_instance"
  ]
    .map((c) => `${c} TEXT NOT NULL CHECK(${bounded(c)})`)
    .join(",\n  ")},
  ${[
    "chain_revision",
    "pr_number",
    "repository_id",
    "original_source_seq",
    "owner_generation",
    "writer_generation",
    "revision"
  ]
    .map((c) => `${c} INTEGER NOT NULL CHECK(typeof(${c})='integer' AND ${c}>0)`)
    .join(",\n  ")},
  repository TEXT NOT NULL CHECK(${bounded("repository", 200)}),
  branch TEXT NOT NULL CHECK(${bounded("branch", 255)}),
  base_ref TEXT NOT NULL CHECK(${bounded("base_ref", 255)}),
  skill_version TEXT NOT NULL CHECK(${bounded("skill_version", 64)}),
  ${["head_sha", "base_sha", "skill_blob"].map((c) => `${c} TEXT NOT NULL CHECK(${hex(c, 40)})`).join(",\n  ")},
  tree_sha TEXT NOT NULL CHECK((${hex("tree_sha", 40)}) OR (${hex("tree_sha", 64)})),
  ${["skill_manifest_digest", "profile_digest", "trusted_source_digest", "grant_digest"].map((c) => `${c} TEXT NOT NULL CHECK(${hex(c, 64)})`).join(",\n  ")},
  original_checks_json TEXT NOT NULL CHECK(${bounded("original_checks_json", 17000)} AND json_valid(original_checks_json)
    AND json_type(original_checks_json)='array' AND json_array_length(original_checks_json) BETWEEN 1 AND 128),
  invocation_id TEXT NOT NULL UNIQUE CHECK(${bounded("invocation_id", 256)}),
  journal_ref TEXT NOT NULL CHECK(${bounded("journal_ref", 1024)}),
  container_cap_seconds INTEGER NOT NULL CHECK(typeof(container_cap_seconds)='integer' AND container_cap_seconds BETWEEN 1 AND 120),
  container_used_seconds INTEGER CHECK(container_used_seconds IS NULL OR
    (typeof(container_used_seconds)='integer' AND container_used_seconds BETWEEN 0 AND container_cap_seconds)),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=created_at),
  started_at INTEGER CHECK(started_at IS NULL OR (typeof(started_at)='integer' AND started_at BETWEEN created_at AND updated_at)),
  state TEXT NOT NULL CHECK(state IN ('reserved','running','stop_unknown','stopped')),
  reason TEXT CHECK(reason IS NULL OR (${bounded("reason")})),
  stop_obligation INTEGER NOT NULL CHECK(stop_obligation IN (0,1)),
  outcome TEXT CHECK(outcome IN ('passed','reproducible_failure','infrastructure_error','cancelled','timeout','not_started')),
  proof_ref TEXT CHECK(proof_ref IS NULL OR (${bounded("proof_ref", 1024)})),
  ${["proof_digest", "evidence_digest", "receipt_digest", "run_identity_digest"].map((c) => `${c} TEXT CHECK(${c} IS NULL OR (${hex(c, 64)}))`).join(",\n  ")},
  receipt_id TEXT UNIQUE CHECK(receipt_id IS NULL OR (${uuid("receipt_id", "vrr_")})),
  receipt_json TEXT CHECK(receipt_json IS NULL OR (${bounded("receipt_json", 32768)} AND length(CAST(receipt_json AS BLOB))<=32768 AND json_valid(receipt_json))),
  conclusion_state TEXT, conclusion_reason TEXT,
  UNIQUE(recheck_id,attempt),
  CHECK((state='stopped')=(stop_obligation=0) AND (state='stopped')=(outcome IS NOT NULL)
    AND (state='stopped')=(container_used_seconds IS NOT NULL) AND (state='stopped')=(proof_ref IS NOT NULL)
    AND (state='stopped')=(proof_digest IS NOT NULL)),
  CHECK(${[...receipts, "evidence_digest"].map((c) => `(${c} IS NOT NULL)=(state='stopped' AND outcome IS NOT 'not_started')`).join(" AND ")}),
  CHECK(state<>'stopped' OR ((outcome='not_started')=(started_at IS NULL) AND (outcome<>'not_started' OR container_used_seconds=0))),
  CHECK(state<>'reserved' OR started_at IS NULL),
  CHECK(state<>'running' OR started_at IS NOT NULL),
  CHECK(state<>'stop_unknown' OR (reason IS 'verify_stop_unproven' AND conclusion_reason IS 'verify_stop_unproven')),
  CHECK((state IN ('reserved','running'))=(conclusion_state IS NULL)),
  CHECK((conclusion_state IS NULL AND conclusion_reason IS NULL)
    OR (conclusion_state IS 'host_passed' AND outcome IS 'passed' AND conclusion_reason IS NULL)
    OR (conclusion_state IS 'closed' AND conclusion_reason IS 'verify_withdrawn')
    OR (conclusion_state IS 'awaiting_decision' AND conclusion_reason IS NOT NULL AND conclusion_reason IN
      ('verify_recheck_host_failed','verify_infrastructure_error','verify_stop_unproven','verify_recheck_not_started',
       'verify_profile_unavailable','verify_stale_head','verify_base_changed'))),
  CHECK(conclusion_reason IS NOT 'verify_recheck_host_failed' OR outcome IS 'reproducible_failure'),
  CHECK(conclusion_reason NOT IN ('verify_recheck_not_started','verify_profile_unavailable') OR outcome IS 'not_started')
) WITHOUT ROWID;
CREATE UNIQUE INDEX ${prefix}_active ON ${table}(recheck_id) WHERE NOT (state='stopped' AND outcome IS 'not_started');
CREATE UNIQUE INDEX ${prefix}_root ON ${table}(root_mission_id) WHERE state<>'stopped';
CREATE INDEX ${prefix}_chain ON ${table}(chain_id);
CREATE TRIGGER ${prefix}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT,'recheck_run_immutable'); END;
CREATE TRIGGER ${prefix}_insert BEFORE INSERT ON ${table}
WHEN NEW.state<>'reserved' OR NEW.revision<>1 OR NEW.reason IS NOT NULL OR NEW.created_at<>NEW.updated_at
  OR NEW.stop_obligation<>1 OR ${[
    "started_at",
    "outcome",
    "container_used_seconds",
    "evidence_digest",
    "proof_ref",
    "proof_digest",
    ...receipts,
    "conclusion_state",
    "conclusion_reason"
  ]
    .map((c) => `NEW.${c} IS NOT NULL`)
    .join(" OR ")}
  OR NEW.owner_instance IS NOT NEW.writer_instance OR NEW.owner_generation IS NOT NEW.writer_generation OR NOT ${currentOwner}
  OR NEW.attempt<>1+(SELECT count(*) FROM ${table} WHERE recheck_id=NEW.recheck_id)
BEGIN SELECT RAISE(ABORT,'recheck_run_insert_denied'); END;
CREATE TRIGGER ${prefix}_binding BEFORE INSERT ON ${table}
WHEN NOT ${currentChain} OR NOT EXISTS (SELECT 1 FROM ${ledger} l WHERE l.state='reverify_pending'
  AND l.new_head_sha=NEW.head_sha AND ${ledgerColumns.map((c) => `l.${c}=NEW.${c}`).join(" AND ")})
BEGIN SELECT RAISE(ABORT,'recheck_run_binding_denied'); END;
CREATE TRIGGER ${prefix}_budget BEFORE INSERT ON ${table}
WHEN EXISTS (SELECT 1 FROM engineering_revision_chains c WHERE c.chain_id=NEW.chain_id AND
  (json_type(c.grant_json,'$.budget.max_container_seconds') IS NOT 'integer' OR NEW.container_cap_seconds + ${debit("engineering_local_failure_intakes")} + ${debit(table)}
    > json_extract(c.grant_json,'$.budget.max_container_seconds')))
BEGIN SELECT RAISE(ABORT,'verify_budget_exhausted'); END;
CREATE TRIGGER ${prefix}_exclusion BEFORE INSERT ON ${table}
WHEN EXISTS (SELECT 1 FROM ${table} WHERE root_mission_id=NEW.root_mission_id AND state<>'stopped')
  OR EXISTS (SELECT 1 FROM engineering_local_failure_intakes WHERE root_mission_id=NEW.root_mission_id AND state<>'stopped')
  OR EXISTS (SELECT 1 FROM engineering_revision_chains c WHERE c.root_mission_id=NEW.root_mission_id AND c.mode='live' AND (
    EXISTS (SELECT 1 FROM engineering_revision_reservations r WHERE r.chain_id=c.chain_id AND r.state IN ('reserved','dispatched'))
    OR EXISTS (SELECT 1 FROM engineering_contained_missions m WHERE m.mission_id=c.current_mission_id AND ${unsettledMission})))
  OR EXISTS (SELECT 1 FROM engineering_contained_missions m WHERE json_type(m.spec_json,'$.ci_repair.root')='text'
    AND json_extract(m.spec_json,'$.ci_repair.root')=NEW.root_mission_id AND ${unsettledMission})
  OR EXISTS (SELECT 1 FROM engineering_local_failure_dispatches d JOIN engineering_contained_missions m ON m.mission_id=d.child_mission_id
    WHERE d.root_mission_id=NEW.root_mission_id AND ${unsettledMission})
BEGIN SELECT RAISE(ABORT,'verify_chain_busy'); END;
CREATE TRIGGER ${prefix}_no_replace BEFORE INSERT ON ${table}
WHEN EXISTS (SELECT 1 FROM ${table} WHERE run_id=NEW.run_id OR invocation_id=NEW.invocation_id OR receipt_id=NEW.receipt_id
  OR (recheck_id=NEW.recheck_id AND (attempt=NEW.attempt OR NOT (state='stopped' AND outcome IS 'not_started'))))
BEGIN SELECT RAISE(ABORT,'recheck_run_reused'); END;
CREATE TRIGGER ${prefix}_flow BEFORE UPDATE ON ${table}
WHEN NOT ((OLD.state='reserved' AND (NEW.state IN ('running','stop_unknown') OR (NEW.state='stopped' AND NEW.outcome IS 'not_started')))
  OR (OLD.state='running' AND NEW.state IN ('stop_unknown','stopped')) OR (OLD.state='stop_unknown' AND NEW.state='stopped'))
  OR (NEW.outcome IS 'not_started' AND OLD.state<>'reserved')
  OR (NEW.state<>'running' AND OLD.started_at IS NOT NEW.started_at) OR (NEW.state='running' AND NEW.started_at IS NOT NEW.updated_at)
  OR NOT ${currentOwner}
BEGIN SELECT RAISE(ABORT,'recheck_run_state_denied'); END;
CREATE TRIGGER ${prefix}_start BEFORE UPDATE ON ${table}
WHEN NEW.state='running' AND (NEW.writer_instance<>OLD.owner_instance OR NEW.writer_generation<>OLD.owner_generation OR NOT ${currentChain}
  OR NOT EXISTS (SELECT 1 FROM ${ledger} WHERE recheck_id=NEW.recheck_id AND state='reverify_pending'))
BEGIN SELECT RAISE(ABORT,'recheck_run_start_denied'); END;
CREATE TRIGGER ${prefix}_fixed BEFORE UPDATE ON ${table}
WHEN OLD.state='stopped' OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR EXISTS (SELECT 1 FROM ${table} WHERE receipt_id=NEW.receipt_id AND run_id<>OLD.run_id)
  OR ${fixed.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(" OR ")}
  OR ${[...receipts, "conclusion_state", "conclusion_reason"].map((c) => `(OLD.${c} IS NOT NULL AND OLD.${c} IS NOT NEW.${c})`).join(" OR ")}
BEGIN SELECT RAISE(ABORT,'recheck_run_immutable'); END;
${[
  [
    "review",
    "engineering_revision_reservations",
    "(SELECT root_mission_id FROM engineering_revision_chains WHERE chain_id=NEW.chain_id)",
    "chain_busy"
  ],
  ["actions", "engineering_contained_missions", "json_extract(NEW.spec_json,'$.ci_repair.root')", "verify_chain_busy"],
  ["intake", "engineering_local_failure_intakes", "NEW.root_mission_id", "verify_chain_busy"],
  ["dispatch", "engineering_local_failure_dispatches", "NEW.root_mission_id", "verify_chain_busy"]
]
  .map(
    ([
      name,
      target,
      root,
      code
    ]) => `CREATE TRIGGER engineering_root_exclusion_recheck_${name} BEFORE INSERT ON ${target}
WHEN ${name === "actions" ? "json_type(NEW.spec_json,'$.ci_repair.root')='text' AND " : ""}EXISTS (SELECT 1 FROM ${table} WHERE root_mission_id=${root} AND state<>'stopped')
BEGIN SELECT RAISE(ABORT,'${code}'); END;`
  )
  .join("\n")}
CREATE TRIGGER engineering_local_failure_recheck_host_proof BEFORE UPDATE ON ${ledger}
WHEN NEW.host_receipt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${table} WHERE recheck_id=NEW.recheck_id
  AND receipt_id=NEW.host_receipt_id AND receipt_digest=NEW.host_receipt_digest AND state='stopped' AND outcome='passed'
  AND conclusion_state='host_passed' AND head_sha=NEW.new_head_sha)
BEGIN SELECT RAISE(ABORT,'verify_recheck_host_unproven'); END;
`;
