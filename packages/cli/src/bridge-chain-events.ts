// Read-only, allow-listed view of shadow revision-chain events for `mission status --json` (bridge observability).
// A payload is never passed through: each field is copied only when it matches a fixed shape (a code, a hex object id,
// a small integer), so a body, a login, a URL or any free text that reached an event cannot reach the output.
import type Database from "better-sqlite3";

export const STATUS_EVENTS = 10;
const MAX_DISCARDS = 10;
const CODE = /^[a-z][a-z0-9_:.-]{0,63}$/u;
const OID = /^[0-9a-f]{40,64}$/u;

export interface ChainEventView {
  seq: number; kind: string; created_at: number;
  payload: Record<string, string | number | Array<number | { review_id: number; reason: string }>>;
}
export const EVENTS_TOTAL_CAP = 10_000;
export interface ChainEventsView { total: number; total_capped: boolean; latest: ChainEventView[] }

/** Closed vocabularies for the fields whose domain is fixed today. `reason` / `stop_reason` stay an open (but shape-checked)
 * vocabulary because phase 5 adds live stop reasons; they are written by osstack from literals, never from GitHub text. */
const oneOf = (...values: string[]) => { const set: ReadonlySet<string> = new Set(values); return (v: unknown): string | undefined => typeof v === "string" && set.has(v) ? v : undefined; };
export const READ_FAILED_CODES = ["request_cap", "request_failed", "graphql_errors", "malformed_response", "pull_request_not_found", "moved_during_read", "page_cap",
  "unexpected_error", "normalize_failed", "decide_failed", "second_read_failed"] as const;
export const READ_FAILED = oneOf(...READ_FAILED_CODES);
const CHAIN_STATE = oneOf("awaiting_review", "revision_reserved", "revising", "publishing", "ready_for_human", "closed", "awaiting_decision");
const PR_STATE = oneOf("OPEN", "MERGED", "CLOSED");
const DECISION = oneOf("none", "transition", "stop", "reserve", "would_reserve");
const ACTION = oneOf("would_reserve", "would_mark_ready", "would_stop");
const EVENT_KIND = oneOf("chain_created", "observation_cycle", "read_failed", "transition");
const int = (v: unknown): number | undefined => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
const code = (v: unknown): string | undefined => typeof v === "string" && CODE.test(v) ? v : undefined;
const oid = (v: unknown): string | undefined => typeof v === "string" && OID.test(v) ? v : undefined;

/** Discards are `{review_id, reason}` in a decision event and `"<id>:<reason>"` in an observation cycle. */
function discardsOf(v: unknown): Array<{ review_id: number; reason: string }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ review_id: number; reason: string }> = [];
  for (const item of v) {
    if (out.length >= MAX_DISCARDS) break;
    if (typeof item === "string") {
      const m = /^([0-9]{1,15}):([a-z][a-z0-9_:.-]{0,63})$/u.exec(item);
      if (m) out.push({ review_id: Number(m[1]), reason: m[2]! });
    } else if (item && typeof item === "object") {
      const r = item as Record<string, unknown>; const id = int(r["review_id"]); const reason = code(r["reason"]);
      if (id !== undefined && reason) out.push({ review_id: id, reason });
    }
  }
  return out;
}

const FIELDS: Record<string, Record<string, (v: unknown) => unknown>> = {
  chain_created: { pr_number: int, head: oid, base: oid },
  read_failed: { code: READ_FAILED },
  transition: { from: CHAIN_STATE, to: CHAIN_STATE, reason: code, head: oid, base: oid, stop_reason: code },
  observation_cycle: { observed_at: int, pr_state: PR_STATE, head: oid, base: oid, reviews: int, decision: DECISION, reason: code, to: CHAIN_STATE, action: ACTION },
};

/** Exported for tests: project one stored payload onto its allow-list. Unknown kinds and unparsable payloads give `{}`. */
export function safeEventPayload(kind: string, payloadJson: string): ChainEventView["payload"] {
  const spec = FIELDS[kind];
  if (!spec) return {};
  let raw: unknown;
  try { raw = JSON.parse(payloadJson); } catch { return {}; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>; const out: ChainEventView["payload"] = {};
  for (const [key, check] of Object.entries(spec)) { const v = check(r[key]); if (v !== undefined) out[key] = v as string | number; }
  if (kind === "observation_cycle" || kind === "transition") {
    const d = discardsOf(r["discards"]); if (d.length > 0) out["discards"] = d;
  }
  if (Array.isArray(r["review_ids"])) {
    const ids = r["review_ids"].filter((x): x is number => int(x) !== undefined).slice(0, MAX_DISCARDS); if (ids.length > 0) out["review_ids"] = ids;
  }
  return out;
}

/** The latest `limit` events of a chain, oldest first, plus the total count. Two bounded SELECTs; never writes. */
export function chainEventsView(db: Database.Database, chainId: string, limit = STATUS_EVENTS): ChainEventsView {
  const rows = db.prepare("SELECT seq,kind,payload_json,created_at FROM engineering_revision_chain_events WHERE chain_id=? ORDER BY seq DESC LIMIT ?")
    .all(chainId, limit) as Array<{ seq: number; kind: string; payload_json: string; created_at: number }>;
  // Capped count: the index range for one chain grows with every cycle, and `mission status` must stay cheap.
  const total = (db.prepare("SELECT COUNT(*) AS n FROM (SELECT 1 FROM engineering_revision_chain_events WHERE chain_id=? LIMIT ?)").get(chainId, EVENTS_TOTAL_CAP) as { n: number }).n;
  return { total, total_capped: total >= EVENTS_TOTAL_CAP, latest: rows.reverse().map(r => ({ seq: r.seq, kind: EVENT_KIND(r.kind) ?? "other", created_at: r.created_at, payload: safeEventPayload(r.kind, r.payload_json) })) };
}
