// `osstack stats` bridge section (design §6 success metrics, §9 observability). Computed from the revision-chain tables with
// SELECT only, on the daemon's connection; loaded lazily by the stats method so it is not part of CLI startup. Every grouped
// value is re-validated before it is emitted and every group list is capped, so the section stays small whatever the tables hold.
import type Database from "better-sqlite3";
import { READ_FAILED, READ_FAILED_CODES } from "./bridge-chain-events.js";

export const BRIDGE_WINDOW_MS = 24 * 3600 * 1000;
/** Newest event rows examined for windowed counts; `window_truncated` says when the window reaches past them. */
export const BRIDGE_EVENT_SCAN_CAP = 20_000;
const GROUP_CAP = 50;
const CODE = /^[a-z][a-z0-9_:.-]{0,63}$/u;

export interface BridgeStats {
  available: boolean;
  generated_at_ms: number;
  window_ms: number;
  chains: {
    total: number;
    by_mode_state: Array<{ mode: string; state: string; count: number }>;
    /** Stop reasons of chains in `awaiting_decision` (design §9 "awaiting_decision 原因分布"), by mode. */
    awaiting_decision_by_reason: Array<{ mode: string; reason: string; count: number }>;
    /** Open chains whose review deadline has passed (design §6: every chain must end; overdue means it did not). */
    open_past_deadline: number;
    /** Live chains with rounds_used above the granted rounds (design §6: must be 0). */
    rounds_over_grant: number;
  };
  shadow_decisions: { total_by_action: Array<{ action: string; count: number }>; window_by_action: Array<{ action: string; count: number }> };
  reconciliation: {
    window_observation_cycles: number; window_read_failed: number;
    /** read_failed / (observation_cycle + read_failed) in the window; null with no cycles. */
    window_read_failed_ratio: number | null;
    read_failed_by_code: Array<{ code: string; count: number }>;
    last_event_at_ms: number | null;
    window_truncated: boolean;
  };
  live: {
    reservations_by_state: Array<{ state: string; count: number }>;
    intents_by_kind_state: Array<{ kind: string; state: string; count: number }>;
  };
  /** Design §6/§9 metrics that cannot be computed from today's data; `value` is always null. */
  deferred: Record<string, { value: null; reason: string }>;
}

const DEFERRED: BridgeStats["deferred"] = {
  cycle_duration_ms: { value: null, reason: "not_recorded: observation_cycle and read_failed events carry timestamps but no duration" },
  revision_round_duration_ms: { value: null, reason: "needs_phase_5: no live chains or push intents exist before OSSTACK_BRIDGE=1" },
  changes_requested_to_push_median_ms: { value: null, reason: "needs_phase_5: needs live reservations joined to confirmed push intents (SLO 2h)" },
  first_round_pass_rate: { value: null, reason: "needs_phase_5: needs live chains with a completed first revision round" },
  ledger_branch_mismatch_after_reconcile: { value: null, reason: "needs_phase_5: needs the push-intent reconciler and a branch read-back" },
  unregistered_identity_consumed: { value: null, reason: "not_recorded: discards are counted per cycle but not aggregated, and consumption is only enforced by construction" },
  backoff_state: { value: null, reason: "needs_phase_5: GitHub rate-limit back-off is not persisted in the ledger" },
};

/** SQL form of CODE: anything else groups as 'other' before LIMIT, so odd values cannot crowd real codes out of the cap. */
const sqlCode = (col: string): string =>
  `CASE WHEN typeof(${col})='text' AND length(${col}) BETWEEN 1 AND 64 AND ${col} GLOB '[a-z]*' AND NOT ${col} GLOB '*[^a-z0-9_:.-]*' THEN ${col} ELSE 'other' END`;
