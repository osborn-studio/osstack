import { realpathSync, statSync } from "node:fs";
import type Database from "better-sqlite3";

export type AttentionDashboardService = "running" | "disabled" | "unavailable";
export interface AttentionDashboardCounts {
  scopes: number;
  subjects: number;
  unmonitored_subjects: number;
  human_waits: number;
  system_waits: number;
  unknown_waits: number;
  items: number;
  other_items: number;
  open_items: number;
  pending_answers: number;
  uncertain_answers: number;
  missing_source_items: number;
  applied_answers: number;
  dead_letters: number;
}
export interface AttentionDashboardScope extends Omit<AttentionDashboardCounts, "scopes"> {
  scope_id: string;
  task_id: string;
  task_title: string;
  repo_path: string;
  sampled_at_ms: number;
  coverage: "covered" | "degraded" | "stale" | "unknown";
  reason: string | null;
}
export interface AttentionDashboard {
  status: "available" | "degraded" | "stale" | "disabled" | "unavailable" | "not_watched";
  reason: string | null;
  scope_filter: "workspace" | "local_overview";
  workspace_path: string | null;
  tenant: "default";
  sampled_at_ms: number;
  consistency: "attention_block_transaction";
  totals: AttentionDashboardCounts | null;
  scopes: AttentionDashboardScope[];
  returned: number;
  truncated: boolean;
  next_after: string | null;
  limitations: string[];
}
export interface AttentionDashboardOptions {
  workspacePath?: string;
  service: AttentionDashboardService;
  nowMs?: number;
  after?: string;
  limit?: number;
}

const countKeys = ["subjects", "unmonitored_subjects", "human_waits", "system_waits", "unknown_waits", "items", "other_items", "open_items", "pending_answers", "uncertain_answers", "missing_source_items", "applied_answers", "dead_letters"] as const;

/** An independent read transaction. Does not claim whole-dashboard consistency,
 * inspect processes, migrate/open a DB, mark seen, or acquire observation ownership. */
