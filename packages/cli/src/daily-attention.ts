import { realpath, stat } from "node:fs/promises";
import type Database from "better-sqlite3";
import { z } from "zod";
import { attentionDisplayText, readAttentionDashboard, type AttentionDashboard, type AttentionDashboardService } from "./attention-dashboard.js";

export type DailyAttentionReader = (request: { workspacePath: string; nowMs: number; limit: 100; signal: AbortSignal }) => unknown | Promise<unknown>;
export interface DailyAttentionRepo {
  repo_id: string;
  workspace_path: string | null;
  status: Exclude<AttentionDashboard["status"], "unavailable"> | "unknown";
  reason: string | null;
  snapshot: AttentionDashboard | null;
}
export interface DailyAttentionSummary {
  sampled_at_ms: number;
  tenant: "default";
  repos: DailyAttentionRepo[];
  omitted_repos: number;
}
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const counts = z.object({ subjects: count, unmonitored_subjects: count, human_waits: count, system_waits: count, unknown_waits: count, items: count, other_items: count, open_items: count, pending_answers: count, uncertain_answers: count, missing_source_items: count, applied_answers: count, dead_letters: count });
const text = z.string().max(4096);
const id = z.string().regex(/^[a-f0-9]{64}$/);
const dashboardSchema = z.object({
  status: z.enum(["available", "degraded", "stale", "disabled", "unavailable", "not_watched"]),
  reason: text.nullable(), scope_filter: z.literal("workspace"), workspace_path: text,
  tenant: z.literal("default"), sampled_at_ms: z.number().finite(), consistency: z.literal("attention_block_transaction"),
  totals: counts.extend({ scopes: count }).nullable(),
  scopes: z.array(counts.extend({ scope_id: id, task_id: text, task_title: text, repo_path: text, sampled_at_ms: z.number().finite(), coverage: z.enum(["covered", "degraded", "stale", "unknown"]), reason: text.nullable() })).max(100),
  returned: count, truncated: z.boolean(), next_after: id.nullable(), limitations: z.array(text).max(20),
});

/** Uses the caller's existing connection and current observer lifecycle; never opens a DB. */
export function createDailyAttentionReader(db: Database.Database, service: () => AttentionDashboardService): DailyAttentionReader {
  return request => {
    request.signal.throwIfAborted();
    return readAttentionDashboard(db, { workspacePath: request.workspacePath, service: service(), nowMs: request.nowMs, limit: request.limit });
  };
}