const safeCode = (v: unknown): string => typeof v === "string" && CODE.test(v) ? v : "other";
/** Merge groups whose key failed validation (or repeated after capping) into "other". */
function fold<T extends { count: number }>(rows: T[], keyOf: (r: T) => string, make: (key: string, count: number) => T): T[] {
  const acc = new Map<string, number>();
  for (const r of rows) acc.set(keyOf(r), (acc.get(keyOf(r)) ?? 0) + r.count);
  return [...acc.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, GROUP_CAP).map(([k, c]) => make(k, c));
}
const hasTable = (db: Database.Database, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;

export function computeBridgeStats(db: Database.Database, nowMs: number, windowMs = BRIDGE_WINDOW_MS): BridgeStats {
  const cutoff = nowMs - windowMs;
  const empty: BridgeStats = {
    available: false, generated_at_ms: nowMs, window_ms: windowMs,
    chains: { total: 0, by_mode_state: [], awaiting_decision_by_reason: [], open_past_deadline: 0, rounds_over_grant: 0 },
    shadow_decisions: { total_by_action: [], window_by_action: [] },
    reconciliation: { window_observation_cycles: 0, window_read_failed: 0, window_read_failed_ratio: null, read_failed_by_code: [], last_event_at_ms: null, window_truncated: false },
    live: { reservations_by_state: [], intents_by_kind_state: [] },
    deferred: DEFERRED,
  };
  if (!["engineering_revision_chains", "engineering_revision_chain_events", "engineering_shadow_decisions", "engineering_revision_reservations", "engineering_publication_intents"].every(t => hasTable(db, t))) return empty;

  const modeState = db.prepare("SELECT mode,state,COUNT(*) AS count FROM engineering_revision_chains GROUP BY mode,state ORDER BY mode,state").all() as Array<{ mode: string; state: string; count: number }>;
  const reasons = db.prepare(`SELECT mode,${sqlCode('stop_reason')} AS reason,COUNT(*) AS count FROM engineering_revision_chains WHERE state='awaiting_decision' GROUP BY mode,2 ORDER BY count DESC LIMIT ?`).all(GROUP_CAP) as Array<{ mode: string; reason: string; count: number }>;
  const pastDeadline = (db.prepare("SELECT COUNT(*) AS n FROM engineering_revision_chains WHERE state NOT IN ('closed','awaiting_decision','ready_for_human') AND review_deadline IS NOT NULL AND review_deadline<?").get(nowMs) as { n: number }).n;
  const overGrant = (db.prepare("SELECT COUNT(*) AS n FROM engineering_revision_chains WHERE mode='live' AND json_valid(grant_json) AND rounds_used>COALESCE(json_extract(grant_json,'$.rounds'),0)").get() as { n: number }).n;

  const decisions = db.prepare("SELECT action,COUNT(*) AS total,SUM(CASE WHEN observed_at>=? THEN 1 ELSE 0 END) AS win FROM engineering_shadow_decisions GROUP BY action ORDER BY action").all(cutoff) as Array<{ action: string; total: number; win: number }>;

  // Events: the newest BRIDGE_EVENT_SCAN_CAP rows by primary key (seq is monotonic), filtered to the window.
  const maxSeq = (db.prepare("SELECT COALESCE(MAX(seq),0) AS m FROM engineering_revision_chain_events").get() as { m: number }).m;
  const floor = Math.max(0, maxSeq - BRIDGE_EVENT_SCAN_CAP);
  // One complete reconciler cycle writes one observation_cycle carrying `observed_at`; the store's own would_reserve event (no
  // `observed_at`) is part of the same cycle and is not counted again.
  const kinds = db.prepare(`SELECT kind,COUNT(*) AS count,MAX(created_at) AS last FROM engineering_revision_chain_events WHERE seq>? AND created_at>=?
    AND (kind='read_failed' OR (kind='observation_cycle' AND json_valid(payload_json) AND json_type(payload_json,'$.observed_at')='integer')) GROUP BY kind`).all(floor, cutoff) as Array<{ kind: string; count: number; last: number }>;
  const failedByCode = db.prepare(`SELECT CASE WHEN json_valid(payload_json) AND json_extract(payload_json,'$.code') IN (${READ_FAILED_CODES.map(c => `'${c}'`).join(",")}) THEN json_extract(payload_json,'$.code') ELSE 'other' END AS code,COUNT(*) AS count
    FROM engineering_revision_chain_events WHERE seq>? AND created_at>=? AND kind='read_failed' GROUP BY 1 ORDER BY count DESC LIMIT ?`).all(floor, cutoff, GROUP_CAP) as Array<{ code: string | null; count: number }>;
  const lastEvent = (db.prepare("SELECT MAX(created_at) AS t FROM engineering_revision_chain_events WHERE seq>?").get(floor) as { t: number | null }).t;
  // The newest row left out of the scan: if it is still inside the window, older in-window rows may exist.
  const excluded = floor > 0 ? db.prepare("SELECT created_at FROM engineering_revision_chain_events WHERE seq=?").get(floor) as { created_at: number } | undefined : undefined;
  const cycles = kinds.find(k => k.kind === "observation_cycle")?.count ?? 0;
  const failed = kinds.find(k => k.kind === "read_failed")?.count ?? 0;

  const reservations = db.prepare("SELECT state,COUNT(*) AS count FROM engineering_revision_reservations GROUP BY state").all() as Array<{ state: string; count: number }>;
  const intents = db.prepare("SELECT kind,state,COUNT(*) AS count FROM engineering_publication_intents GROUP BY kind,state").all() as Array<{ kind: string; state: string; count: number }>;

  return {
    available: true, generated_at_ms: nowMs, window_ms: windowMs,
    chains: {
      total: modeState.reduce((s, r) => s + r.count, 0),
      by_mode_state: modeState.map(r => ({ mode: safeCode(r.mode), state: safeCode(r.state), count: r.count })),
      awaiting_decision_by_reason: fold(reasons.map(r => ({ mode: safeCode(r.mode), reason: safeCode(r.reason), count: r.count })), r => `${r.mode}\u0000${r.reason}`,
        (k, count) => { const [mode, reason] = k.split("\u0000"); return { mode: mode!, reason: reason!, count }; }),
      open_past_deadline: pastDeadline, rounds_over_grant: overGrant,
    },
    shadow_decisions: {
      total_by_action: decisions.map(d => ({ action: safeCode(d.action), count: d.total })),
      window_by_action: decisions.filter(d => d.win > 0).map(d => ({ action: safeCode(d.action), count: d.win })),
    },
    reconciliation: {
      window_observation_cycles: cycles, window_read_failed: failed,
      window_read_failed_ratio: cycles + failed === 0 ? null : failed / (cycles + failed),
      read_failed_by_code: fold(failedByCode.map(r => ({ code: READ_FAILED(r.code) ?? "other", count: r.count })), r => r.code, (code, count) => ({ code, count })),
      last_event_at_ms: lastEvent,
      window_truncated: excluded !== undefined && excluded.created_at >= cutoff,
    },
    live: {
      reservations_by_state: reservations.map(r => ({ state: safeCode(r.state), count: r.count })),
      intents_by_kind_state: intents.map(r => ({ kind: safeCode(r.kind), state: safeCode(r.state), count: r.count })),
    },
    deferred: DEFERRED,
  };
}
