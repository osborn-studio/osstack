import { realpathSync } from "node:fs";
import { AgentSessionState } from "./schema.js";
import { attentionDigest, type AttentionOwner, type AttentionStore } from "./attention-store.js";
interface EvidencePage<T> { total: number; truncated: boolean; rows: T[] }
interface MessageEvidence { message_id: string; turn_id: string; state: string; disposition: string | null }
interface ActionEvidence { action_id: string; item_id: string; message_id: string; state: string }
interface GrantEvidence { attempt_id: string; grant_id: string; status: string; message_id: string | null }
export interface AttentionRecoverySubject {
  kind: string; subject_id: string | null; source_version: number; owner_generation: number;
  state: "unknown" | "pending_human" | "observed"; missing_evidence: string[]; next_step: string; canAutoRetry: false;
  messages?: EvidencePage<MessageEvidence>; actions?: EvidencePage<ActionEvidence>; grant_attempts?: EvidencePage<GrantEvidence>;
  retained_run_cursor?: { last_seq: number; through_seq: number; gap: string | null };
}
export interface AttentionRecoveryRequest { scope_id: string; after?: string; limit?: number }
interface Subject { cursor: number; kind: string; subject_id: string | null; source_version: number; binding_hash: string; generation: number; sampled_at: number }
/** Read-only diagnostic projection. It neither retries nor treats unknown as proof of termination. */
export function readAttentionRecovery(store: AttentionStore, owner: AttentionOwner, request: AttentionRecoveryRequest, now = Date.now()) {
  const limit = request.limit ?? 20; const after = request.after ?? "0";
  if (!/^[a-f0-9]{64}$/.test(request.scope_id) || !Number.isSafeInteger(limit) || limit < 1 || limit > 25 || typeof after !== "string" || !/^[0-9]{1,16}$/.test(after) || !Number.isSafeInteger(Number(after)) || !Number.isFinite(now)) throw Error("invalid_recovery_request");
  return store.db.transaction(() => {
    store.assertOwner(owner);
    const scope = store.getScope(request.scope_id);
    const task = scope ? store.db.prepare("SELECT created_at FROM tasks WHERE task_id=? AND tenant_id IS NULL").get(scope.task_id) as { created_at: number } | undefined : undefined;
    if (!scope || !task || attentionDigest([owner.home_id, scope.task_id, scope.repo_path, task.created_at]) !== scope.scope_id) throw Error("scope_unavailable");
    const total = (store.db.prepare("SELECT COUNT(*) n FROM attention_subjects WHERE scope_id=? AND admitted=1").get(scope.scope_id) as { n: number }).n;
    const rows = store.db.prepare("SELECT rowid cursor,kind,CASE WHEN length(subject_id)<=4096 THEN subject_id ELSE NULL END subject_id,source_version,binding_hash,generation,sampled_at FROM attention_subjects WHERE scope_id=? AND admitted=1 AND rowid>? ORDER BY rowid LIMIT ?").all(scope.scope_id, Number(after), limit + 1) as Subject[];
    const subjects = rows.slice(0, limit).map((subject): AttentionRecoverySubject => {
      const base: AttentionRecoverySubject = { kind: subject.kind, subject_id: subject.subject_id, source_version: subject.source_version, owner_generation: subject.generation,
        state: "unknown", missing_evidence: ["source_binding"], next_step: "inspect_source", canAutoRetry: false };
      if (subject.subject_id === null) return { ...base, missing_evidence: ["invalid_source_identity"] };
      const readSubject = (): AttentionRecoverySubject => {
      if (scope.generation !== owner.generation || scope.error || now < scope.sampled_at || now > scope.deadline
        || subject.generation !== owner.generation || now < subject.sampled_at || now - subject.sampled_at > 65000) return { ...base, missing_evidence: ["fresh_observation"] };
      if (subject.kind === "run") {
        const run = store.db.prepare("SELECT run_id,task_id,session_id,agent_id,capability_id,started_at FROM runs WHERE run_id=? AND task_id=? AND tenant_id IS NULL").get(subject.subject_id, scope.task_id) as { run_id: string; task_id: string; session_id: string; agent_id: string; capability_id: string; started_at: number } | undefined;
        const cursor = store.db.prepare("SELECT binding_hash,last_seq,through_seq,gap FROM attention_run_cursors WHERE scope_id=? AND run_id=?").get(scope.scope_id, subject.subject_id) as { binding_hash: string; last_seq: number; through_seq: number; gap: string | null } | undefined;
        if (!run || subject.binding_hash !== attentionDigest([scope.scope_id, "run", run.run_id]) || !cursor
          || cursor.binding_hash !== attentionDigest([owner.home_id, scope.scope_id, run.run_id, run.task_id, run.session_id, run.agent_id, run.capability_id, run.started_at])) return base;
        return { ...base, missing_evidence: ["process_termination", ...(cursor.gap ? ["retained_history_integrity"] : [])], next_step: "inspect_run_authority",
          retained_run_cursor: { last_seq: cursor.last_seq, through_seq: cursor.through_seq, gap: cursor.gap ? "history_gap" : null } };
      }
      if (subject.kind !== "session") return { ...base, missing_evidence: ["trusted_host_adapter"], next_step: "inspect_existing_host_recovery" };
      const session = store.db.prepare(`SELECT s.session_id,s.run_id,s.request_sha256,s.agent_id,s.repo_path,s.version,s.state FROM agent_sessions s
        JOIN runs r ON r.run_id=s.run_id AND r.task_id=s.task_id AND r.session_id=s.session_id AND r.agent_id=s.agent_id AND r.tenant_id IS NULL
        WHERE s.session_id=? AND s.task_id=?`).get(subject.subject_id, scope.task_id) as { session_id: string; run_id: string; request_sha256: string; agent_id: string; repo_path: string; version: number; state: string } | undefined;
      if (!session || !AgentSessionState.safeParse(session.state).success || session.version !== subject.source_version || attentionDigest([session.session_id, session.run_id, session.request_sha256, session.agent_id, session.repo_path]) !== subject.binding_hash) return base;
      try { if (realpathSync(session.repo_path) !== scope.repo_path) return base; } catch { return base; }
      const page = <T>(sql: string, countSql: string, params: string[]): EvidencePage<T> => {
        const found = store.db.prepare(sql).all(...params) as T[];
        if (found.some(row => Object.values(row as Record<string, unknown>).some(value => typeof value === "string" && value.length > 4096))) throw Error("oversized_evidence_identity");
        const count = (store.db.prepare(countSql).get(...params) as { n: number }).n;
        return { total: count, truncated: count > 20, rows: found.slice(0,20) };
      };
      const messages = page<MessageEvidence>(`SELECT substr(m.message_id,1,4097) message_id,substr(m.turn_id,1,4097) turn_id,m.state,r.disposition FROM session_messages m LEFT JOIN attention_receipt_resolutions r
        ON r.message_id=m.message_id AND r.session_id=m.session_id WHERE m.session_id=? AND m.direction='inbound' ORDER BY m.created_at,m.message_id LIMIT 20`,
        "SELECT COUNT(*) n FROM session_messages WHERE session_id=? AND direction='inbound'", [session.session_id]);
      const actions = page<ActionEvidence>(`SELECT substr(a.action_id,1,4097) action_id,substr(a.item_id,1,4097) item_id,substr(a.message_id,1,4097) message_id,substr(a.state,1,65) state FROM attention_actions a JOIN attention_items i ON i.item_id=a.item_id AND i.scope_id=a.scope_id
        JOIN session_messages m ON m.message_id=a.message_id AND m.session_id=i.session_id AND m.turn_id=i.turn_id WHERE a.scope_id=? AND i.session_id=? ORDER BY a.created_at,a.action_id LIMIT 20`,
        `SELECT COUNT(*) n FROM attention_actions a JOIN attention_items i ON i.item_id=a.item_id AND i.scope_id=a.scope_id
        JOIN session_messages m ON m.message_id=a.message_id AND m.session_id=i.session_id AND m.turn_id=i.turn_id WHERE a.scope_id=? AND i.session_id=?`, [scope.scope_id, session.session_id]);
      const grants = page<GrantEvidence>(`SELECT substr(a.attempt_id,1,4097) attempt_id,substr(a.grant_id,1,4097) grant_id,a.status,substr(a.message_id,1,4097) message_id FROM session_continuation_attempts a JOIN session_continuation_grants g ON g.grant_id=a.grant_id WHERE g.session_id=? ORDER BY a.created_at,a.attempt_id LIMIT 20`,
        "SELECT COUNT(*) n FROM session_continuation_attempts a JOIN session_continuation_grants g ON g.grant_id=a.grant_id WHERE g.session_id=?", [session.session_id]);
      const unresolved = store.db.prepare("SELECT 1 FROM session_messages WHERE session_id=? AND direction='inbound' AND state IN ('pending','accepted','failed') LIMIT 1").get(session.session_id);
      const activeGrant = store.db.prepare("SELECT 1 FROM session_continuation_attempts a JOIN session_continuation_grants g ON g.grant_id=a.grant_id WHERE g.session_id=? AND a.status IN ('checking','reserved') LIMIT 1").get(session.session_id);
      const missing = [...(unresolved ? ["terminal_receipt"] : []), ...(activeGrant ? ["continuation_receipt"] : [])];
      return { ...base, state: missing.length ? "unknown" : session.state === "awaiting_decision" ? "pending_human" : "observed", missing_evidence: missing,
        next_step: missing.length ? "inspect_existing_receipts" : session.state === "awaiting_decision" ? "answer_current_decision" : "inspect_source", messages, actions, grant_attempts: grants };
      };
      try { return readSubject(); } catch { return { ...base, missing_evidence: ["invalid_evidence"] }; }
    });
    return { scope_id: scope.scope_id, canAutoRetry: false as const, process_liveness: "unknown" as const, total, returned: subjects.length, truncated: rows.length > limit,
      next_after: rows.length > limit ? String(rows[limit - 1]!.cursor) : null, subjects };
  }).deferred();
}