/** Bounded, read-only composition. No actor, seen, delivery, answer or resume capability is accepted. */
export async function readDailyAttention(
  entries: readonly { repo_id: string; path: string; enabled: boolean }[],
  options: { nowMs: number; reader?: DailyAttentionReader; signal?: AbortSignal; timeoutMs?: number; budgetMs?: number },
): Promise<DailyAttentionSummary> {
  const enabled = entries.filter(e => e.enabled);
  const selected = enabled.slice(0, 100);
  const deadline = performance.now() + Math.min(2000, Math.max(1, options.budgetMs ?? 2000));
  const repos: DailyAttentionRepo[] = selected.map(e => ({ repo_id: e.repo_id, workspace_path: null, status: "unknown", reason: "reader_unavailable", snapshot: null }));
  let next = 0;
  let persistedBytes = 0;
  async function worker() {
    while (next < selected.length) {
      const index = next++;
      const entry = selected[index]!;
      const result = repos[index]!;
      if (options.signal?.aborted) { result.reason = "cancelled"; continue; }
      if (!options.reader) continue;
      const remaining = deadline - performance.now();
      if (remaining <= 0) { result.reason = "budget_exhausted"; continue; }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        const failure = new Promise<never>((_, reject) => {
          abort = () => { controller.abort(); reject(new Error("cancelled")); };
          options.signal?.addEventListener("abort", abort, { once: true });
          timer = setTimeout(() => { controller.abort(); reject(new Error("read_timeout")); }, Math.min(remaining, Math.max(1, options.timeoutMs ?? 500)));
        });
        const read = async () => {
          let path: string;
          try {
            path = await realpath(entry.path);
            if (!(await stat(path)).isDirectory()) throw new Error("not_directory");
          } catch { throw new Error("workspace_unavailable"); }
          controller.signal.throwIfAborted();
          const raw = await options.reader!({ workspacePath: path, nowMs: options.nowMs, limit: 100, signal: controller.signal });
          controller.signal.throwIfAborted();
          const parsed = dashboardSchema.safeParse(raw);
          if (!parsed.success) throw new Error("invalid_snapshot");
          const snapshot = parsed.data;
          if (snapshot.workspace_path !== path || snapshot.scopes.some(s => s.repo_path !== path)
            || snapshot.returned !== snapshot.scopes.length || new Set(snapshot.scopes.map(s => s.scope_id)).size !== snapshot.scopes.length
            || (snapshot.totals !== null && snapshot.totals.scopes < snapshot.returned)
            || (snapshot.totals === null && (snapshot.scopes.length > 0 || snapshot.truncated))
            || (snapshot.totals !== null && !snapshot.truncated && snapshot.totals.scopes !== snapshot.returned)
            || (snapshot.truncated && (snapshot.totals === null || snapshot.totals.scopes <= snapshot.returned || snapshot.next_after !== snapshot.scopes.at(-1)?.scope_id))
            || (!snapshot.truncated && snapshot.next_after !== null)
            || (["disabled", "unavailable"].includes(snapshot.status) && snapshot.totals !== null)
            || (snapshot.status === "not_watched" && snapshot.totals?.scopes !== 0)
            || (["available", "degraded", "stale"].includes(snapshot.status) && !snapshot.totals?.scopes)) throw new Error("invalid_snapshot");
          if (snapshot.totals !== null && !snapshot.truncated) {
            for (const key of Object.keys(counts.shape) as (keyof z.infer<typeof counts>)[])
              if (snapshot.totals[key] !== snapshot.scopes.reduce((sum, scope) => sum + scope[key], 0)) throw new Error("invalid_snapshot");
          }
          const bytes = Buffer.byteLength(JSON.stringify(snapshot));
          if (persistedBytes + bytes > 2 * 1024 * 1024) throw new Error("response_budget_exhausted");
          persistedBytes += bytes;
          const clockInvalid = snapshot.sampled_at_ms > options.nowMs + 5000 || snapshot.scopes.some(scope => scope.coverage === "unknown");
          const stale = options.nowMs - snapshot.sampled_at_ms > 65_000;
          const expiredEmpty = stale && snapshot.status === "not_watched";
          return { workspace_path: path, status: clockInvalid || expiredEmpty ? "unknown" as const : snapshot.status === "unavailable" ? "unknown" as const : stale && snapshot.totals ? "stale" as const : snapshot.status,
            reason: clockInvalid ? "clock_moved_backwards" : stale && snapshot.totals ? "cached_snapshot_expired" : snapshot.reason, snapshot: clockInvalid || expiredEmpty ? null : snapshot };
        };
        Object.assign(result, await Promise.race([read(), failure]));
      } catch (error) {
        const reason = error instanceof Error ? error.message : "read_failed";
        result.reason = ["cancelled", "read_timeout", "invalid_snapshot", "workspace_unavailable", "response_budget_exhausted"].includes(reason) ? reason : "read_failed";
      } finally {
        if (timer) clearTimeout(timer);
        if (abort) options.signal?.removeEventListener("abort", abort);
      }
    }
  }
  await Promise.all([worker(), worker()]);
  return { sampled_at_ms: options.nowMs, tenant: "default", repos, omitted_repos: enabled.length - selected.length };
}

function markdown(value: unknown): string {
  return attentionDisplayText(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&");
}
export function renderDailyAttention(summary: DailyAttentionSummary): string[] {
  const lines = ["## Attention supervision", "- Default tenant; each repository has its own observation snapshot. Reading does not mark seen or execute decisions."];
  if (!summary.repos.length) lines.push("- No enabled repositories.");
  for (const repo of summary.repos) {
    lines.push(`- ${markdown(repo.repo_id)}: ${repo.status}${repo.reason ? ` (${markdown(repo.reason)})` : ""}`);
    if (repo.status === "not_watched") { lines.push("  - No registered Attention scope; wait and decision coverage unknown."); continue; }
    const snapshot = repo.status === "unknown" ? null : repo.snapshot;
    const totals = snapshot?.totals;
    if (!snapshot || !totals) { lines.push("  - Coverage and waits unknown; no healthy zero inferred."); continue; }
    lines.push(`  - ${totals.scopes} scope(s); waits: human ${totals.human_waits}, system ${totals.system_waits}, unknown ${totals.unknown_waits}; unmonitored ${totals.unmonitored_subjects}.`);
    lines.push(`  - Decisions: open ${totals.open_items}, pending ${totals.pending_answers}, uncertain ${totals.uncertain_answers}, source missing ${totals.missing_source_items}; dead letters ${totals.dead_letters}.`);
    for (const scope of snapshot.scopes) if (scope.human_waits || scope.open_items || scope.uncertain_answers || scope.missing_source_items)
      lines.push(`  - ${markdown(scope.task_title)} [${scope.scope_id}]: ${scope.coverage}; human waits ${scope.human_waits}, open decisions ${scope.open_items}, uncertain ${scope.uncertain_answers}, source missing ${scope.missing_source_items}.`);
    if (snapshot.truncated) lines.push(`  - Showing ${snapshot.returned}/${totals.scopes} scopes; counts include the full repository. Use Attention inventory for the remaining scopes.`);
  }
  if (summary.omitted_repos) lines.push(`- ${summary.omitted_repos} additional repositories not sampled (budget limit); coverage unknown.`);
  lines.push("");
  return lines;
}
