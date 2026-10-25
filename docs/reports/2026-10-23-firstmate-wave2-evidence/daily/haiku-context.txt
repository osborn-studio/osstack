Review the following daily Attention implementation as a hostile correctness/security reviewer. Report concrete P0/P1/P2 findings with file/line and testable scenario; distinguish suggestions. Do not use tools. Requirements: canonical workspace/default tenant, disabled/not_watched/stale/unknown, no answer/resume/seen, no DB creation or migrations, shared manual/scheduled core via injected reader, bounded reads and no false healthy zero. Host daemon/bin injection belongs to root integration and is intentionally not changed here. Existing dashboard read model is authoritative. Re-read final code carefully, do not treat helpers as host integration. Tests use actual SQLite query_only. Existing unrelated daily/GitHub behavior is out of scope unless changed. Reply with JSON {findings:[{priority,file,line,issue,fix}], verdict}.

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
          const path = await realpath(entry.path);
          if (!(await stat(path)).isDirectory()) throw new Error("workspace_unavailable");
          controller.signal.throwIfAborted();
          const raw = await options.reader!({ workspacePath: path, nowMs: options.nowMs, limit: 100, signal: controller.signal });
          controller.signal.throwIfAborted();
          const parsed = dashboardSchema.safeParse(raw);
          if (!parsed.success) throw new Error("invalid_snapshot");
          const snapshot = parsed.data;
          if (snapshot.workspace_path !== path || snapshot.scopes.some(s => s.repo_path !== path)
            || snapshot.returned !== snapshot.scopes.length || new Set(snapshot.scopes.map(s => s.scope_id)).size !== snapshot.scopes.length
            || (snapshot.totals !== null && snapshot.totals.scopes < snapshot.returned)
            || (snapshot.totals === null && snapshot.scopes.length > 0)
            || (snapshot.status === "not_watched" && snapshot.totals?.scopes !== 0)
            || (["available", "degraded", "stale"].includes(snapshot.status) && !snapshot.totals?.scopes)) throw new Error("invalid_snapshot");
          const clockInvalid = snapshot.sampled_at_ms > options.nowMs + 5000;
          const stale = options.nowMs - snapshot.sampled_at_ms > 65_000;
          return { workspace_path: path, status: clockInvalid ? "unknown" as const : snapshot.status === "unavailable" ? "unknown" as const : stale && snapshot.totals ? "stale" as const : snapshot.status,
            reason: clockInvalid ? "clock_moved_backwards" : stale && snapshot.totals ? "cached_snapshot_expired" : snapshot.reason, snapshot };
        };
        Object.assign(result, await Promise.race([read(), failure]));
      } catch (error) {
        const reason = error instanceof Error ? error.message : "read_failed";
        result.reason = ["cancelled", "read_timeout", "invalid_snapshot", "workspace_unavailable"].includes(reason) ? reason : "read_failed";
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
    const snapshot = repo.snapshot;
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
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "daily-attention-"))); db = new Database(":memory:"); });
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


FILE packages/cli/src/daily-command.ts

// `osstack daily` — a read-only portfolio brief and the first Agent Command
// Protocol dogfood surface (R1.4). It composes existing kernel capability:
//   1. Scan   — the supervisor portfolio maturity report over `.osstack/repos.json`.
//   2. GitHub — the read-only `@osstack/github` portfolio-status adapter (PRs/CI/release).
//   3. Stack  — the existing kanban "stack" board summary, when any cards exist.
//   4. Probe  — current open obligations, aging, and required-item completion.
//   5. Delta  — diff against the previous brief (new PRs / CI flips / maturity changes).
//   6. Render — Markdown for humans by default; `--json` emits a protocol
//               AgentCommandResult (status ok, brief in `result`, per-repo
//               evidence_refs, ≤3 owner decisions in next_actions).
//
// Read-only: the ONLY thing it writes is the dated brief JSON under
// $OSSTACK_HOME/daily-briefs/ (delta substrate). No apply, no execution.

import { readDailyAttention, renderDailyAttention, type DailyAttentionReader, type DailyAttentionSummary } from "./daily-attention.js";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KanbanRepository, countOpenDependencyObligationsV2, getBoard, queryKnowledgeHygieneTrendV2, queryProbePortfolioSummary, type ProbePortfolioSummaryV1 } from "@osstack/core";
import { guardedOpenDb as openDb } from "./guarded-open-db.js";
import {
  fetchPortfolioGithubStatus,
  type CommandRunner,
  type RepoGithubStatus,
} from "@osstack/github";
import { PROTOCOL_VERSION } from "@osstack/protocol";
import type { AgentCommandResult } from "@osstack/protocol";
import {
  buildPortfolioReport,
  attachKnowledgeHygieneSummaries,
  readRepoRegistry,
  scanRepo,
  scanPortfolioKnowledgeHygiene,
  type PortfolioReport,
  type RepoHealth,
  type RepoRegistryEntry,
  type StructuredRecommendation,
} from "@osstack/supervisor";
import { osstackHome } from "./paths.js";
import { shQuote } from "./start-control-command.js";
import { hasFlag, resolveRegistryPath } from "./supervisor-cli-support.js";
import {
  createAutonomyReliabilityReport,
  type AutonomyReliabilityReport,
} from "./autonomy-scorecard.js";

export interface DailyCliDeps {
  attentionReader?: DailyAttentionReader;
  signal?: AbortSignal;
  /** Injectable command runner for the GitHub adapter (offline in tests). */
  runner?: CommandRunner;
  /** Clock override (tests pin the ISO date + generated_at). */
  now?: () => Date;
  out?: (line: string) => void;
}

/** Inputs to the reusable brief core (`runDailyBrief`). */
export interface RunDailyBriefDeps {
  attentionReader?: DailyAttentionReader;
  signal?: AbortSignal;
  /** Resolved repo registry path (absolute). The daemon resolves + stores this. */
  registryPath: string;
  /** Injectable command runner for the GitHub adapter (offline in tests). */
  runner?: CommandRunner;
  /** Clock override (tests pin the ISO date + generated_at). */
  now?: () => Date;
}

