Independent second static audit. Report only confirmed P0/P1/P2 failures with concrete trigger and distinguish hypothetical future requirements. No tools. First review findings were evaluated and fixes below. Return JSON findings/verdict. Do not mechanically restate earlier findings. Read actual code evidence.
Disposition: completeness now strict (totals, cursor, per-scope sums); unknown-clock snapshot counts discarded; not_watched does not show zero waits. Failing CI retains priority; Attention scope dedup. Missing paths explicit; aggregate warning for all incomplete/omitted coverage. 2MiB persisted snapshot budget. Actual AttentionStore registerScope canonicalizes paths and requires tenant_id NULL; never string default; proof supplied. Existing db may be writable because daemon shares handle, but only SELECT/transaction reader is invoked and integration tests enforce query_only. Disallowing daemon writable handles is not required and would break intended lifecycle. Snapshot cache TTL is deliberately additional protection for injected/cached RPC sources, production scope freshness is already computed by dashboard. Sampling clock intentionally captured AFTER slow GitHub/maturity work, separate from brief start. No full-portfolio numeric totals emitted, duplicate aliases explicit repoentries and decisiondedup. Async timer cannot preempt syncSQLite, disclosed guide limitation; existing bounded scope store100 and indexed readmodel. Commands inbox/inventory exist and are readonly store SELECT queries. Host bin/daemon wiring belongs parent and will be tested there.

FILE packages/cli/src/daily-attention.ts

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
          const clockInvalid = snapshot.sampled_at_ms > options.nowMs + 5000;
          const stale = options.nowMs - snapshot.sampled_at_ms > 65_000;
          return { workspace_path: path, status: clockInvalid ? "unknown" as const : snapshot.status === "unavailable" ? "unknown" as const : stale && snapshot.totals ? "stale" as const : snapshot.status,
            reason: clockInvalid ? "clock_moved_backwards" : stale && snapshot.totals ? "cached_snapshot_expired" : snapshot.reason, snapshot: clockInvalid ? null : snapshot };
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
    if (!totals) { lines.push("  - Coverage and waits unknown; no healthy zero inferred."); continue; }
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


FILE packages/cli/src/daily-attention.test.ts

import { afterEach, beforeEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAttentionDashboard } from "./attention-dashboard.js";
import { createDailyAttentionReader, readDailyAttention, renderDailyAttention } from "./daily-attention.js";

let root: string;
let db: Database.Database;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "daily-attention-"))); db = new Database(":memory:"); db.pragma("query_only=ON"); });
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
const entries = () => [{ repo_id: "one", path: root, enabled: true }];
const snapshot = () => readAttentionDashboard(db, { workspacePath: root, service: "disabled", nowMs: 100 });

it("keeps unavailable, disabled, and absent provider distinct without fabricated counts or DB migrations", async () => {
  expect((await readDailyAttention(entries(), { nowMs: 100 })).repos[0]).toMatchObject({ status: "unknown", reason: "reader_unavailable", snapshot: null });
  expect((await readDailyAttention(entries(), { nowMs: 100, reader: createDailyAttentionReader(db, () => "disabled") })).repos[0]).toMatchObject({ status: "disabled", snapshot: { totals: null } });
  expect((await readDailyAttention(entries(), { nowMs: 100, reader: createDailyAttentionReader(db, () => "running") })).repos[0]).toMatchObject({ status: "unknown", reason: "schema_unavailable" });
  expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
});

it.each([
  { tenant: "foreign" }, { workspace_path: "/elsewhere" }, { scope_filter: "local_overview" },
  { scopes: [{ scope_id: "evil" }] }, { returned: 1 },
])("rejects a malformed or wrongly scoped RPC snapshot: %j", async (change) => {
  const result = await readDailyAttention(entries(), { nowMs: 100, reader: () => ({ ...snapshot(), ...change }) });
  expect(result.repos[0]).toMatchObject({ status: "unknown", reason: "invalid_snapshot", snapshot: null });
});

it("bounds stalled reads, propagates abort, and still reads another repo", async () => {
  let aborted = false;
  const result = await readDailyAttention([...entries(), { repo_id: "two", path: root, enabled: true }], {
    nowMs: 100, timeoutMs: 20, budgetMs: 100,
    reader: (() => { let calls = 0; return ({ signal }) => { if (++calls === 2) return snapshot(); signal.addEventListener("abort", () => { aborted = true; }); return new Promise(() => {}); }; })(),
  });
  expect(result.repos.map(r => r.status)).toEqual(["unknown", "disabled"]);
  expect(result.repos[0]?.reason).toBe("read_timeout");
  expect(aborted).toBe(true);
});

