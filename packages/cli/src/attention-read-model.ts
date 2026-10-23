import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { AttentionStatus, SessionDecision, type AttentionSessionFact, type AttentionWait } from "@osstack/protocol";
import { assertDbAccessAllowed, defaultOsstackHome } from "./control-plane-guard.js";

export interface AttentionReadInput {
  dbPath: string; taskId: string; repoPath: string; defaultTenant: true;
  afterRun?: string; afterSession?: string;
}
export function attentionHash(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v !== null && typeof v === "object") return `{${Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
    return JSON.stringify(v);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function guardAttentionDatabase(path: string): string {
  if (!isAbsolute(path)) throw new Error("absolute_db_required");
  const dbPath = realpathSync(path);
  if (!statSync(dbPath).isFile()) throw new Error("regular_database_required");
  const checkoutRoot = dirname(realpathSync(fileURLToPath(import.meta.url)));
  const defaultPath = defaultOsstackHome(); const defaultHome = existsSync(defaultPath) ? realpathSync(defaultPath) : defaultPath;
  for (let home = dirname(dbPath); ; home = dirname(home)) {
    if (home === dirname(dbPath) || home === defaultHome || existsSync(join(home, "control-plane-reserved.json"))) {
      assertDbAccessAllowed({ checkoutRoot, osstackHome: home });
    }
    if (dirname(home) === home) break;
  }
  return dbPath;
}
interface Row {
  session_id: string; run_id: string; state: string; version: number; repo_path: string;
  updated_at: number; turn_id: string | null; turn_state: string | null; decision_json: string | null;
}
/** Persistent facts only; accepted is not proof that a live process is still sending. */
export function readStoredWait(db: Database.Database, row: Row): AttentionWait {
  const pending = db.prepare(`SELECT message_id,state FROM session_messages WHERE session_id=? AND direction='inbound'
    AND state IN ('accepted','failed') ORDER BY created_at,message_id LIMIT 1`).get(row.session_id) as { message_id: string; state: string } | undefined;
  if (pending) return { reason: pending.state === "accepted" ? "accepted_in_flight_or_uncertain" : "delivery_failed", owner: "unknown", grant_id: null, message_id: pending.message_id };
  const grant = db.prepare(`SELECT grant_id,expected_turn_id,expected_version FROM session_continuation_grants
    WHERE session_id=? AND status='active' LIMIT 1`).get(row.session_id) as { grant_id: string; expected_turn_id: string; expected_version: number } | undefined;
  if (grant) return { reason: grant.expected_turn_id !== row.turn_id || grant.expected_version !== row.version ? "stale_grant" : "grant_coverage_unknown",
    owner: grant.expected_turn_id !== row.turn_id || grant.expected_version !== row.version ? "human" : "system", grant_id: grant.grant_id, message_id: null };
  return { reason: row.state === "awaiting_decision" ? "owner_decision" : row.state === "idle" ? "awaiting_instruction" : "none",
    owner: ["idle", "awaiting_decision"].includes(row.state) ? "human" : "none", grant_id: null, message_id: null };
}

export function readAttentionStatus(input: AttentionReadInput): AttentionStatus {
  if (!input.taskId || input.taskId.length > 512 || !input.defaultTenant || !isAbsolute(input.repoPath)) throw new Error("explicit_scope_required");
  const repoPath = realpathSync(input.repoPath);
  if (!statSync(repoPath).isDirectory()) throw new Error("repository_directory_required");
  const dbPath = guardAttentionDatabase(input.dbPath);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    return db.transaction(() => {
      const schema = db.pragma("user_version", { simple: true });
      if (schema !== 24) throw new Error("unsupported_schema");
      const task = db.prepare("SELECT task_id FROM tasks WHERE task_id=? AND tenant_id IS NULL").get(input.taskId);
      if (!task) throw new Error("task_not_found_in_scope");
      const runs = db.prepare(`SELECT r.run_id,r.phase,r.outcome FROM runs r JOIN tasks t ON r.task_id=t.task_id
        WHERE r.task_id=? AND t.tenant_id IS NULL AND r.tenant_id IS NULL AND r.run_id>? ORDER BY r.run_id LIMIT 101`)
        .all(input.taskId, input.afterRun ?? "") as { run_id: string; phase: string; outcome: string | null }[];
      const rows = db.prepare(`SELECT s.session_id,s.run_id,s.state,s.version,s.repo_path,s.updated_at,
        st.turn_id,st.state AS turn_state,st.decision_json FROM agent_sessions s
        JOIN tasks t ON s.task_id=t.task_id JOIN runs r ON s.run_id=r.run_id AND r.task_id=s.task_id
        LEFT JOIN session_turns st ON st.session_id=s.session_id AND st.ordinal=(SELECT MAX(ordinal) FROM session_turns WHERE session_id=s.session_id)
        WHERE s.task_id=? AND t.tenant_id IS NULL AND r.tenant_id IS NULL AND s.session_id>?
        ORDER BY s.session_id LIMIT 101`).all(input.taskId, input.afterSession ?? "") as Row[];
      const limitations = ["loop_unsupported_in_slice_0", "live_process_state_unknown", "latest_turn_not_complete_history", "run_repository_unverified"];
      const sessions: AttentionSessionFact[] = []; let omitted = 0;
      for (const row of rows.slice(0, 100)) {
        let bound = false;
        try { bound = isAbsolute(row.repo_path) && realpathSync(row.repo_path) === repoPath; } catch { /* disclose below */ }
        if (!bound) { omitted++; continue; }
        let decision: AttentionSessionFact["decision"] = null;
        if (row.decision_json !== null) {
          try {
            if (row.decision_json.length > 16384) throw new Error("oversized");
            decision = SessionDecision.parse(JSON.parse(row.decision_json));
          } catch { limitations.push(`invalid_decision:${row.session_id}`); }
        }
        sessions.push({ session_id: row.session_id, run_id: row.run_id, state: row.state, version: row.version,
          turn_id: row.turn_id, turn_state: row.turn_state, decision, decision_hash: decision ? attentionHash(decision) : null,
          process_liveness: "unknown", wait: readStoredWait(db, row), updated_at: row.updated_at });
      }
      return AttentionStatus.parse({ schema_version: 1, mode: "snapshot_only",
        scope: { scope_id: attentionHash([dbPath, input.taskId, null]), task_id: input.taskId, tenant_id: null, repo_path: repoPath },
        sampled_at_ms: Date.now(), coverage: { state: "not_monitored" },
        runs: runs.slice(0, 100).map((r) => ({ ...r, repo_binding: "unverified" })), sessions,
        completeness: { latest_turn_only: true, truncated: runs.length > 100 || rows.length > 100, omitted_binding_unknown: omitted,
          next_after: { run: runs.length > 100 ? runs[99]!.run_id : null, session: rows.length > 100 ? rows[99]!.session_id : null } }, limitations });
    })();
  } catch (error) {
    if (error instanceof Database.SqliteError) throw new Error(`unsupported_source: ${error.code}`);
    throw error;
  } finally { db.close(); }
}