export function readAttentionDashboard(db: Database.Database, options: AttentionDashboardOptions): AttentionDashboard {
  const now = options.nowMs ?? Date.now();
  const limit = options.limit ?? 25;
  const after = options.after ?? "";
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isFinite(now)
    || (after !== "" && !/^[a-f0-9]{64}$/.test(after))) throw new Error("invalid_attention_page");
  const result: AttentionDashboard = {
    status: "unavailable", reason: null,
    scope_filter: options.workspacePath === undefined ? "local_overview" : "workspace",
    workspace_path: null, tenant: "default", sampled_at_ms: now,
    consistency: "attention_block_transaction", totals: null, scopes: [], returned: 0, truncated: false, next_after: null,
    limitations: ["Observation only; no execution or approval authority", "Counts are persisted facts, not proof of process liveness or task completion", "Unmonitored counts include only discovered subjects in registered scopes", "Only the Attention block shares a read transaction"],
  };
  if (options.workspacePath !== undefined) {
    try {
      result.workspace_path = realpathSync(options.workspacePath);
      if (!statSync(result.workspace_path).isDirectory()) throw new Error("not_directory");
    } catch { return { ...result, reason: "workspace_unavailable" }; }
  }
  if (options.service !== "running") return { ...result, status: options.service, reason: "observer_" + options.service };
  try {
    return db.transaction(() => {
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name));
      if (!["tasks", "daemon_owner", "attention_scopes", "attention_subjects", "attention_items", "attention_deliveries"].every(t => tables.has(t)))
        return { ...result, reason: "schema_unavailable" };
      const owner = db.prepare("SELECT generation FROM daemon_owner WHERE singleton=1").get() as { generation: number } | undefined;
      if (!owner) return { ...result, reason: "owner_unavailable" };
      // The SAME filtered relation feeds counts and paged rows. Missing task and
      // non-default tenant scopes are excluded; filesystem canonicalization precedes SQL.
      const query = `WITH filtered AS (
        SELECT s.*,t.title AS task_title FROM attention_scopes s JOIN tasks t ON t.task_id=s.task_id
        WHERE t.tenant_id IS NULL AND (@repo IS NULL OR s.repo_path=@repo)
      ), subject_counts AS (
        SELECT u.scope_id,COUNT(*) AS subjects,SUM(CASE WHEN admitted=1 THEN 0 ELSE 1 END) AS unmonitored_subjects,
          SUM(CASE WHEN admitted<>1 THEN 0 WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.wait.owner')='human' ELSE 0 END) AS human_waits,
          SUM(CASE WHEN admitted<>1 THEN 0 WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.wait.owner')='system' ELSE 0 END) AS system_waits,
          SUM(CASE WHEN admitted<>1 THEN 0 WHEN json_valid(payload_json) THEN COALESCE(json_extract(payload_json,'$.wait.owner'),'unknown') NOT IN ('human','system','none') ELSE 1 END) AS unknown_waits,
          SUM(CASE WHEN u.sampled_at<@cutoff OR u.sampled_at>@now OR u.generation<>@generation OR NOT json_valid(payload_json) THEN 1
            WHEN COALESCE(json_extract(payload_json,'$.reason'),'snapshot_only')<>'snapshot_only' OR json_extract(payload_json,'$.gap')='history_gap' THEN 1 ELSE 0 END) AS faulty_subjects
        FROM attention_subjects u JOIN filtered f ON f.scope_id=u.scope_id GROUP BY u.scope_id
      ), item_counts AS (
        SELECT i.scope_id,COUNT(*) AS items,SUM(state NOT IN ('open','answer_reserved','answer_uncertain','source_missing','answer_applied')) AS other_items,SUM(state='open') AS open_items,SUM(state='answer_reserved') AS pending_answers,
          SUM(state='answer_uncertain') AS uncertain_answers,SUM(state='source_missing') AS missing_source_items,
          SUM(state='answer_applied') AS applied_answers
        FROM attention_items i JOIN filtered f ON f.scope_id=i.scope_id GROUP BY i.scope_id
      ), delivery_counts AS (
        SELECT d.scope_id,SUM(state='dead_letter') AS dead_letters FROM attention_deliveries d JOIN filtered f ON f.scope_id=d.scope_id GROUP BY d.scope_id
      ), stats AS (
        SELECT f.*,${countKeys.map(key => `COALESCE(${key},0) AS ${key}`).join(",")},
          CASE WHEN f.sampled_at>@now THEN 'unknown'
            WHEN f.generation<>@generation OR f.deadline<@now THEN 'stale'
            WHEN f.scan_complete<>1 OR f.error IS NOT NULL OR COALESCE(unmonitored_subjects,0)>0 OR COALESCE(faulty_subjects,0)>0 THEN 'degraded'
            ELSE 'covered' END AS coverage,
          CASE WHEN f.sampled_at>@now THEN 'clock_moved_backwards'
            WHEN f.generation<>@generation THEN 'owner_changed' WHEN f.deadline<@now THEN 'scan_expired'
            WHEN f.scan_complete<>1 THEN 'scan_incomplete' WHEN f.error IS NOT NULL THEN 'scan_failed'
            WHEN COALESCE(unmonitored_subjects,0)>0 THEN 'unmonitored_subjects'
            WHEN COALESCE(faulty_subjects,0)>0 THEN 'source_gap_or_error' ELSE NULL END AS reason
        FROM filtered f LEFT JOIN subject_counts USING(scope_id) LEFT JOIN item_counts USING(scope_id) LEFT JOIN delivery_counts USING(scope_id)
      ) `;
      const params = { repo: result.workspace_path, now, cutoff: now - 65_000, generation: owner.generation };
      const aggregate = db.prepare(query + `SELECT COUNT(*) AS scopes,${countKeys.map(k => `COALESCE(SUM(${k}),0) AS ${k}`).join(",")},
        COALESCE(SUM(coverage IN ('stale','unknown')),0) AS stale_scopes,COALESCE(SUM(coverage='degraded'),0) AS degraded_scopes FROM stats`).get(params) as AttentionDashboardCounts & { stale_scopes: number; degraded_scopes: number };
      const { stale_scopes, degraded_scopes, ...totals } = aggregate;
      const rows = db.prepare(query + `SELECT scope_id,task_id,task_title,repo_path,sampled_at AS sampled_at_ms,coverage,reason,${countKeys.join(",")} FROM stats WHERE scope_id>@after ORDER BY scope_id LIMIT @limit`).all({ ...params, after, limit: limit + 1 }) as AttentionDashboardScope[];
      const scopes = rows.slice(0, limit);
      return { ...result, status: totals.scopes === 0 ? "not_watched" : stale_scopes ? "stale" : degraded_scopes ? "degraded" : "available",
        reason: totals.scopes === 0 ? "no_registered_scope" : stale_scopes ? "stale_observation" : degraded_scopes ? "incomplete_coverage" : null,
        totals, scopes, returned: scopes.length, truncated: rows.length > limit,
        next_after: rows.length > limit ? scopes.at(-1)!.scope_id : null } as AttentionDashboard;
    })();
  } catch {
    // Bad/missing columns, malformed legacy data, busy/read failures all make
    // this block unavailable. Never turn failed observation into a healthy zero.
    return { ...result, reason: "source_unavailable" };
  }
}

/** Display-only: strip terminal escapes and control/bidi characters. Never use
 * display-cleaned strings as identities, paths, or executable command arguments. */
export function attentionDisplayText(value: unknown): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: remove untrusted terminal control sequences
  return String(value ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: transport controls must not reach a terminal
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, " ");
}