it("does not call providers after cancellation and caps enabled registry work", async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const result = await readDailyAttention(Array.from({ length: 102 }, (_, n) => ({ ...entries()[0]!, repo_id: String(n) })), { nowMs: 100, signal: controller.signal, reader: () => { calls++; return snapshot(); } });
  expect(calls).toBe(0); expect(result.repos).toHaveLength(100); expect(result.omitted_repos).toBe(2);
  expect(result.repos.every(r => r.reason === "cancelled")).toBe(true);
});

it("escapes untrusted Markdown and terminal controls in its own section", async () => {
  const result = await readDailyAttention([{ repo_id: "<script>\u001b[31m[click](x)\n|oops", path: root, enabled: true }], { nowMs: 100, reader: snapshot });
  const rendered = renderDailyAttention(result).join("\n");
  expect(rendered).toContain("&lt;script&gt;"); expect(rendered).not.toContain("\u001b");
  expect(rendered).toContain("\\[click\\]"); expect(rendered).toContain("\\|oops");
});

it("rejects stale cached health claims and discloses truncated full totals", async () => {
  const counts = { subjects: 2, unmonitored_subjects: 0, human_waits: 1, system_waits: 1, unknown_waits: 0, items: 1, other_items: 0, open_items: 1, pending_answers: 0, uncertain_answers: 0, missing_source_items: 0, applied_answers: 0, dead_letters: 0 };
  const raw = { ...snapshot(), status: "available", reason: null, totals: { ...counts, scopes: 2 }, returned: 1, truncated: true, next_after: "a".repeat(64), scopes: [{ ...counts, scope_id: "a".repeat(64), task_id: "task", task_title: "Waiting", repo_path: root, sampled_at_ms: 100, coverage: "covered", reason: null }] };
  const result = await readDailyAttention(entries(), { nowMs: 70_000, reader: () => raw });
  expect(result.repos[0]).toMatchObject({ status: "stale", reason: "cached_snapshot_expired", snapshot: { totals: { scopes: 2, human_waits: 1, system_waits: 1 } } });
  expect(renderDailyAttention(result).join("\n")).toContain("Showing 1/2 scopes; counts include the full repository");
});

it("accepts small RPC clock skew but labels a far-future snapshot unknown", async () => {
  const result = await readDailyAttention(entries(), { nowMs: 100, reader: () => ({ ...snapshot(), sampled_at_ms: 200 }) });
  expect(result.repos[0]?.status).toBe("disabled");
  const future = await readDailyAttention(entries(), { nowMs: 100, reader: () => ({ ...snapshot(), sampled_at_ms: 6100 }) });
  expect(future.repos[0]).toMatchObject({ status: "unknown", reason: "clock_moved_backwards" });
});

it("rejects truncated snapshots that hide omitted scopes or lack a continuation cursor", async () => {
  const counts = { scopes: 1, subjects: 0, unmonitored_subjects: 0, human_waits: 0, system_waits: 0, unknown_waits: 0, items: 0, other_items: 0, open_items: 0, pending_answers: 0, uncertain_answers: 0, missing_source_items: 0, applied_answers: 0, dead_letters: 0 };
  for (const change of [{ status: "available", totals: counts }, { truncated: true }, { next_after: "a".repeat(64) }]) {
    const result = await readDailyAttention(entries(), { nowMs: 100, reader: () => ({ ...snapshot(), ...change }) });
    expect(result.repos[0]).toMatchObject({ status: "unknown", reason: "invalid_snapshot" });
  }
});

it("shows not-watched coverage without presenting zero waits and classifies missing paths", async () => {
  const counts = { scopes: 0, subjects: 0, unmonitored_subjects: 0, human_waits: 0, system_waits: 0, unknown_waits: 0, items: 0, other_items: 0, open_items: 0, pending_answers: 0, uncertain_answers: 0, missing_source_items: 0, applied_answers: 0, dead_letters: 0 };
  const result = await readDailyAttention(entries(), { nowMs: 100, reader: () => ({ ...snapshot(), status: "not_watched", totals: counts }) });
  const rendered = renderDailyAttention(result).join("\n");
  expect(rendered).toContain("No registered Attention scope"); expect(rendered).not.toContain("human 0");
  const missing = await readDailyAttention([{ ...entries()[0]!, path: join(root, "missing") }], { nowMs: 100, reader: snapshot });
  expect(missing.repos[0]?.reason).toBe("workspace_unavailable");
});

