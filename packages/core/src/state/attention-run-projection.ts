import { attentionDigest, type AttentionOwner, type AttentionScope, type AttentionStore } from "./attention-store.js";
import { readRunEventPage, type BoundedRunEvent } from "./run-store.js";

interface Cursor {
  binding_hash: string;
  last_seq: number;
  through_seq: number;
  last_event_hash: string | null;
  gap: string | null;
  facts_json: string;
}
interface Run {
  run_id: string;
  task_id: string;
  session_id: string;
  agent_id: string;
  capability_id: string;
  started_at: number;
  phase: string;
  outcome: string | null;
  task_created_at: number;
}
interface Observed {
  observed_status: string | null;
  unsupported_events: number;
}
const statuses = new Set(["queued", "running", "awaiting_approval", "awaiting_clarify", "paused",
  "cancelling", "cancelled", "failed", "completed", "expired"]);
const informational = new Set(["token.delta", "reasoning.delta", "reasoning.done", "progress", "tool.started",
  "tool.updated", "tool.done", "title.updated", "usage.updated", "usage.final"]);
function hash(event: BoundedRunEvent): string {
  return attentionDigest([event.event_id, event.run_id, event.session_id, event.seq, event.type,
    event.created_at, event.terminal, event.payload_bytes, event.payload_json]);
}
function object(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function reduce(event: BoundedRunEvent, state: Observed, store: AttentionStore): string | null {
  if (event.payload_json === null) return "oversized_event_payload";
  if (!event.event_id || event.event_id.length > 4096 || !event.session_id || event.session_id.length > 4096
    || !event.type || event.type.length > 256 || !Number.isFinite(event.created_at)
    || ![0, 1].includes(event.terminal)) return "invalid_event_envelope";
  const payload = object(event.payload_json);
  if (!payload) return "invalid_event_payload";
  if (["status", "run.started", "done"].includes(event.type)) {
    if (typeof payload.status !== "string" || !statuses.has(payload.status)
      || (event.type === "run.started" && payload.status !== "running")
      || (event.type === "done" && (!event.terminal || !["completed", "failed", "cancelled", "expired"].includes(payload.status)
        || !Number.isSafeInteger(payload.last_seq) || (payload.last_seq as number) < 0 || (payload.last_seq as number) > event.seq)))
      return "invalid_event_payload";
    state.observed_status = payload.status;
  } else if (event.type.startsWith("approval.") || event.type.startsWith("clarify.")) {
    const approval = event.type.startsWith("approval.");
    const family = approval ? "approval" : "clarify";
    if (![`${family}.requested`, `${family}.resolved`].includes(event.type)) {
      state.unsupported_events++;
      return null;
    }
    const id = payload[`${family}_id`];
    if (typeof id !== "string" || !id || id.length > 4096) return "invalid_event_payload";
    // Authority stays with the original approval/clarify tables. Events never
    // grant permission or synthesize a Session answer/action.
    const table = approval ? "approvals" : "clarifies";
    const row = store.db.prepare(`SELECT status FROM ${table} WHERE ${family}_id=? AND run_id=?`)
      .get(id, event.run_id) as { status: string } | undefined;
    if (!row) return "authority_reference_missing";
    if (event.type.endsWith(".resolved") && (typeof payload.status !== "string"
      || !(approval ? ["accepted", "rejected", "timed_out"] : ["answered", "timed_out", "abandoned"]).includes(payload.status)))
      return "invalid_event_payload";
  } else if (event.type === "error") {
    if (typeof payload.code !== "string" || typeof payload.terminal !== "boolean") return "invalid_event_payload";
    if (payload.terminal) state.observed_status = "unknown";
  } else if (!informational.has(event.type)) state.unsupported_events++;
  return null;
}

/** One bounded retained-log page. Projection and cursor share the owner-fenced
 * transaction; it never invokes an adapter, resolves an approval, or pins history. */
export function projectAttentionRun(store: AttentionStore, owner: AttentionOwner,
  scope: AttentionScope, runId: string, now: number): void {
  if (!Number.isFinite(now)) throw new Error("invalid_clock");
  store.write(owner, () => {
    const persistedScope = store.getScope(scope.scope_id);
    if (!persistedScope || persistedScope.task_id !== scope.task_id || persistedScope.repo_path !== scope.repo_path)
      throw new Error("attention_scope_conflict");
    const subject = store.db.prepare("SELECT admitted,binding_hash FROM attention_subjects WHERE scope_id=? AND kind='run' AND subject_id=?")
      .get(scope.scope_id, runId) as { admitted: number; binding_hash: string } | undefined;
    if (!subject?.admitted) throw new Error("run_not_admitted");
    if (subject.binding_hash !== attentionDigest([scope.scope_id, "run", runId])) throw new Error("run_subject_binding_conflict");
    const task = store.db.prepare("SELECT created_at FROM tasks WHERE task_id=? AND tenant_id IS NULL")
      .get(scope.task_id) as { created_at: number } | undefined;
    if (!task || scope.scope_id !== attentionDigest([owner.home_id, scope.task_id, scope.repo_path, task.created_at]))
      throw new Error("attention_scope_conflict");
    const run = store.db.prepare(`SELECT r.*,t.created_at task_created_at FROM runs r JOIN tasks t ON t.task_id=r.task_id
      WHERE r.run_id=? AND r.task_id=? AND r.tenant_id IS NULL AND t.tenant_id IS NULL`).get(runId, scope.task_id) as Run | undefined;
    const saved = store.db.prepare("SELECT * FROM attention_run_cursors WHERE scope_id=? AND run_id=?")
      .get(scope.scope_id, runId) as Cursor | undefined;
    const writeSubject = (facts: Record<string, unknown>) => store.db.prepare(
      "UPDATE attention_subjects SET sampled_at=?,generation=?,payload_json=? WHERE scope_id=? AND kind='run' AND subject_id=?"
    ).run(now, owner.generation, JSON.stringify({ event_replay: { complete: false, caught_up: false,
      gap: facts.reason ?? "source_unavailable", completeness_scope: "unverified_retention" }, ...facts }), scope.scope_id, runId);
    const quarantine = (reason: string) => store.db.prepare(
      "UPDATE attention_run_cursors SET gap=COALESCE(gap,?),generation=?,updated_at=? WHERE scope_id=? AND run_id=?"
    ).run(reason, owner.generation, now, scope.scope_id, runId);
    if (!run) {
      quarantine("source_missing");
      writeSubject({ state: "source_missing", reason: "source_missing", process_liveness: "unknown", gap: "history_gap" });
      return;
    }
    const binding = attentionDigest([owner.home_id, scope.scope_id, run.run_id, run.task_id,
      run.session_id, run.agent_id, run.capability_id, run.started_at]);
    if (saved && saved.binding_hash !== binding) {
      quarantine("source_binding_conflict");
      writeSubject({ state: "unknown", reason: "source_binding_conflict", process_liveness: "unknown", gap: "history_gap" });
      return;
    }
    if (saved && (!Number.isSafeInteger(saved.last_seq) || saved.last_seq < -1
      || !Number.isSafeInteger(saved.through_seq) || saved.through_seq < -1)) throw new Error("invalid_event_cursor");
    let cursor = saved?.last_seq ?? -1;
    let anchor = saved?.last_event_hash ?? null;
    let gap = saved?.gap ?? null;
    const state: Observed = { observed_status: null, unsupported_events: 0 };
    const prior = saved ? object(saved.facts_json) : null;
    let priorValid = true;
    if (saved) {
      if (!prior || !(prior.observed_status === null || typeof prior.observed_status === "string")
        || !Number.isSafeInteger(prior.unsupported_events) || (prior.unsupported_events as number) < 0)
        { gap ??= "invalid_cursor_facts"; priorValid = false; }
      else { state.observed_status = prior.observed_status; state.unsupported_events = prior.unsupported_events as number; }
    }
    let anchorValid = true;
    if (cursor >= 0) {
      const previous = readRunEventPage(store.db, { taskId: scope.task_id, runId, afterSeq: cursor - 1, throughSeq: cursor, limit: 1 }).events[0];
      anchorValid = previous !== undefined && hash(previous) === anchor;
      if (!anchorValid) { gap ??= "event_anchor_changed"; state.observed_status = null; }
    }
    const page = readRunEventPage(store.db, { taskId: scope.task_id, runId, afterSeq: cursor, limit: 200,
      ...(saved && saved.through_seq > cursor ? { throughSeq: saved.through_seq } : {}) });
    if (page.sequenceGap) gap ??= "event_sequence_gap";
    if (anchorValid && priorValid) {
      for (const event of page.events) {
        if (event.seq !== cursor + 1) { gap ??= "event_sequence_gap"; break; }
        if (event.session_id !== run.session_id) { gap ??= "event_source_binding_conflict"; break; }
        const error = reduce(event, state, store);
        if (error) { gap ??= error; break; }
        cursor = event.seq;
        anchor = hash(event);
      }
    }
    const backlog = cursor < page.highWatermark || cursor < page.availableHighWatermark;
    const caughtUp = cursor >= 0 && !gap && !backlog && state.unsupported_events === 0;
    // A caught-up cursor verifies newly read rows and the last anchor only.
    // Mutable earlier rows are not continuously re-hashed; never certify history.
    const pending = (table: "approvals" | "clarifies", column: "approval_id" | "clarify_id") => {
      const rows = store.db.prepare(`SELECT ${column} id FROM ${table} WHERE run_id=? AND status='pending' ORDER BY ${column} LIMIT 21`)
        .all(runId) as { id: string }[];
      return { ids: rows.slice(0, 20).map((row) => row.id), truncated: rows.length > 20,
        count: (store.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE run_id=? AND status='pending'`).get(runId) as { n: number }).n };
    };
    store.db.prepare(`INSERT INTO attention_run_cursors(scope_id,run_id,binding_hash,last_seq,through_seq,last_event_hash,gap,facts_json,generation,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_id,run_id) DO UPDATE SET last_seq=excluded.last_seq,through_seq=excluded.through_seq,
      last_event_hash=excluded.last_event_hash,gap=excluded.gap,facts_json=excluded.facts_json,generation=excluded.generation,updated_at=excluded.updated_at`)
      .run(scope.scope_id, runId, binding, cursor, page.highWatermark, anchor, gap, priorValid ? JSON.stringify(state) : saved!.facts_json, owner.generation, now);
    writeSubject({ state: { phase: run.phase, outcome: run.outcome }, ...state,
      reason: gap ? "history_gap" : backlog ? "event_backlog" : state.unsupported_events > 0 ? "unsupported_event_type" : "snapshot_only",
      repo_binding: "unverified", process_liveness: "unknown", gap: gap ? "history_gap" : "retention_unverified",
      event_replay: { cursor, through_seq: page.highWatermark, complete: false, caught_up: caughtUp, gap, completeness_scope: "unverified_retention" },
      pending_approvals: pending("approvals", "approval_id"), pending_clarifies: pending("clarifies", "clarify_id"),
      limitations: ["No historical retention or processed-prefix integrity guarantee", "Event observations do not authorize execution"] });
  });
}
