/** Durable scan identity and poll marker for the shadow merger (bridge App E follow-up to M-C; design `2026-11-06-bridge-shadow-merger.md` §4.1, §4.3).
 *
 * Migration 55 is additive: one new table, three new nullable columns (`ALTER TABLE ... ADD COLUMN`, no rebuild of migration 52's tables, no
 * default that rewrites existing rows) and five triggers plus one partial unique index. Rows written before 55 keep NULL in the new columns.
 *
 * - `engineering_merger_shadow_scans.scan_id` is issued by the database (AUTOINCREMENT) when a scan takes its first observation. A cycle and every
 *   outcome that scan records carry that id, so the comparison report finds "the scan that detected the merge" by id and never by time, by
 *   adjacency or by "the newest cycle when the scan began" (which two overlapping processes can get wrong). New cycle and outcome rows must name
 *   an existing scan (`merger_unknown_scan`); one scan writes at most one cycle.
 * - `engineering_merger_shadow_watermarks.last_poll_at` is the local wall time of the PR's latest observation start, written in the same
 *   statement that issues the observation number. It only moves forward. A restarted process computes the next hourly closed-PR poll from it
 *   instead of restarting the interval. Reporting and cadence only; it never orders anything (the fence stays `issued_seq` / `accepted_seq`).
 *
 * Every CHECK is written so NULL cannot satisfy it where a value is required (see migration 52). */
export const ENGINEERING_MERGER_SCAN_DDL = `
CREATE TABLE engineering_merger_shadow_scans (
  scan_id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL CHECK(started_at IS NOT NULL AND started_at>=0)
);
CREATE TRIGGER engineering_merger_scan_append_only BEFORE UPDATE ON engineering_merger_shadow_scans
BEGIN SELECT RAISE(ABORT,'merger_shadow_immutable'); END;
CREATE TRIGGER engineering_merger_scan_no_delete BEFORE DELETE ON engineering_merger_shadow_scans
BEGIN SELECT RAISE(ABORT,'merger_shadow_immutable'); END;

ALTER TABLE engineering_merger_shadow_cycles ADD COLUMN scan_id INTEGER REFERENCES engineering_merger_shadow_scans(scan_id)
  CHECK(scan_id IS NULL OR scan_id>0);
CREATE UNIQUE INDEX engineering_merger_cycle_scan ON engineering_merger_shadow_cycles(scan_id) WHERE scan_id IS NOT NULL;
CREATE TRIGGER engineering_merger_cycle_scan_required BEFORE INSERT ON engineering_merger_shadow_cycles
WHEN NEW.scan_id IS NULL OR NOT EXISTS (SELECT 1 FROM engineering_merger_shadow_scans WHERE scan_id=NEW.scan_id)
BEGIN SELECT RAISE(ABORT,'merger_unknown_scan'); END;

ALTER TABLE engineering_merger_shadow_outcomes ADD COLUMN scan_id INTEGER REFERENCES engineering_merger_shadow_scans(scan_id)
  CHECK(scan_id IS NULL OR scan_id>0);
CREATE TRIGGER engineering_merger_outcome_scan_required BEFORE INSERT ON engineering_merger_shadow_outcomes
WHEN NEW.scan_id IS NULL OR NOT EXISTS (SELECT 1 FROM engineering_merger_shadow_scans WHERE scan_id=NEW.scan_id)
BEGIN SELECT RAISE(ABORT,'merger_unknown_scan'); END;

ALTER TABLE engineering_merger_shadow_watermarks ADD COLUMN last_poll_at INTEGER CHECK(last_poll_at IS NULL OR last_poll_at>=0);
CREATE TRIGGER engineering_merger_watermark_poll_monotonic BEFORE UPDATE OF last_poll_at ON engineering_merger_shadow_watermarks
WHEN NEW.last_poll_at IS NULL OR COALESCE(NEW.last_poll_at>=OLD.last_poll_at,OLD.last_poll_at IS NULL)=0
BEGIN SELECT RAISE(ABORT,'merger_poll_regressed'); END;
`;