it("drops future-clock counts instead of suggesting a current human wait", async () => {
  const counts = { subjects: 1, unmonitored_subjects: 0, human_waits: 1, system_waits: 0, unknown_waits: 0, items: 1, other_items: 0, open_items: 1, pending_answers: 0, uncertain_answers: 0, missing_source_items: 0, applied_answers: 0, dead_letters: 0 };
  const raw = { ...snapshot(), status: "available", sampled_at_ms: 10000, totals: { ...counts, scopes: 1 }, returned: 1, scopes: [{ ...counts, scope_id: "a".repeat(64), task_id: "task", task_title: "Waiting", repo_path: root, sampled_at_ms: 10000, coverage: "covered", reason: null }] };
  const result = await readDailyAttention(entries(), { nowMs: 100, reader: () => raw });
  expect(result.repos[0]).toMatchObject({ status: "unknown", snapshot: null });
  expect(renderDailyAttention(result).join("\n")).not.toContain("human 1");
  const mismatch = await readDailyAttention(entries(), { nowMs: 10000, reader: () => ({ ...raw, totals: { ...counts, scopes: 1, human_waits: 2 } }) });
  expect(mismatch.repos[0]?.reason).toBe("invalid_snapshot");
});

it("caps persisted snapshot bytes and discloses budget-exhausted repository coverage", async () => {
  const counts = { subjects: 1, unmonitored_subjects: 0, human_waits: 1, system_waits: 0, unknown_waits: 0, items: 1, other_items: 0, open_items: 1, pending_answers: 0, uncertain_answers: 0, missing_source_items: 0, applied_answers: 0, dead_letters: 0 };
  const totals = Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value * 100]));
  const raw = { ...snapshot(), status: "available", totals: { ...totals, scopes: 100 }, returned: 100, scopes: Array.from({ length: 100 }, (_, n) => ({ ...counts, scope_id: n.toString(16).padStart(64, "0"), task_id: "task", task_title: "t".repeat(4096), repo_path: root, sampled_at_ms: 100, coverage: "covered", reason: "r".repeat(4096) })) };
  const result = await readDailyAttention(Array.from({ length: 3 }, (_, n) => ({ ...entries()[0]!, repo_id: String(n) })), { nowMs: 100, reader: () => raw });
  expect(result.repos.filter(repo => repo.reason === "response_budget_exhausted")).toHaveLength(1);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2 * 1024 * 1024);
  const timed = await readDailyAttention(Array.from({ length: 4 }, (_, n) => ({ ...entries()[0]!, repo_id: String(n) })), { nowMs: 100, budgetMs: 10, timeoutMs: 50, reader: () => new Promise(() => {}) });
  expect(timed.repos.some(repo => repo.reason === "budget_exhausted")).toBe(true);
  expect(renderDailyAttention(timed).join("\n")).toContain("budget\\_exhausted");
});


FILE packages/cli/src/attention-dashboard.ts

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


FILE docs/guides/attention-daily.md

# Attention in daily briefs

`runDailyBrief` composes the same read-only Attention section for manual `daily`
and persisted daily sessions. Registry entries are filtered to enabled repositories;
each read uses the canonical repository directory and the default tenant. The
persisted dated brief contains `attention`, and Markdown shows human/system/unknown
wait responsibility, open decisions, uncertain answers, missing sources and dead
letters. This is an observation summary, not approval or execution authority.

## Host integration

`DailyCliDeps` and `RunDailyBriefDeps` accept `attentionReader?: DailyAttentionReader`
and `signal?: AbortSignal`. A reader receives `{ workspacePath, nowMs, limit: 100,
signal }` and returns an AttentionDashboard object. The scheduled daemon injects
`createDailyAttentionReader(existingDb, () => currentObserverService)` and the
session abort signal. Manual CLI wiring injects an existing read-only
`dashboard.snapshot` RPC and returns its `attention` field, forwarding workspace
and attentionLimit. Neither path starts a daemon. The reader factory never opens
a database, migrates, or accepts mutation callbacks.