/** The full outcome of one brief composition: the brief, its write path, the
 *  strict protocol result, and the enabled registry entries used. */
export interface DailyBriefRun {
  brief: DailyBrief;
  briefPath: string;
  result: AgentCommandResult;
  entries: RepoRegistryEntry[];
}

export interface StackBoardSummary {
  board: string;
  total: number;
  columns: { name: string; count: number }[];
}

export interface DailyDelta {
  is_first_run: boolean;
  previous_brief_date?: string;
  new_prs: { repo_id: string; number: number; title: string }[];
  ci_flips: { repo_id: string; from: string; to: string }[];
  maturity_changes: { repo_id: string; from: number; to: number }[];
}

/**
 * A concrete, paste-ready invocation for an owner decision (R2.4). Mirrors
 * R1.5's `deliver_command` / `deliver_args` split:
 *   - `command`: the shell-safe printable line — every interpolated value is
 *     `shQuote`'d (the ONE audited quoting helper, reused from start/control),
 *     so hostile CI-status / goal / slug text cannot execute on paste.
 *   - `argv`: the raw args array for programmatic spawn (never re-parse the
 *     shell string). `argv[0]` is the PROGRAM (`osstack` | `gh`) so the payload
 *     is self-describing across the multiple binaries `daily` dispatches to
 *     (deliberate divergence from `deliver_args`, whose program is implicitly
 *     `osstack`; see the `deriveOwnerDecisions` docstring).
 */
export interface RunnableInvocation {
  command: string;
  argv: string[];
}

/** An owner decision plus its dispatchable invocation (R2.4). */
export interface OwnerDecision {
  /** Stable protocol `CommandName` category id (advisory; unchanged by R2.4). */
  command: string;
  /** Human-facing decision text. */
  reason: string;
  /** The REAL runnable invocation the owner can dispatch. */
  run: RunnableInvocation;
}

export interface DailyBrief {
  generated_at: string;
  date: string;
  portfolio: PortfolioReport;
  github: RepoGithubStatus[];
  stack?: StackBoardSummary;
  probe?: ProbePortfolioSummaryV1;
  dependency_obligations?: {
    registry_scope: string;
    open_count: number;
  };
  delta: DailyDelta;
  /**
   * ≤3 owner decisions with dispatchable `run` payloads (R2.4). Optional
   * because pre-R2.4 briefs on disk lack the field — always present on a
   * freshly built brief, but readers of a PREVIOUS brief must not assume it.
   */
  owner_decisions?: OwnerDecision[];
  autonomy?: AutonomyReliabilityReport;
  attention?: DailyAttentionSummary;
  warnings: string[];
}

/** Failing CI conclusions (mirrors the stack drift taxonomy). */
const FAILING_CI = new Set(["failure", "cancelled", "timed_out", "startup_failure", "action_required"]);

/** Latest CI conclusion|status for a repo, or "none" when it has no runs. */
export function repoCiStatus(status: RepoGithubStatus): string {
  const latest = status.ci_runs[0];
  if (latest === undefined) return "none";
  return (latest.conclusion ?? latest.status ?? "unknown").toLowerCase();
}

/**
 * Compose one daily brief (steps 1–4 + persist + build the strict protocol
 * result) with no CLI concerns: no arg parsing, no rendering, no stdout. The
 * daemon runs this in-process each scheduled tick, and `handleDailyCommand`
 * wraps it for the manual CLI path — so a scheduled brief is byte-compatible
 * with a manual one (same registry read, same `$OSSTACK_HOME/daily-briefs/`
 * write, same `AgentCommandResult`).
 */
