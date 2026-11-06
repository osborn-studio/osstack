/** Additive shadow-merger ledger (bridge App E, M-A; design `2026-11-06-bridge-shadow-merger.md` §4.1). New tables only.
 *
 * Ordering is DB-issued, never wall-clock. `engineering_merger_shadow_watermarks` holds one row per PR with two counters:
 * `issued_seq` (observation numbers handed out *before* the GitHub reads start) and `accepted_seq` (the highest number
 * whose observation was accepted). The write transaction advances `accepted_seq` first; a number at or below it is stale
 * and refused, whether or not the resulting decision would have been deduplicated. Decisions and outcome segments carry
 * the number they were fenced with (`observation_seq`), and "before the merge" always means a lower `observation_seq`.
 * `observed_at` / `created_at` are local wall time for reports only.
 *
 * Every CHECK is written so NULL cannot satisfy it: SQLite lets a CHECK pass when it evaluates to NULL, so each nullable
 * operand is guarded with `IS NOT NULL` or wrapped in `COALESCE(...,0)=1`.
 *
 * Writer constraints the database cannot enforce (see the store): no REPLACE, a RAISE(ABORT) never leaves a half
 * transaction behind, and rows are validated in code first because the dedupe trigger runs before the CHECKs. */
export const ENGINEERING_MERGER_DDL = `
CREATE TABLE engineering_merger_shadow_watermarks (
  repository TEXT NOT NULL CHECK(COALESCE(repository=lower(repository) AND length(repository) BETWEEN 3 AND 200,0)=1),
  pr_number INTEGER NOT NULL CHECK(pr_number IS NOT NULL AND pr_number>0),
  issued_seq INTEGER NOT NULL CHECK(issued_seq IS NOT NULL AND issued_seq>=0),
  accepted_seq INTEGER NOT NULL CHECK(accepted_seq IS NOT NULL AND accepted_seq>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at IS NOT NULL AND updated_at>=0),
  PRIMARY KEY(repository,pr_number),
  CHECK(accepted_seq<=issued_seq)
);
CREATE TRIGGER engineering_merger_watermark_monotonic BEFORE UPDATE ON engineering_merger_shadow_watermarks
WHEN NEW.repository IS NOT OLD.repository OR NEW.pr_number IS NOT OLD.pr_number
  OR NEW.issued_seq < OLD.issued_seq OR NEW.accepted_seq < OLD.accepted_seq
BEGIN SELECT RAISE(ABORT,'merger_watermark_regressed'); END;
CREATE TRIGGER engineering_merger_watermark_stale BEFORE UPDATE OF accepted_seq ON engineering_merger_shadow_watermarks
WHEN NEW.accepted_seq <= OLD.accepted_seq
BEGIN SELECT RAISE(ABORT,'merger_stale_observation'); END;
CREATE TRIGGER engineering_merger_watermark_no_delete BEFORE DELETE ON engineering_merger_shadow_watermarks
BEGIN SELECT RAISE(ABORT,'merger_shadow_immutable'); END;
CREATE TRIGGER engineering_merger_watermark_insert BEFORE INSERT ON engineering_merger_shadow_watermarks
WHEN NEW.issued_seq IS NOT 1 OR NEW.accepted_seq IS NOT 0
BEGIN SELECT RAISE(ABORT,'merger_watermark_insert'); END;

CREATE TABLE engineering_merger_shadow_decisions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  repository TEXT NOT NULL CHECK(COALESCE(repository=lower(repository) AND length(repository) BETWEEN 3 AND 200,0)=1),
  pr_number INTEGER NOT NULL CHECK(pr_number IS NOT NULL AND pr_number>0),
  mission_id TEXT NOT NULL REFERENCES engineering_contained_missions(mission_id),
  observation_seq INTEGER NOT NULL CHECK(observation_seq IS NOT NULL AND observation_seq>0),
  head_sha TEXT NOT NULL CHECK(COALESCE(length(head_sha) IN (40,64) AND head_sha NOT GLOB '*[^0-9a-f]*',0)=1),
  base_sha TEXT,
  verdict TEXT NOT NULL CHECK(COALESCE(verdict IN ('would_merge','refused','unevaluated'),0)=1),
  codes_json TEXT NOT NULL CHECK(COALESCE(CASE WHEN json_valid(codes_json) THEN
    json_type(codes_json)='array' AND length(codes_json)<=4096 ELSE 0 END,0)=1),
  codes_digest TEXT NOT NULL CHECK(COALESCE(length(codes_digest)=64 AND codes_digest NOT GLOB '*[^0-9a-f]*',0)=1),
  gates_json TEXT NOT NULL CHECK(COALESCE(CASE WHEN json_valid(gates_json) THEN
    json_type(gates_json)='object' AND length(gates_json)<=16384 ELSE 0 END,0)=1),
  merge_request_json TEXT,
  evidence_digest TEXT NOT NULL CHECK(COALESCE(length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^0-9a-f]*',0)=1),
  observed_at INTEGER NOT NULL CHECK(observed_at IS NOT NULL AND observed_at>=0),
  created_at INTEGER NOT NULL CHECK(created_at IS NOT NULL AND created_at>=0),
  CHECK((verdict='would_merge') = (merge_request_json IS NOT NULL)),
  CHECK(COALESCE(verdict='unevaluated' OR base_sha IS NOT NULL,0)=1),
  CHECK(base_sha IS NULL OR COALESCE(length(base_sha) IN (40,64) AND base_sha NOT GLOB '*[^0-9a-f]*',0)=1),
  CHECK(COALESCE(verdict<>'would_merge' OR (
      base_sha IS NOT NULL
      AND json_array_length(codes_json)=0
      AND codes_digest='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
      AND merge_request_json IS NOT NULL
      AND CASE WHEN json_valid(merge_request_json) THEN
        json_type(merge_request_json)='object'
        AND json_extract(merge_request_json,'$.sha') IS head_sha
        AND json_extract(merge_request_json,'$.merge_method') IS 'squash' ELSE 0 END),0)=1),
  CHECK(COALESCE(verdict='would_merge' OR (json_array_length(codes_json)>0
      AND codes_digest<>'4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'),0)=1)
);
CREATE INDEX engineering_merger_decisions_pr ON engineering_merger_shadow_decisions(repository,pr_number,seq);
CREATE UNIQUE INDEX engineering_merger_decisions_obs ON engineering_merger_shadow_decisions(repository,pr_number,observation_seq);
CREATE TRIGGER engineering_merger_decision_fenced BEFORE INSERT ON engineering_merger_shadow_decisions
WHEN NEW.observation_seq IS NOT (SELECT accepted_seq FROM engineering_merger_shadow_watermarks
                                 WHERE repository=NEW.repository AND pr_number=NEW.pr_number)
BEGIN SELECT RAISE(ABORT,'merger_unfenced_decision'); END;
CREATE TRIGGER engineering_merger_decision_after_merge BEFORE INSERT ON engineering_merger_shadow_decisions
WHEN EXISTS (SELECT 1 FROM engineering_merger_shadow_outcomes
             WHERE repository=NEW.repository AND pr_number=NEW.pr_number AND outcome='merged')
BEGIN SELECT RAISE(ABORT,'merger_pr_merged'); END;
CREATE TRIGGER engineering_merger_decision_codes BEFORE INSERT ON engineering_merger_shadow_decisions
WHEN json_valid(NEW.codes_json) AND json_type(NEW.codes_json)='array' AND EXISTS (
  SELECT 1 FROM json_each(NEW.codes_json) c WHERE c.type<>'text' OR length(c.value) NOT BETWEEN 1 AND 200
    OR (NEW.verdict='refused' AND c.value LIKE 'U.%') OR (NEW.verdict='unevaluated' AND c.value NOT LIKE 'U.%'))
BEGIN SELECT RAISE(ABORT,'merger_decision_codes_invalid'); END;
-- Dedupe repeats the fence and not-merged conditions: trigger order is not documented, and an unfenced or post-merge
-- duplicate must reach the ABORT triggers above instead of being swallowed here.
CREATE TRIGGER engineering_merger_decision_dedupe BEFORE INSERT ON engineering_merger_shadow_decisions
WHEN NEW.observation_seq IS (SELECT accepted_seq FROM engineering_merger_shadow_watermarks
                             WHERE repository=NEW.repository AND pr_number=NEW.pr_number)
 AND NOT EXISTS (SELECT 1 FROM engineering_merger_shadow_outcomes
                 WHERE repository=NEW.repository AND pr_number=NEW.pr_number AND outcome='merged')
 AND EXISTS (SELECT 1 FROM engineering_merger_shadow_decisions d
  WHERE d.seq=(SELECT MAX(seq) FROM engineering_merger_shadow_decisions
               WHERE repository=NEW.repository AND pr_number=NEW.pr_number)
    AND d.head_sha=NEW.head_sha AND d.verdict=NEW.verdict AND d.codes_digest=NEW.codes_digest)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER engineering_merger_decision_append_only BEFORE UPDATE ON engineering_merger_shadow_decisions
BEGIN SELECT RAISE(ABORT,'merger_shadow_immutable'); END;
CREATE TRIGGER engineering_merger_decision_no_delete BEFORE DELETE ON engineering_merger_shadow_decisions
BEGIN SELECT RAISE(ABORT,'merger_shadow_immutable'); END;

CREATE TABLE engineering_merger_shadow_cycles (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL CHECK(started_at IS NOT NULL AND started_at>=0),
  finished_at INTEGER NOT NULL CHECK(finished_at IS NOT NULL AND finished_at>=0),
  prs_json TEXT NOT NULL CHECK(COALESCE(CASE WHEN json_valid(prs_json) THEN
    json_type(prs_json)='array' AND length(prs_json)<=4096 ELSE 0 END,0)=1)
);
CREATE TRIGGER engineering_merger_cycle_append_only BEFORE UPDATE ON engineering_merger_shadow_cycles
BEGIN SELECT RAISE(ABORT,'merger_shadow_immutable'); END;
CREATE TRIGGER engineering_merger_cycle_no_delete BEFORE DELETE ON engineering_merger_shadow_cycles
BEGIN SELECT RAISE(ABORT,'merger_shadow_immutable'); END;

CREATE TABLE engineering_merger_shadow_outcomes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  repository TEXT NOT NULL CHECK(COALESCE(repository=lower(repository) AND length(repository) BETWEEN 3 AND 200,0)=1),
  pr_number INTEGER NOT NULL CHECK(pr_number IS NOT NULL AND pr_number>0),
  mission_id TEXT NOT NULL REFERENCES engineering_contained_missions(mission_id),
  observation_seq INTEGER NOT NULL CHECK(observation_seq IS NOT NULL AND observation_seq>0),
  outcome TEXT NOT NULL CHECK(COALESCE(outcome IN ('merged','closed_unmerged','reopened','observation_expired'),0)=1),
  head_at_close TEXT NOT NULL CHECK(COALESCE(length(head_at_close) IN (40,64) AND head_at_close NOT GLOB '*[^0-9a-f]*',0)=1),
  merged_at TEXT CHECK(merged_at IS NULL OR COALESCE(length(merged_at) BETWEEN 10 AND 40,0)=1),
  merge_commit TEXT CHECK(merge_commit IS NULL OR COALESCE(length(merge_commit) IN (40,64) AND merge_commit NOT GLOB '*[^0-9a-f]*',0)=1),
  merged_by_actor_id INTEGER CHECK(merged_by_actor_id IS NULL OR merged_by_actor_id>0),
  merged_by_type TEXT CHECK(merged_by_type IS NULL OR merged_by_type IN ('User','Bot')),
  owner_approved_head INTEGER CHECK(owner_approved_head IS NULL OR owner_approved_head IN (0,1)),
  facts_json TEXT NOT NULL CHECK(COALESCE(CASE WHEN json_valid(facts_json) THEN
    json_type(facts_json)='object' AND length(facts_json)<=8192 ELSE 0 END,0)=1),
  observed_at INTEGER NOT NULL CHECK(observed_at IS NOT NULL AND observed_at>=0),
  created_at INTEGER NOT NULL CHECK(created_at IS NOT NULL AND created_at>=0),
  CHECK((outcome='merged') = (merged_at IS NOT NULL AND merge_commit IS NOT NULL
    AND merged_by_actor_id IS NOT NULL AND merged_by_type IS NOT NULL)),
  CHECK(outcome='merged' OR (merged_at IS NULL AND merge_commit IS NULL AND merged_by_actor_id IS NULL
    AND merged_by_type IS NULL AND owner_approved_head IS NULL))
);
CREATE UNIQUE INDEX engineering_merger_outcomes_obs ON engineering_merger_shadow_outcomes(repository,pr_number,observation_seq);
CREATE UNIQUE INDEX engineering_merger_outcome_merged ON engineering_merger_shadow_outcomes(repository,pr_number) WHERE outcome='merged';
-- (none) -> closed_unmerged|merged; closed_unmerged -> reopened|merged|observation_expired; reopened -> closed_unmerged|merged.
-- merged and observation_expired are terminal. closed_unmerged -> merged is a reopen-and-merge between two hourly polls.
CREATE TRIGGER engineering_merger_outcome_transition BEFORE INSERT ON engineering_merger_shadow_outcomes
WHEN NOT (COALESCE((SELECT outcome FROM engineering_merger_shadow_outcomes
        WHERE repository=NEW.repository AND pr_number=NEW.pr_number ORDER BY seq DESC LIMIT 1),'')
    || '>' || NEW.outcome IN ('>closed_unmerged','>merged','closed_unmerged>reopened','closed_unmerged>merged',
      'closed_unmerged>observation_expired','reopened>closed_unmerged','reopened>merged'))
BEGIN SELECT RAISE(ABORT,'merger_outcome_transition'); END;
CREATE TRIGGER engineering_merger_outcome_fenced BEFORE INSERT ON engineering_merger_shadow_outcomes
WHEN NEW.observation_seq IS NOT (SELECT accepted_seq FROM engineering_merger_shadow_watermarks
                                 WHERE repository=NEW.repository AND pr_number=NEW.pr_number)
BEGIN SELECT RAISE(ABORT,'merger_unfenced_outcome'); END;
CREATE TRIGGER engineering_merger_outcome_append_only BEFORE UPDATE ON engineering_merger_shadow_outcomes
BEGIN SELECT RAISE(ABORT,'merger_shadow_immutable'); END;
CREATE TRIGGER engineering_merger_outcome_no_delete BEFORE DELETE ON engineering_merger_shadow_outcomes
BEGIN SELECT RAISE(ABORT,'merger_shadow_immutable'); END;
`;