A missing reader/connection/schema is `unknown`; a disabled observer is `disabled`;
a valid empty scope set is `not_watched`. Stale and degraded projections preserve
historical counts with their coverage labels. Missing data never becomes a healthy
zero. RPC payload validation rejects other tenants, overview snapshots, mismatched
repository paths, malformed counts and inconsistent row counts. Returned data is
allowlisted before persistence, with a two MiB aggregate snapshot budget. Overflow is unknown. A cached sample older than 65 seconds is stale;
more than five seconds ahead is unknown and its counts are discarded (small RPC clock/transport skew allowed). A not-watched repository shows absent coverage rather than zero waits. The Attention sampling clock is captured after other daily scans, separately from the brief generation start.
Each repository snapshot is internally consistent; the whole portfolio is not one
transaction and duplicate registry aliases must not be summed as distinct scopes.

At most 100 enabled repositories are sampled with two concurrent readers, a 500 ms
per-read timeout and a two-second asynchronous budget. Remaining repositories have
explicit unknown/omitted coverage. Each read requests at most 100 scopes; full
repository totals remain separate from the displayed page and truncation is
reported. Timers cannot preempt synchronous SQLite work; this relies on the bounded
existing Attention read model. Cancellable transports should honor the supplied
signal; late results from non-cooperating transports are discarded.

## Decisions and compatibility

At most three owner suggestions retain existing autonomy and failing-CI priority, followed by
Attention evidence checks. Fresh human waits with open decisions suggest
`attention inbox --scope`; uncertain, stale or missing-source facts suggest
`attention inventory --scope`. Scope IDs are deduplicated across registry aliases.
The daily producer never calls answer, resume, seen, posture or delivery mutation.
It does not claim actor-specific unread counts: this summary is actor-neutral.

Old persisted briefs without `attention` still render. New Attention Markdown strips
terminal controls and escapes untrusted markup; this is not a claim about unrelated
legacy report sections. Existing Stack, Probe and hygiene DB reads now explicitly
use the guarded readonly connection. Missing homes do not create a database; old
schemas degrade to warnings without migration. The only intended write remains
the dated JSON brief in the explicit OSSTACK_HOME.

Validation covers workspace/default-tenant filtering with a real query-only SQLite
connection, manual and reusable brief persistence, absent and disabled sources,
not-watched and stale coverage, pagination disclosure, malformed RPC input,
timeouts/cancellation, output escaping and unchanged legacy database bytes/schema.

DAILY INTEGRATION DIFF
diff --git a/packages/cli/src/daily-cli.test.ts b/packages/cli/src/daily-cli.test.ts
index ce6f439c..672421f7 100644
--- a/packages/cli/src/daily-cli.test.ts
+++ b/packages/cli/src/daily-cli.test.ts
@@ -838,3 +838,66 @@ describe("deriveOwnerDecisions (R2.4 dispatchable run payloads)", () => {
     );
   });
 });