export async function runDailyBrief(deps: RunDailyBriefDeps): Promise<DailyBriefRun> {
  const now = deps.now?.() ?? new Date();
  // UTC ISO date, intentionally: brief filenames and delta boundaries must be
  // deterministic across machines/timezones (N4 ruling — determinism over local tz).
  const date = now.toISOString().slice(0, 10);

  const entries = await readRepoRegistry(deps.registryPath);
  const enabled = entries.filter((entry) => entry.enabled);

  // 1. Portfolio maturity scan (supervisor, existing).
  const healths: RepoHealth[] = [];
  for (const entry of enabled) healths.push(await scanRepo(entry));
  const hygieneHistory = readPortfolioKnowledgeHygieneHistory(
    enabled,
    now.getTime(),
  );
  const hygieneScans = await scanPortfolioKnowledgeHygiene(enabled, {
    now: () => now,
    history: async (repoId) => hygieneHistory.byRepo.get(repoId) ?? {
      recurring_count: 0,
    },
  });
  const portfolio = buildPortfolioReport(
    attachKnowledgeHygieneSummaries(healths, hygieneScans),
    now.toISOString(),
  );

  // 2. GitHub read adapter (degrades per-repo, never throws).
  const github = await fetchPortfolioGithubStatus(
    enabled.map((entry) => ({ repo_id: entry.repo_id, path: entry.path })),
    deps.runner,
  );

  // 3. Stack board summary — included only when the board actually has cards.
  const { summary: stack, warning: stackWarning } = readStackBoardSummary();
  const { summary: probe, warning: probeWarning } =
    readProbePortfolioSummary(enabled, now.getTime());
  const { summary: dependencyObligations, warning: dependencyWarning } =
    await readDependencyObligationSummary(deps.registryPath);
  const { summary: autonomy, warning: autonomyWarning } =
    readAutonomyReliability(now);

  const attention = await readDailyAttention(enabled, { nowMs: (deps.now?.() ?? new Date()).getTime(),
    ...(deps.attentionReader === undefined ? {} : { reader: deps.attentionReader }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });

  const warnings = github.filter((g) => g.warning !== undefined).map((g) => `${g.repo_id}: ${g.warning}`);
  if (stackWarning !== undefined) warnings.push(stackWarning);
  if (probeWarning !== undefined) warnings.push(probeWarning);
  if (dependencyWarning !== undefined) warnings.push(dependencyWarning);
  if (autonomyWarning !== undefined) warnings.push(autonomyWarning);
  if (hygieneHistory.warning !== undefined) {
    warnings.push(hygieneHistory.warning);
  }
  warnings.push(...knowledgeHygieneWarnings(portfolio));

  // 4. Delta against the most recent previous brief.
  const briefsDir = join(osstackHome(), "daily-briefs");
  const previous = await readPreviousBrief(briefsDir, date);
  const delta = computeDelta(previous, { portfolio, github });

  const brief: DailyBrief = {
    generated_at: now.toISOString(),
    date,
    attention,
    portfolio,
    github,
    ...(stack !== undefined ? { stack } : {}),
    ...(probe !== undefined ? { probe } : {}),
    ...(dependencyObligations !== undefined
      ? { dependency_obligations: dependencyObligations }
      : {}),
    ...(autonomy === undefined ? {} : { autonomy }),
    delta,
    // Computed from portfolio + github below, then stored so the dispatchable
    // `run` payloads ride in `result` (= the brief) and are persisted verbatim.
    owner_decisions: [],
    warnings,
  };
  brief.owner_decisions = deriveOwnerDecisions(brief);

  // Persist the brief (the only write this command performs).
  const briefPath = join(briefsDir, `${date}.json`);
  await mkdir(briefsDir, { recursive: true });
  await writeFile(briefPath, `${JSON.stringify(brief, null, 2)}\n`, "utf8");

  return { brief, briefPath, result: buildDailyResult(brief, briefPath, enabled), entries: enabled };
}

function readAutonomyReliability(now: Date): {
  summary?: AutonomyReliabilityReport;
  warning?: string;
} {
  const dbPath = join(osstackHome(), "state.db");
  if (!existsSync(dbPath)) return {};
  try {
    const database = openDb({ path: dbPath, readwrite: false });
    try {
      return {
        summary: createAutonomyReliabilityReport(database, {
          now: () => now,
        }),
      };
    } finally {
      database.close();
    }
  } catch (error) {
    return {
      warning: `autonomy reliability unavailable (${dbPath}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

async function readDependencyObligationSummary(
  registryPath: string,
): Promise<{
  summary?: { registry_scope: string; open_count: number };
  warning?: string;
}> {
  const dbPath = join(osstackHome(), "state.db");
  if (!existsSync(dbPath)) return {};
  try {
    const canonical = await realpath(registryPath);
    const registryScope = createHash("sha256").update(canonical).digest("hex");
    const database = openDb({ path: dbPath, readwrite: false });
    try {
      const openCount = countOpenDependencyObligationsV2(database, registryScope);
      return openCount === 0
        ? {}
        : { summary: { registry_scope: registryScope, open_count: openCount } };
    } finally {
      database.close();
    }
  } catch (error) {
    return {
      warning: `dependency obligations unavailable (${dbPath}): ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function handleDailyCommand(args: string[], deps: DailyCliDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;

  // Thin wrapper: parse flags → runDailyBrief → render. All composition lives
  // in runDailyBrief so the daemon and the CLI produce identical briefs.
  const run = await runDailyBrief({
    registryPath: resolveRegistryPath(args),
    ...(deps.attentionReader === undefined ? {} : { attentionReader: deps.attentionReader }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    ...(deps.runner !== undefined ? { runner: deps.runner } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  if (hasFlag(args, "--json")) {
    out(JSON.stringify(run.result, null, 2));
  } else {
    out(renderDailyMarkdown(run.brief));
  }
  return 0;
}

// ── Stack board ──────────────────────────────────────────────────────────────

/**
 * Never-crash: a corrupt/locked state.db must not take `daily` down — the board
 * is one facet of the brief, so any throw degrades to an omitted section plus a
 * warning surfaced in `brief.warnings`.
 */
function readStackBoardSummary(board = "stack"): { summary?: StackBoardSummary; warning?: string } {
  const dbPath = join(osstackHome(), "state.db");
  // No state DB yet ⇒ no stack board; omit rather than create one as a side effect.
  if (!existsSync(dbPath)) return {};
  try {
    const db = openDb({ path: dbPath, readwrite: false });
    try {
      const repo = new KanbanRepository(db, dbPath);
      const view = getBoard(repo, { board, includeArchived: true });
      if (!view.changed || view.stats.total === 0) return {};
      return {
        summary: {
          board,
          total: view.stats.total,
          columns: view.columns
            .filter((column) => column.cards.length > 0)
            .map((column) => ({ name: column.name, count: column.cards.length })),
        },
      };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      warning: `stack board unavailable (${dbPath}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Probe state is optional context: no DB/session preserves the old brief. */
function readProbePortfolioSummary(
  entries: readonly RepoRegistryEntry[],
  asOfMs: number,
): { summary?: ProbePortfolioSummaryV1; warning?: string } {
  const dbPath = join(osstackHome(), "state.db");
  if (!existsSync(dbPath)) return {};
  try {
    const db = openDb({ path: dbPath, readwrite: false });
    try {
      const summary = queryProbePortfolioSummary(db, {
        as_of_ms: asOfMs,
        repo_ids: entries.map((entry) => entry.repo_id),
      });
      return summary.repos.length === 0 ? {} : { summary };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      warning: `probe portfolio unavailable (${dbPath}): ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface PortfolioKnowledgeHygieneHistory {
  byRepo: Map<string, {
    recurring_count: number;
    oldest_open_days?: number;
  }>;
  warning?: string;
}

/** Read-only from the caller's perspective: no reports are recorded here. */
function readPortfolioKnowledgeHygieneHistory(
  entries: readonly RepoRegistryEntry[],
  asOf: number,
): PortfolioKnowledgeHygieneHistory {
  const byRepo = new Map<string, {
    recurring_count: number;
    oldest_open_days?: number;
  }>();
  const dbPath = join(osstackHome(), "state.db");
  if (!existsSync(dbPath)) return { byRepo };
  try {
    const db = openDb({ path: dbPath, readwrite: false });
    try {
      for (const entry of entries) {
        const trend = queryKnowledgeHygieneTrendV2(db, entry.repo_id, {
          as_of: asOf,
        });
        byRepo.set(entry.repo_id, {
          recurring_count: trend.recurrence.warning,
          ...(trend.open.oldest_age_days === null
            ? {}
            : { oldest_open_days: trend.open.oldest_age_days }),
        });
      }
    } finally {
      db.close();
    }
    return { byRepo };
  } catch (error) {
    return {
      byRepo,
      warning: `knowledge hygiene history unavailable (${dbPath}): ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ── Delta ──────────────────────────────────────────────────────────────────

/** Pure diff of the current scan against the previous persisted brief. */
export function computeDelta(
  previous: DailyBrief | undefined,
  current: { portfolio: PortfolioReport; github: RepoGithubStatus[] },
): DailyDelta {
  if (previous === undefined) {
    return { is_first_run: true, new_prs: [], ci_flips: [], maturity_changes: [] };
  }

  const prevPrNumbers = new Map<string, Set<number>>();
  const prevCi = new Map<string, string>();
  for (const g of previous.github) {
    prevPrNumbers.set(g.repo_id, new Set(g.pull_requests.map((pr) => pr.number)));
    prevCi.set(g.repo_id, repoCiStatus(g));
  }
  const prevMaturity = new Map<string, number>();
  for (const repo of previous.portfolio.repos) prevMaturity.set(repo.repo_id, repo.closed_loop_level);

  const new_prs: DailyDelta["new_prs"] = [];
  const ci_flips: DailyDelta["ci_flips"] = [];
  for (const g of current.github) {
    const known = prevPrNumbers.get(g.repo_id);
    for (const pr of g.pull_requests) {
      // A PR is "new" only when we had a prior brief for this repo and it was absent then.
      if (known !== undefined && !known.has(pr.number)) {
        new_prs.push({ repo_id: g.repo_id, number: pr.number, title: pr.title });
      }
    }
    const before = prevCi.get(g.repo_id);
    const after = repoCiStatus(g);
    if (before !== undefined && before !== after) {
      ci_flips.push({ repo_id: g.repo_id, from: before, to: after });
    }
  }

  const maturity_changes: DailyDelta["maturity_changes"] = [];
  for (const repo of current.portfolio.repos) {
    const before = prevMaturity.get(repo.repo_id);
    if (before !== undefined && before !== repo.closed_loop_level) {
      maturity_changes.push({ repo_id: repo.repo_id, from: before, to: repo.closed_loop_level });
    }
  }

  return {
    is_first_run: false,
    previous_brief_date: previous.date,
    new_prs,
    ci_flips,
    maturity_changes,
  };
}

async function readPreviousBrief(briefsDir: string, today: string): Promise<DailyBrief | undefined> {
  let files: string[];
  try {
    files = await readdir(briefsDir);
  } catch {
    return undefined;
  }
  // Dated `YYYY-MM-DD.json` files sort lexicographically = chronologically.
  // Exclude today's own file so a same-day re-run still diffs against the prior day.
  const dated = files
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== `${today}.json`)
    .sort();
  const latest = dated.at(-1);
  if (latest === undefined) return undefined;
  try {
    return JSON.parse(await readFile(join(briefsDir, latest), "utf8")) as DailyBrief;
  } catch {
    return undefined;
  }
}

// ── Owner decisions (≤3 next_actions) ────────────────────────────────────────
// The missing-LOOP.md dispatch reads `structured_recommendations` from the
// portfolio report (kind === "add_loop_doc" + a repo_id) — no free-text wording
// coupling, no `<name>: ` prefix parsing, and no display-name ambiguity.

/**
 * Derive at most three owner decisions, prioritized: failing CI first, then
 * repos with open non-draft PRs to review, then portfolio maturity gaps. The
 * `command` is a stable `<service>.<action>` protocol identifier (advisory — the
 * daily command never executes it), the `reason` is the human-facing decision,
 * and `run` is the REAL invocation the owner can dispatch (R2.4).
 *
 * CTO ruling (R1.4) — FULFILLED by R2.4 now that R1.5 (`start`/`control`) has
 * landed. The `command` ids stay decision CATEGORIES (unchanged, so no consumer
 * breaks); the dispatchable payload rides alongside in `run { command, argv }`
 * (structured data in `result`, mirroring R1.5's `deliver_command`/`deliver_args`
 * — NOT in the strict `NextAction` protocol envelope). Mapping implemented:
 *
 *   repo.fix_ci          → `osstack start "fix failing CI on <repo_id>: latest
 *                           run is <status>" --repo-id <repo_id>` (R1.5 surface).
 *   repo.review_prs      → human review, not an osstack execution: the concrete
 *                          `gh pr list --repo <slug> --state open` when the repo
 *                          has a resolved GitHub remote, else the local repo path.
 *   portfolio.raise_maturity → `osstack supervise init-loop-doc --repo <repo_id>`
 *                          ONLY when the structured recommendation is an
 *                          `add_loop_doc` kind carrying a `repo_id` (the gap that
 *                          command fixes); every other kind (or a kind without a
 *                          repo_id, e.g. `consolidation`) stays portfolio-level:
 *                          `osstack supervise report`. Because dispatch keys on
 *                          the unique `repo_id` rather than the display name,
 *                          duplicate-named repos are no longer ambiguous — they
 *                          now dispatch (an improvement over the R2.4 name-match).
 *
 * ALL interpolated values are `shQuote`'d via the shared start/control helper —
 * CI status comes from `gh` output and repo ids/slugs are treated as untrusted
 * for quoting, so nothing in a `run.command` can execute on paste.
 */
export function deriveOwnerDecisions(brief: DailyBrief): OwnerDecision[] {
  const decisions: OwnerDecision[] = autonomyOwnerDecisions(brief);
  const seenScopes = new Set<string>();
  for (const repo of brief.attention?.repos ?? []) {
    for (const scope of repo.snapshot?.scopes ?? []) {
      if (seenScopes.has(scope.scope_id) || !(scope.human_waits || scope.uncertain_answers || scope.missing_source_items)) continue;
      seenScopes.add(scope.scope_id);
      // Viewing evidence is the only suggested operation; stale facts cannot grant authority.
      const subcommand = repo.status === "available" && scope.coverage === "covered" && scope.human_waits > 0 && scope.open_items > 0 ? "inbox" : "inventory";
      const argv = ["osstack", "attention", subcommand, "--scope", scope.scope_id];
      decisions.push({ command: `attention.${subcommand}`,
        reason: `Review scope ${scope.scope_id}: human waits ${scope.human_waits}, uncertain answers ${scope.uncertain_answers}, source missing ${scope.missing_source_items}; observation ${repo.status}`,
        run: { command: argv.map(shQuote).join(" "), argv },
      });
    }
  }
  const pathById = new Map(brief.portfolio.repos.map((r) => [r.repo_id, r.path]));

  for (const g of brief.github) {
    const status = repoCiStatus(g);
    if (FAILING_CI.has(status)) {
      const goal = `fix failing CI on ${g.repo_id}: latest run is ${status}`;
      decisions.push({
        command: "repo.fix_ci",
        reason: `${g.repo_id}: latest CI is ${status} — investigate before shipping`,
        run: {
          command: `osstack start ${shQuote(goal)} --repo-id ${shQuote(g.repo_id)}`,
          argv: ["osstack", "start", goal, "--repo-id", g.repo_id],
        },
      });
    }
  }
  for (const repo of brief.portfolio.repos) {
    const reasons = knowledgeHygieneIssues(repo);
    if (reasons.length === 0) continue;
    const argv = [
      "osstack",
      "neat",
      "check",
      "--repo",
      repo.path,
      "--all",
      "--fail-on",
      "warning",
    ];
    decisions.push({
      command: "knowledge_hygiene.check",
      reason: `${repo.repo_id}: knowledge hygiene ${reasons.join(", ")}`,
      run: {
        command: `osstack neat check --repo ${shQuote(repo.path)} --all --fail-on warning`,
        argv,
      },
    });
  }
  for (const g of brief.github) {
    const openPrs = g.pull_requests.filter((pr) => !pr.isDraft);
    if (openPrs.length > 0) {
      decisions.push({
        command: "repo.review_prs",
        reason: `${g.repo_id}: ${openPrs.length} open PR(s) awaiting review`,
        run: reviewPrsRun(g, pathById.get(g.repo_id)),
      });
    }
  }
  // Prefer the structured list (dispatch on kind + repo_id). Fresh briefs always
  // carry it; a previous brief read from disk that predates the field simply has
  // no raise_maturity decisions here (deriveOwnerDecisions only runs on the fresh
  // brief in practice, so this fallback is defensive).
  for (const rec of brief.portfolio.structured_recommendations ?? []) {
    decisions.push({
      command: "portfolio.raise_maturity",
      reason: rec.text,
      run: raiseMaturityRun(rec),
    });
  }

  return decisions.slice(0, 3);
}

function autonomyOwnerDecisions(brief: DailyBrief): OwnerDecision[] {
  const attention = brief.autonomy?.attention;
  if (attention === undefined) return [];
  const decisions: OwnerDecision[] = [];
  const seenRuns = new Set<string>();
  const addRun = (
    command: string,
    reason: string,
    runId: string,
  ): void => {
    if (seenRuns.has(runId)) return;
    seenRuns.add(runId);
    decisions.push({
      command,
      reason,
      run: {
        command: `osstack autonomy status ${shQuote(runId)} --json`,
        argv: ["osstack", "autonomy", "status", runId, "--json"],
      },
    });
  };
  for (const item of attention.rollback_failed) {
    addRun(
      "autonomy.rollback_failed",
      `${item.repo_id}: rollback failed in ${item.run_id}`,
      item.run_id,
    );
  }
  for (const freeze of attention.production_frozen) {
    decisions.push({
      command: "autonomy.production_frozen",
      reason: `${freeze.repo_id}: production frozen — ${freeze.reason}`,
      run: {
        command:
          `osstack autonomy freeze request ${shQuote(freeze.repo_id)} --json`,
        argv: [
          "osstack",
          "autonomy",
          "freeze",
          "request",
          freeze.repo_id,
          "--json",
        ],
      },
    });
  }
  for (const item of attention.delivery_evidence_failed) {
    addRun(
      "autonomy.delivery_evidence_failed",
      `${item.repo_id}: proof integrity failed in ${item.run_id}`,
      item.run_id,
    );
  }
  for (const item of attention.awaiting_approval) {
    addRun(
      "autonomy.awaiting_approval",
      `${item.repo_id}: signed Owner decision required for ${item.run_id}`,
      item.run_id,
    );
  }
  for (const item of attention.escalated) {
    addRun(
      "autonomy.escalated",
      `${item.repo_id}: ${item.run_id} escalated`,
      item.run_id,
    );
  }
  for (const item of attention.blocked_delivery) {
    addRun(
      "autonomy.blocked_delivery",
      `${item.repo_id}: ${item.run_id} is waiting for external delivery recovery`,
      item.run_id,
    );
  }
  if (
    attention.adapter_unavailable.length > 0
    && decisions.length < 3
  ) {
    decisions.push({
      command: "autonomy.adapter_unavailable",
      reason:
        `${attention.adapter_unavailable.length} autonomy run(s) require adapter recovery`,
      run: {
        command: "osstack autonomy health --json",
        argv: ["osstack", "autonomy", "health", "--json"],
      },
    });
  }
  return decisions;
}

function knowledgeHygieneWarnings(portfolio: PortfolioReport): string[] {
  return portfolio.repos.flatMap((repo) => {
    const issues = knowledgeHygieneIssues(repo);
    return issues.length === 0
      ? []
      : [`${repo.repo_id}: knowledge hygiene ${issues.join(", ")}`];
  });
}

function knowledgeHygieneIssues(
  repo: PortfolioReport["repos"][number],
): string[] {
  const scanFailed = repo.findings.some((finding) =>
    finding.startsWith("knowledge hygiene scan failed:")
  );
  const hygiene = repo.hygiene;
  if (hygiene === undefined) return scanFailed ? ["scan failed"] : [];
  return [
    ...(!hygiene.complete ? ["scan incomplete"] : []),
    ...(hygiene.health_claim === "assessment_incomplete"
      ? ["assessment incomplete"]
      : []),
    ...(hygiene.error_count > 0 ? [`${hygiene.error_count} open error(s)`] : []),
    ...(hygiene.warning_count > 0 && hygiene.recurring_count > 0
      ? [`${hygiene.recurring_count} recurring warning(s)`]
      : []),
  ];
}

/**
 * review_prs is a human action, so it maps to a read-only `gh pr list` for the
 * resolved remote. The no-remote branch is defensive: PRs only populate when a
 * GitHub slug resolved, so in practice `g.remote` is always set here — but if it
 * ever is not, we point the human at the local repo path rather than emit a
 * broken `gh` line.
 */
function reviewPrsRun(g: RepoGithubStatus, repoPath: string | undefined): RunnableInvocation {
  if (g.remote !== undefined) {
    return {
      command: `gh pr list --repo ${shQuote(g.remote)} --state open`,
      argv: ["gh", "pr", "list", "--repo", g.remote, "--state", "open"],
    };
  }
  const target = repoPath ?? g.repo_id;
  return { command: shQuote(target), argv: [target] };
}

/**
 * portfolio.raise_maturity → `init-loop-doc` ONLY for an `add_loop_doc`
 * structured recommendation that carries a `repo_id` (the gap that command
 * remedies). The `repo_id` is registry-unique, so duplicate display names are no
 * longer ambiguous. Every other kind — or an `add_loop_doc` without a repo_id —
 * stays portfolio-level `supervise report`.
 */
function raiseMaturityRun(rec: StructuredRecommendation): RunnableInvocation {
  if (rec.kind === "add_loop_doc" && rec.repo_id !== undefined) {
    const repoId = rec.repo_id;
    return {
      command: `osstack supervise init-loop-doc --repo ${shQuote(repoId)}`,
      argv: ["osstack", "supervise", "init-loop-doc", "--repo", repoId],
    };
  }
  return { command: "osstack supervise report", argv: ["osstack", "supervise", "report"] };
}

// ── Protocol result ──────────────────────────────────────────────────────────

/** Assemble the strict AgentCommandResult (validated by the protocol schema in tests). */
export function buildDailyResult(
  brief: DailyBrief,
  briefPath: string,
  entries: RepoRegistryEntry[],
): AgentCommandResult {
  const pathById = new Map(entries.map((e) => [e.repo_id, e.path]));
  const evidence_refs: NonNullable<AgentCommandResult["evidence_refs"]> = [
    { kind: "report", ref: briefPath },
  ];
  for (const g of brief.github) {
    evidence_refs.push({
      kind: "external",
      ref: g.remote !== undefined ? `https://github.com/${g.remote}` : (pathById.get(g.repo_id) ?? g.repo_id),
    });
  }

  // The strict `NextAction` envelope stays { command, reason } (A-003) — the
  // dispatchable `run` payloads ride in `result` (= the brief), never in the
  // protocol envelope, so no NextAction consumer breaks (R2.4 non-goal).
  const next_actions = (brief.owner_decisions ?? []).map((d) => ({ command: d.command, reason: d.reason }));

  const result: AgentCommandResult = {
    protocol_version: PROTOCOL_VERSION,
    status: "ok",
    result: brief as unknown as Record<string, unknown>,
    evidence_refs,
    ...(next_actions.length > 0 ? { next_actions } : {}),
  };
  return result;
}

// ── Markdown render ──────────────────────────────────────────────────────────

export function renderDailyMarkdown(brief: DailyBrief): string {
  const githubById = new Map(brief.github.map((g) => [g.repo_id, g]));
  const lines: string[] = [];
  lines.push(`# Portfolio Daily Brief — ${brief.date}`, "");
  lines.push("## Summary");
  lines.push(`- generated_at: ${brief.generated_at}`);
  lines.push(
    `- repos: ${brief.portfolio.enabled_repo_count} enabled / ${brief.portfolio.repo_count}`,
  );
  lines.push(`- average closed-loop level: ${brief.portfolio.average_closed_loop_level}`);
  if (brief.warnings.length > 0) lines.push(`- warnings: ${brief.warnings.length}`);
  lines.push("");

  lines.push("## Repos");
  if (brief.portfolio.repos.length === 0) {
    lines.push("- No repos registered.");
  }
  for (const repo of brief.portfolio.repos) {
    const g = githubById.get(repo.repo_id);
    lines.push(`### ${repo.name} [${repo.role}] L${repo.closed_loop_level}${repo.exists ? "" : " (missing)"}`);
    if (g?.warning !== undefined) {
      lines.push(`- github: ${g.warning}`);
    } else if (g !== undefined) {
      const openPrs = g.pull_requests.length;
      lines.push(`- open PRs: ${openPrs}${openPrs > 0 ? ` (#${g.pull_requests.map((p) => p.number).join(", #")})` : ""}`);
      lines.push(`- CI: ${repoCiStatus(g)}`);
      lines.push(
        g.latest_release !== undefined
          ? `- latest release: ${g.latest_release.tagName} (${g.latest_release.publishedAt})`
          : "- latest release: none",
      );
    }
    const hygiene = repo.hygiene;
    const hygieneIssues = knowledgeHygieneIssues(repo);
    if (hygiene !== undefined && hygieneIssues.length > 0) {
      lines.push(
        `- knowledge hygiene: ${hygiene.complete ? "complete" : "incomplete"}; ${hygiene.error_count} error; ${hygiene.warning_count} warning; ${hygiene.recurring_count} recurring${hygiene.oldest_open_days === undefined ? "" : `; oldest ${hygiene.oldest_open_days}d`}`,
      );
    } else if (hygieneIssues.length > 0) {
      lines.push(`- knowledge hygiene: ${hygieneIssues.join(", ")}`);
    }
  }
  lines.push("");

  if (brief.attention !== undefined) lines.push(...renderDailyAttention(brief.attention));

  if (brief.stack !== undefined) {
    lines.push("## Stack board");
    lines.push(`- board "${brief.stack.board}": ${brief.stack.total} card(s)`);
    for (const column of brief.stack.columns) lines.push(`  - ${column.name}: ${column.count}`);
    lines.push("");
  }

  if (brief.probe !== undefined) {
    lines.push("## Probe readiness");
    for (const repo of brief.probe.repos) {
      lines.push(
        `- ${repo.repo_id}: ${repo.in_progress_session_count} in progress / ${repo.session_count} total session(s)`,
      );
      const openAge = repo.oldest_open_age_days === null
        ? "oldest n/a"
        : `oldest ${repo.oldest_open_age_days}d`;
      lines.push(
        `  - open high ${repo.open_by_severity.high}, medium ${repo.open_by_severity.medium}, low ${repo.open_by_severity.low}; ${openAge}`,
      );
      lines.push(
        `  - completion ${repo.completion_percent}% (${repo.required_disposed}/${repo.required_total} required disposed); deferred due ${repo.deferred_due}; waivers active ${repo.waived_active}, expired ${repo.waived_expired}`,
      );
    }
    lines.push("");
  }

  if (brief.dependency_obligations !== undefined) {
    lines.push("## Dependency obligations");
    lines.push(`- unread: ${brief.dependency_obligations.open_count}`);
    lines.push("");
  }

  if (brief.autonomy !== undefined) {
    const weekly = brief.autonomy.weekly.metrics;
    const attention = brief.autonomy.attention;
    lines.push("## Guarded autonomy reliability");
    lines.push(
      `- unattended completion: ${weekly.unattended_completion_rate.numerator}/${weekly.unattended_completion_rate.denominator} (${Math.round(weekly.unattended_completion_rate.value * 100)}%)`,
    );
    lines.push(
      `- avoidable human intervention: ${weekly.human_intervention_rate.numerator}/${weekly.human_intervention_rate.denominator} (${Math.round(weekly.human_intervention_rate.value * 100)}%)`,
    );
    lines.push(
      `- production deploy success: ${weekly.deploy_success_rate.numerator}/${weekly.deploy_success_rate.denominator}`,
    );
    lines.push(
      `- rollback success: ${weekly.rollback_success_rate.numerator}/${weekly.rollback_success_rate.denominator}`,
    );
    lines.push(
      `- Owner notification outbox: ${brief.autonomy.notification_outbox.pending_count} pending, ${brief.autonomy.notification_outbox.dead_letter_count} dead-letter`,
    );
    lines.push("### Owner attention");
    const attentionLines = [
      ["awaiting_approval", attention.awaiting_approval.length],
      ["escalated", attention.escalated.length],
      ["blocked_delivery", attention.blocked_delivery.length],
      [
        "delivery_evidence_failed",
        attention.delivery_evidence_failed.length,
      ],
      ["production_frozen", attention.production_frozen.length],
      ["rollback_failed", attention.rollback_failed.length],
      ["adapter_unavailable", attention.adapter_unavailable.length],
    ] as const;
    const actionable = attentionLines.filter(([, count]) => count > 0);
    if (actionable.length === 0) lines.push("- None.");
    else {
      for (const [label, count] of actionable) {
        lines.push(`- ${label}: ${count}`);
      }
    }
    lines.push("");
  }

  lines.push(
    brief.delta.previous_brief_date !== undefined
      ? `## Delta since ${brief.delta.previous_brief_date}`
      : "## Delta",
  );
  if (brief.delta.is_first_run) {
    lines.push("- First run — no previous brief to diff against.");
  } else {
    lines.push(
      brief.delta.new_prs.length > 0
        ? `- New PRs: ${brief.delta.new_prs.map((p) => `${p.repo_id}#${p.number}`).join(", ")}`
        : "- New PRs: none",
    );
    lines.push(
      brief.delta.ci_flips.length > 0
        ? `- CI flips: ${brief.delta.ci_flips.map((c) => `${c.repo_id} ${c.from}→${c.to}`).join(", ")}`
        : "- CI flips: none",
    );
    lines.push(
      brief.delta.maturity_changes.length > 0
        ? `- Maturity changes: ${brief.delta.maturity_changes.map((m) => `${m.repo_id} L${m.from}→L${m.to}`).join(", ")}`
        : "- Maturity changes: none",
    );
  }
  lines.push("");

  lines.push("## Owner decisions");
  const ownerDecisions = brief.owner_decisions ?? [];
  if (ownerDecisions.length === 0) {
    lines.push("- None — portfolio looks healthy.");
  } else {
    ownerDecisions.forEach((d, i) => {
      lines.push(`${i + 1}. [${d.command}] ${d.reason}`);
      // The paste-ready runnable line under each decision (R2.4).
      lines.push(`   run: ${d.run.command}`);
    });
  }
  return `${lines.join("\n")}\n`;
}


TEST ADDITIONS

diff --git a/packages/cli/src/daily-cli.test.ts b/packages/cli/src/daily-cli.test.ts
index ce6f439c..01fc5d7f 100644
--- a/packages/cli/src/daily-cli.test.ts
+++ b/packages/cli/src/daily-cli.test.ts
@@ -838,3 +838,59 @@ describe("deriveOwnerDecisions (R2.4 dispatchable run payloads)", () => {
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
+      expect(JSON.parse(await readFile(run.briefPath, "utf8")).attention).toEqual(run.brief.attention);
+      await handleDailyCommand(["--registry", registryPath, "--json"], { ...deps, out });
+      expect(AgentCommandResult.parse(JSON.parse(logs[0]!)).status).toBe("ok");
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


DB READER

// SQLite connection management.
//
// Decisions locked in plan v0.6:
//   - better-sqlite3 (synchronous, single connection per daemon process)
//   - WAL mode for concurrent reader/writer safety
//   - synchronous=NORMAL (WAL-safe, faster than FULL)
//   - 64 MiB page cache
//   - foreign_keys ON (so ON DELETE CASCADE works for runs/events on task delete)
//
// CRITICAL GAP G1 (plan v0.6 §8.3): disk-full must never cause a silent task
// write loss. Every write goes through preflightDiskSpace(), which throws
// DiskFullError before any INSERT/UPDATE can corrupt or stall a transaction.

import Database from "better-sqlite3";
import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";

/** Default safety threshold for disk-full preflight (100 MiB). */
export const DEFAULT_MIN_FREE_BYTES = 100 * 1024 * 1024;

/** Cache size in -kibibyte units. negative = KiB (per SQLite docs). 64 MiB. */
const PAGE_CACHE_KIB = -65536;

export class DiskFullError extends Error {
  readonly path: string;
  readonly freeBytes: number;
  readonly minFreeBytes: number;
  constructor(path: string, freeBytes: number, minFreeBytes: number) {
    super(
      `Disk full preflight failed for ${path}: ${freeBytes} bytes free, ` +
      `need ≥${minFreeBytes}. Refusing write so Hermes can be notified.`,
    );
    this.name = "DiskFullError";
    this.path = path;
    this.freeBytes = freeBytes;
    this.minFreeBytes = minFreeBytes;
  }
}

export interface OpenDbOptions {
  /** Absolute path to the SQLite file (parent dir must exist). */
  path: string;
  /** When false, opens read-only. */
  readwrite?: boolean;
  /** Override the disk-full safety threshold (bytes). */
  minFreeBytes?: number;
}

/**
 * Run a free-space check against the filesystem holding `path`. Throws
 * DiskFullError if below threshold; otherwise returns free byte count.
 * Skips the check (returns Infinity) if statfsSync is unsupported on the
 * platform — better to allow writes than to crash a daemon on a kernel quirk.
 */
export function preflightDiskSpace(
  path: string,
  minFreeBytes: number = DEFAULT_MIN_FREE_BYTES,
): number {
  let stats: { bsize: number; bavail: number };
  try {
    stats = statfsSync(dirname(path));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  const free = Number(stats.bsize) * Number(stats.bavail);
  if (free < minFreeBytes) throw new DiskFullError(path, free, minFreeBytes);
  return free;
}

/**
 * Open the osstack state database, apply pragmas, and run pending migrations.
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
// a future DROP/RENAME migration must also update this lineage contract.
const tableIntroductions = MIGRATIONS.flatMap(migration =>
  [...migration.sql.matchAll(/^\s*CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-zA-Z_]\w*)\s*\(/gm)]
    .map(match => ({ name: match[1]!, version: migration.id })));

/** Reject pure or mixed unreleased Graph schemas before application pragmas or
 * DDL. SQLite may itself checkpoint an abandoned WAL on close; logical ledger
 * content and user_version must remain intact for the original binary. */
function assertMigrationLineage(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  const actual = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
  // Experimental Graph or Attention tables must never be migrated as released main.
  const experimentalTable = (name: string) => name.startsWith("graph_") || name.startsWith("attention_") || name === "daemon_owner";
  if (current < 25 && ![...actual].some(experimentalTable)) return;
  const expected = new Set(tableIntroductions.filter(table => table.version <= current).map(table => table.name));
  if ([...expected].some(name => !actual.has(name))
    || [...actual].some(name => experimentalTable(name) && !expected.has(name))) {
    throw new Error("GRAPH_EXPERIMENTAL_SCHEMA_CONFLICT: preserve this home and reconcile with its original build; do not reset user_version or reuse it for the integrated runtime");
  }
}

function assertSupportedVersion(current: number): void {
  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Migration state inconsistent: user_version=${current}, expected=${CURRENT_SCHEMA_VERSION}`);
  }
}

/**
 * Apply pending migrations idempotently. `user_version` PRAGMA tracks progress.
 * The version pragma guarantees forward-only application. Many migrations
 * contain non-idempotent CREATE/ALTER statements; never reset user_version.
 */
export function runMigrations(db: Database.Database): void {
  const currentRow = db.pragma("user_version", { simple: true }) as number;
  let current = Number(currentRow);
  assertSupportedVersion(current);
  assertMigrationLineage(db);
  for (const m of MIGRATIONS) {
    if (m.id <= current) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.id}`);
      db.exec("COMMIT");
      current = m.id;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  if (current !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Migration state inconsistent: user_version=${current}, expected=${CURRENT_SCHEMA_VERSION}`,
    );
  }
}

/**
 * Run a function inside a transaction with preflight. Use for any write path
 * called from the daemon hot loop. Wraps better-sqlite3's transaction() so
 * disk-space errors fire BEFORE BEGIN, not mid-transaction.
 */
export function withWrite<T>(
  db: Database.Database,
  path: string,
  fn: (db: Database.Database) => T,
  minFreeBytes: number = DEFAULT_MIN_FREE_BYTES,
): T {
  preflightDiskSpace(path, minFreeBytes);
  const tx = db.transaction(fn);
  return tx(db);
}


GUIDE

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
allowlisted before persistence. A cached sample older than 65 seconds is stale;
more than five seconds ahead is unknown (small RPC clock/transport skew allowed).
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

At most three owner suggestions retain existing autonomy priority, followed by
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