+
+describe("daily Attention integration", () => {
+  it("persists injected scoped supervision and keeps decisions advisory", async () => {
+    const registryPath = await seedRegistry();
+    const { AttentionStore } = await import("@osstack/core");
+    const { insertTask } = await import("./store.js");
+    const { createDailyAttentionReader } = await import("./daily-attention.js");
+    const nowMs = Date.parse("2026-07-11T09:00:00Z");
+    const db = openDb({ path: join(tmp, "attention.db") });
+    try {
+      const store = new AttentionStore(db, join(tmp, "attention.db"));
+      const owner = store.claimOwner("daily-test");
+      const selectedRepo = await realpath(join(tmp, "withgh"));
+      insertTask(db, store.path, { task_id: "selected", title: "Human decision", created_at: 1 });
+      const scope = store.registerScope(owner, "selected", selectedRepo);
+      db.prepare("UPDATE attention_scopes SET sampled_at=?,deadline=?,scan_complete=1").run(nowMs, nowMs + 65000);
+      db.prepare("INSERT INTO attention_subjects(scope_id,kind,subject_id,binding_hash,source_version,admitted,discovered_at,sampled_at,generation,payload_json) VALUES(?,'session','human','hash',1,1,?,?,?,?)").run(scope.scope_id, nowMs, nowMs, owner.generation, '{"wait":{"owner":"human"}}');
+      db.prepare("INSERT INTO attention_items(item_id,scope_id,session_id,turn_id,decision_id,content_hash,decision_json,source_version,state,created_at,updated_at) VALUES('item',?,'human','turn','decision','hash','{}',1,'open',?,?)").run(scope.scope_id, nowMs, nowMs);
+      insertTask(db, store.path, { task_id: "foreign", title: "Private", created_at: 1 });
+      store.registerScope(owner, "foreign", selectedRepo);
+      db.prepare("UPDATE tasks SET tenant_id='private' WHERE task_id='foreign'").run();
+      db.pragma("query_only=ON");
+      const before = db.prepare("SELECT total_changes() AS n").get();
+      const deps = { runner: makeRunner([], "success"), now: () => new Date(nowMs), attentionReader: createDailyAttentionReader(db, () => "running") };
+      const run = await runDailyBrief({ registryPath, ...deps });
+      expect(run.brief.attention?.repos.map(r => r.status)).toEqual(["available", "not_watched"]);
+      expect(run.brief.attention?.repos[0]?.snapshot?.totals).toMatchObject({ scopes: 1, human_waits: 1, open_items: 1 });
+      expect(run.brief.owner_decisions?.[0]).toMatchObject({ command: "attention.inbox", run: { argv: ["osstack", "attention", "inbox", "--scope", scope.scope_id] } });
+      const duplicated = { ...run.brief, github: [{ ...run.brief.github[0]!, ci_runs: [{ ...run.brief.github[0]!.ci_runs[0]!, conclusion: "failure" }] }], attention: { ...run.brief.attention!, repos: Array(3).fill(run.brief.attention!.repos[0]) } };
+      const decisions = deriveOwnerDecisions(duplicated);
+      expect(decisions[0]?.command).toBe("repo.fix_ci");
+      expect(decisions.filter(decision => decision.command === "attention.inbox")).toHaveLength(1);
+      expect(JSON.parse(await readFile(run.briefPath, "utf8")).attention).toEqual(run.brief.attention);
+      await handleDailyCommand(["--registry", registryPath, "--json"], { ...deps, out });
+      expect(AgentCommandResult.parse(JSON.parse(logs[0]!)).status).toBe("ok");
+      const stale = await runDailyBrief({ registryPath, ...deps, now: () => new Date(nowMs + 65001) });
+      expect(stale.brief.attention?.repos[0]?.status).toBe("stale");
+      expect(stale.brief.owner_decisions?.[0]?.command).toBe("attention.inventory");
+      expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
+    } finally { db.close(); }
+  });
+
+  it("does not create a database in an uninitialized home or migrate a legacy daily database", async () => {
+    const registryPath = await seedRegistry();
+    const run = await runDailyBrief({ registryPath, runner: makeRunner([], "success") });
+    expect(run.brief.attention?.repos.every(r => r.status === "unknown")).toBe(true);
+    const { existsSync } = await import("node:fs");
+    expect(existsSync(join(tmp, "home", "state.db"))).toBe(false);
+    const { default: Database } = await import("better-sqlite3");
+    const path = join(tmp, "home", "state.db");
+    const legacy = new Database(path);
+    legacy.exec("CREATE TABLE untouched(value TEXT); INSERT INTO untouched VALUES('preserve')");
+    const schema = legacy.prepare("SELECT sql FROM sqlite_master ORDER BY name").all(); legacy.close();
+    const before = await readFile(path);
+    const second = await runDailyBrief({ registryPath, runner: makeRunner([], "success") });
+    expect(second.brief.warnings.some(w => w.includes("stack board unavailable"))).toBe(true);
+    expect(second.brief.warnings.some(w => w.includes("probe portfolio unavailable"))).toBe(true);
+    expect(await readFile(path)).toEqual(before);
+    const check = new Database(path, { readonly: true });
+    expect(check.prepare("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
+    expect(check.pragma("user_version", { simple: true })).toBe(0); check.close();
+  });
+});
diff --git a/packages/cli/src/daily-command.ts b/packages/cli/src/daily-command.ts
index 2922d8b0..ecab37d9 100644
--- a/packages/cli/src/daily-command.ts
+++ b/packages/cli/src/daily-command.ts
@@ -12,6 +12,7 @@
 // Read-only: the ONLY thing it writes is the dated brief JSON under
 // $OSSTACK_HOME/daily-briefs/ (delta substrate). No apply, no execution.
 
+import { readDailyAttention, renderDailyAttention, type DailyAttentionReader, type DailyAttentionSummary } from "./daily-attention.js";
 import { existsSync } from "node:fs";
 import { createHash } from "node:crypto";
 import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
@@ -45,6 +46,8 @@ import {
 } from "./autonomy-scorecard.js";
 
 export interface DailyCliDeps {
+  attentionReader?: DailyAttentionReader;
+  signal?: AbortSignal;
   /** Injectable command runner for the GitHub adapter (offline in tests). */
   runner?: CommandRunner;
   /** Clock override (tests pin the ISO date + generated_at). */
@@ -54,6 +57,8 @@ export interface DailyCliDeps {
 
 /** Inputs to the reusable brief core (`runDailyBrief`). */
 export interface RunDailyBriefDeps {
+  attentionReader?: DailyAttentionReader;
+  signal?: AbortSignal;
   /** Resolved repo registry path (absolute). The daemon resolves + stores this. */
   registryPath: string;
   /** Injectable command runner for the GitHub adapter (offline in tests). */
@@ -131,6 +136,7 @@ export interface DailyBrief {
    */
   owner_decisions?: OwnerDecision[];
   autonomy?: AutonomyReliabilityReport;
+  attention?: DailyAttentionSummary;
   warnings: string[];
 }
 
@@ -194,6 +200,11 @@ export async function runDailyBrief(deps: RunDailyBriefDeps): Promise<DailyBrief
   const { summary: autonomy, warning: autonomyWarning } =
     readAutonomyReliability(now);
 
+  const attention = await readDailyAttention(enabled, { nowMs: (deps.now?.() ?? new Date()).getTime(),
+    ...(deps.attentionReader === undefined ? {} : { reader: deps.attentionReader }),
+    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
+  });
+
   const warnings = github.filter((g) => g.warning !== undefined).map((g) => `${g.repo_id}: ${g.warning}`);
   if (stackWarning !== undefined) warnings.push(stackWarning);
   if (probeWarning !== undefined) warnings.push(probeWarning);
@@ -203,6 +214,8 @@ export async function runDailyBrief(deps: RunDailyBriefDeps): Promise<DailyBrief
     warnings.push(hygieneHistory.warning);
   }
   warnings.push(...knowledgeHygieneWarnings(portfolio));
+  const incompleteAttention = attention.repos.filter(repo => repo.status !== "available").length + attention.omitted_repos;
+  if (incompleteAttention > 0) warnings.push(`Attention supervision incomplete for ${incompleteAttention} repository entries; see per-repository coverage.`);
 
   // 4. Delta against the most recent previous brief.
   const briefsDir = join(osstackHome(), "daily-briefs");
@@ -212,6 +225,7 @@ export async function runDailyBrief(deps: RunDailyBriefDeps): Promise<DailyBrief
   const brief: DailyBrief = {
     generated_at: now.toISOString(),
     date,
+    attention,
     portfolio,
     github,
     ...(stack !== undefined ? { stack } : {}),
@@ -296,6 +310,8 @@ export async function handleDailyCommand(args: string[], deps: DailyCliDeps = {}
   // in runDailyBrief so the daemon and the CLI produce identical briefs.
   const run = await runDailyBrief({
     registryPath: resolveRegistryPath(args),
+    ...(deps.attentionReader === undefined ? {} : { attentionReader: deps.attentionReader }),
+    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
     ...(deps.runner !== undefined ? { runner: deps.runner } : {}),
     ...(deps.now !== undefined ? { now: deps.now } : {}),
   });
@@ -320,7 +336,7 @@ function readStackBoardSummary(board = "stack"): { summary?: StackBoardSummary;
   // No state DB yet ⇒ no stack board; omit rather than create one as a side effect.
   if (!existsSync(dbPath)) return {};
   try {
-    const db = openDb({ path: dbPath });
+    const db = openDb({ path: dbPath, readwrite: false });
     try {
       const repo = new KanbanRepository(db, dbPath);
       const view = getBoard(repo, { board, includeArchived: true });
@@ -352,7 +368,7 @@ function readProbePortfolioSummary(
   const dbPath = join(osstackHome(), "state.db");
   if (!existsSync(dbPath)) return {};
   try {
-    const db = openDb({ path: dbPath });
+    const db = openDb({ path: dbPath, readwrite: false });
     try {
       const summary = queryProbePortfolioSummary(db, {
         as_of_ms: asOfMs,
@@ -389,7 +405,7 @@ function readPortfolioKnowledgeHygieneHistory(
   const dbPath = join(osstackHome(), "state.db");
   if (!existsSync(dbPath)) return { byRepo };
   try {
-    const db = openDb({ path: dbPath });
+    const db = openDb({ path: dbPath, readwrite: false });
     try {
       for (const entry of entries) {
         const trend = queryKnowledgeHygieneTrendV2(db, entry.repo_id, {
@@ -544,6 +560,20 @@ export function deriveOwnerDecisions(brief: DailyBrief): OwnerDecision[] {
       });
     }
   }
+  const seenScopes = new Set<string>();
+  for (const repo of brief.attention?.repos ?? []) {
+    for (const scope of repo.snapshot?.scopes ?? []) {
+      if (seenScopes.has(scope.scope_id) || !(scope.human_waits || scope.uncertain_answers || scope.missing_source_items)) continue;
+      seenScopes.add(scope.scope_id);
+      // Viewing evidence is the only suggested operation; stale facts cannot grant authority.
+      const subcommand = repo.status === "available" && scope.coverage === "covered" && scope.human_waits > 0 && scope.open_items > 0 ? "inbox" : "inventory";
+      const argv = ["osstack", "attention", subcommand, "--scope", scope.scope_id];
+      decisions.push({ command: `attention.${subcommand}`,
+        reason: `Review scope ${scope.scope_id}: human waits ${scope.human_waits}, uncertain answers ${scope.uncertain_answers}, source missing ${scope.missing_source_items}; observation ${repo.status}`,
+        run: { command: argv.map(shQuote).join(" "), argv },
+      });
+    }
+  }
   for (const repo of brief.portfolio.repos) {
     const reasons = knowledgeHygieneIssues(repo);
     if (reasons.length === 0) continue;
@@ -827,6 +857,8 @@ export function renderDailyMarkdown(brief: DailyBrief): string {
   }
   lines.push("");
 
+  if (brief.attention !== undefined) lines.push(...renderDailyAttention(brief.attention));
+
   if (brief.stack !== undefined) {
     lines.push("## Stack board");
     lines.push(`- board "${brief.stack.board}": ${brief.stack.total} card(s)`);
@@ -930,7 +962,8 @@ export function renderDailyMarkdown(brief: DailyBrief): string {
   lines.push("## Owner decisions");
   const ownerDecisions = brief.owner_decisions ?? [];
   if (ownerDecisions.length === 0) {
-    lines.push("- None — portfolio looks healthy.");
+    const incompleteAttention = brief.attention && (brief.attention.omitted_repos > 0 || brief.attention.repos.some(repo => repo.status !== "available"));
+    lines.push(incompleteAttention ? "- None suggested — supervision has incomplete coverage." : "- None — portfolio looks healthy.");
   } else {
     ownerDecisions.forEach((d, i) => {
       lines.push(`${i + 1}. [${d.command}] ${d.reason}`);

packages/core/src/state/attention-store.ts
    return withWrite(this.db, this.path, () => {
      this.assertOwner(owner);
      return fn();
    });
  }
  registerScope(
    owner: AttentionOwner,
    taskId: string,
    repoPath: string
  ): AttentionScope {
    const canonicalRepo = realpathSync(repoPath);
    if (!statSync(canonicalRepo).isDirectory())
      throw new Error("repository_directory_required");
    return this.write(owner, () => {
      const task = this.db
        .prepare(
          "SELECT created_at FROM tasks WHERE task_id=? AND tenant_id IS NULL"
        )
        .get(taskId) as { created_at: number } | undefined;
      if (!task) throw new Error("not_found");
      if (
        (
          this.db.prepare("SELECT COUNT(*) n FROM attention_scopes").get() as {
            n: number;
          }
        ).n >= 100 &&
        !this.db
          .prepare(
            "SELECT 1 FROM attention_scopes WHERE task_id=? AND repo_path=?"
          )
          .get(taskId, canonicalRepo)
      )
        throw new Error("scope_capacity");
      const scopeId = attentionDigest([
        owner.home_id,
        taskId,
        canonicalRepo,
        task.created_at,
      ]);
      this.db
        .prepare(
          `INSERT INTO attention_scopes(scope_id,task_id,repo_path,generation) VALUES(?,?,?,?)
        ON CONFLICT(scope_id) DO NOTHING`
        )
        .run(scopeId, taskId, canonicalRepo, owner.generation);
      return this.getScope(scopeId)!;
    });
  }
  getScope(scopeId: string): AttentionScope | undefined {
    return this.db
      .prepare("SELECT * FROM attention_scopes WHERE scope_id=?")
      .get(scopeId) as AttentionScope | undefined;
  }
  listScopes(): AttentionScope[] {
    return this.db
      .prepare("SELECT * FROM attention_scopes ORDER BY scope_id")
      .all() as AttentionScope[];
packages/cli/src/attention-command.ts
    "get",
    "answer",
    "brief",
    "posture",
    "seen",
    "foreground",
    "handoff",
    "turn-end",
    "deliveries",
    "cockpit",
    "abandon-receipt",
    "release",
    "loop",
    "ci",
  ];
  if (!allowed.includes(command)) throw new Error("unknown_attention_command");
  if (!io.rpc) throw new Error("daemon_connection_required");
  const params: Record<string, unknown> = {};
  let json = false;
  const keys = new Set([
    "task",
    "repo",
    "scope",
    "after",
    "item",
    "action",
    "revision",
    "content-hash",
    "text",
    "actor",
    "posture",
    "revisions",
    "subjects",
    "client",
    "token",
    "role",
    "state-path",
    "loop-id",
    "github-repo",
    "pr",
    "head",
    "required",
    "session",
    "kind",
    "subject",
    "message",
    "expected-version",
    "reason",
    "evidence-sha256",
    "grant",
  ]);
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (flag === "--default-tenant") {
      params["default_tenant"] = true;
      continue;
    }
    if (flag === "--acknowledge-unknown-effects") {
      params["acknowledge_unknown_effects"] = true;
      continue;
    }
    if (flag === "--takeover") {
      params["takeover"] = true;
      continue;
    }
    const key = flag.slice(2);
    if (!flag.startsWith("--") || !keys.has(key))
      throw new Error("unknown_flag:" + flag);
    const value = args[++i];
    if (!value || value.startsWith("--"))
      throw new Error("missing_value:" + flag);
    const mapped: Record<string, string> = {
      task: "task_id",
      session: "session_id",
      subject: "subject_id",
      message: "message_id",
      "expected-version": "expected_version",
      "evidence-sha256": "evidence_sha256",
      repo: "repo_path",
      scope: "scope_id",
      item: "item_id",
      action: "action_id",
      client: "client_id",
      "content-hash": "content_hash",
      "state-path": "state_path",
      "loop-id": "loop_id",
      "github-repo": "github_repo",
      grant: "takeover_grant_id",
    };
    const name = mapped[key] ?? key;
    if (params[name] !== undefined) throw new Error("duplicate_flag:" + flag);
    params[name] = ["revision", "pr", "expected-version"].includes(key)
      ? Number(value)
      : ["revisions", "subjects", "required"].includes(key)
      ? JSON.parse(value)
      : value;
  }
  if (command === "answer") params["takeover"] ??= false;
  const call = async (method: string) => {
    const response = (await io.rpc!(method, params, 120000)) as {
      ok: boolean;
      result?: unknown;
      error?: { code?: string; message?: string };
    };
    if (!response.ok)
      throw new Error(
        response.error?.code ?? response.error?.message ?? "attention_failed"
      );
    return response.result;
  };
  const result =
    command === "cockpit"
      ? {
          inventory: await call("attention.inventory"),
          inbox: await call("attention.inbox"),
          brief: await call("attention.brief"),
          deliveries: await call("attention.deliveries"),
        }
      : await call("attention." + command);
  (io.stdout ?? console.log)(
    json
      ? JSON.stringify(result, null, 2)
      : `Attention · ${command}\n${JSON.stringify(
          result,
          null,
          2
packages/core/src/state/db.ts
 * Caller owns the lifetime — pair every openDb() with a db.close() in shutdown.
 */
export function openDb(opts: OpenDbOptions): Database.Database {
  const { path, readwrite = true, minFreeBytes = DEFAULT_MIN_FREE_BYTES } = opts;
  if (readwrite) preflightDiskSpace(path, minFreeBytes);

  const db = new Database(path, { readonly: !readwrite });

  try {
    // Refuse an unsupported schema before changing journal mode or running DDL,
    // including read-only inspection. A failed open never escapes with a live handle.
    assertSupportedVersion(db.pragma("user_version", { simple: true }) as number);
    assertMigrationLineage(db);
    // Pragmas are applied per-connection in SQLite. Apply on every open.
    if (readwrite) db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma(`cache_size = ${PAGE_CACHE_KIB}`);
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");

    if (readwrite) runMigrations(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

// This schema is table-additive. Derive expected table introductions once;