Final focused static audit of corrected daily Attention implementation. Tools disabled. Return concise JSON {findings:[{priority,location,trigger,issue}], verdict}; <=800 words; only concrete confirmed problems. Do not assume missing schema/type evidence.
Prior round: DA1 expired not_watched showing zero fixed: expiredEmpty becomes unknown + snapshot null. DA4 scope clock unknown now makes whole repo unknown + snapshot null. DA2 TS-null claim disproved by actual successful tsc output, and explicit snapshot guard added for clarity. DA3 nullable sample claim disproved by actual migration NOT NULL DEFAULT 0; integration test proves newly registered unscanned scope remains stale with sample0 instead of invalid. Do not repeat corrected or disproven findings. Other boundaries remain canonical defaulttenant, bounded observer reads, no mutations, advisory-only real inbox/inventory CLI. Review provided exact code. Incomplete counts rejected, output2MiB capped. Timers do not preempt synchronousSQLite (known documented limit), max100scopes store enforced. Root owns actual bin/daemon injection; branch touches shared brief core only.
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
  const cached = await readDailyAttention(entries(), { nowMs: 70_000, reader: () => ({ ...snapshot(), status: "not_watched", totals: counts }) });
  expect(cached.repos[0]).toMatchObject({ status: "unknown", snapshot: null });
  expect(renderDailyAttention(cached).join("\n")).not.toContain("human 0");
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
  const futureScope = await readDailyAttention(entries(), { nowMs: 100, reader: () => ({ ...raw, status: "stale", sampled_at_ms: 100, scopes: raw.scopes.map(scope => ({ ...scope, coverage: "unknown", reason: "clock_moved_backwards" })) }) });
  expect(futureScope.repos[0]).toMatchObject({ status: "unknown", reason: "clock_moved_backwards", snapshot: null });
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
allowlisted before persistence, with a two MiB aggregate snapshot budget. Overflow is unknown. A cached nonempty sample older than 65 seconds is stale; an expired empty sample is unknown.
more than five seconds ahead is unknown and its counts are discarded (small RPC clock/transport skew allowed). A scope whose source coverage is unknown also invalidates the repository counts. A not-watched repository shows absent coverage rather than zero waits. The Attention sampling clock is captured after other daily scans, separately from the brief generation start.
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

INTEGRATION DIFF
diff --git a/packages/cli/src/daily-cli.test.ts b/packages/cli/src/daily-cli.test.ts
index ce6f439c..b24f8668 100644
--- a/packages/cli/src/daily-cli.test.ts
+++ b/packages/cli/src/daily-cli.test.ts
@@ -838,3 +838,70 @@ describe("deriveOwnerDecisions (R2.4 dispatchable run payloads)", () => {
     );
   });
 });
+
+describe("daily Attention integration", () => {
+  it("persists injected scoped supervision and keeps decisions advisory", async () => {
+    const registryPath = await seedRegistry();
+    const { AttentionStore } = await import("@osstack/core");
+    const { insertTask } = await import("./store.js");
+    const { createDailyAttentionReader, readDailyAttention } = await import("./daily-attention.js");
+    const nowMs = Date.parse("2026-07-11T09:00:00Z");
+    const db = openDb({ path: join(tmp, "attention.db") });
+    try {
+      const store = new AttentionStore(db, join(tmp, "attention.db"));
+      const owner = store.claimOwner("daily-test");
+      const selectedRepo = await realpath(join(tmp, "withgh"));
+      insertTask(db, store.path, { task_id: "selected", title: "Human decision", created_at: 1 });
+      const scope = store.registerScope(owner, "selected", selectedRepo);
+      const unscanned = await readDailyAttention([{ repo_id: "selected", path: selectedRepo, enabled: true }], { nowMs, reader: createDailyAttentionReader(db, () => "running") });
+      expect(unscanned.repos[0]).toMatchObject({ status: "stale", snapshot: { scopes: [{ sampled_at_ms: 0 }] } });
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
+      const clockBack = await runDailyBrief({ registryPath, ...deps, now: () => new Date(nowMs - 1000) });
+      expect(clockBack.brief.attention?.repos[0]).toMatchObject({ status: "unknown", reason: "clock_moved_backwards", snapshot: null });
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

packages/core/src/state/migrations.ts
      );
      CREATE TABLE attention_scopes (
        scope_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, repo_path TEXT NOT NULL,
        discovery_after TEXT NOT NULL DEFAULT '', scan_complete INTEGER NOT NULL DEFAULT 0,
        sampled_at INTEGER NOT NULL DEFAULT 0, deadline INTEGER NOT NULL DEFAULT 0,
        generation INTEGER NOT NULL, error TEXT, UNIQUE(task_id,repo_path)
      );
      CREATE TABLE attention_subjects (
        scope_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('session','run','loop')), subject_id TEXT NOT NULL,
        binding_hash TEXT NOT NULL, source_version INTEGER NOT NULL, ordinal_cursor INTEGER NOT NULL DEFAULT 0,
        admitted INTEGER NOT NULL DEFAULT 0, discovered_at INTEGER NOT NULL, sampled_at INTEGER NOT NULL,
        generation INTEGER NOT NULL, payload_json TEXT NOT NULL,
        PRIMARY KEY(scope_id,kind,subject_id)
      );
packages/core/src/state/attention-store.ts
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
  }
  getItem(scopeId: string, itemId: string): AttentionItem | undefined {
    const row = this.db
      .prepare("SELECT * FROM attention_items WHERE scope_id=? AND item_id=?")
      .get(scopeId, itemId) as ItemRow | undefined;
    return row ? parseItem(row) : undefined;
  }
  listItems(scopeId: string, after = "", limit = 100): AttentionItem[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("invalid_limit");
    return (
      this.db
        .prepare(
packages/cli/src/supervision-service.ts
      return this.store.db
        .prepare(
          "SELECT * FROM attention_deliveries WHERE scope_id=? AND delivery_id>? ORDER BY delivery_id LIMIT 100"
        )
        .all(scopeId, typeof p["after"] === "string" ? p["after"] : "");
    if (method === "attention.inventory")
      return this.observer.inventory(
        scopeId,
        Date.now(),
        typeof p["after"] === "string" ? p["after"] : ""
      );
    if (method === "attention.inbox") {
      const items = this.store.listItems(
        scopeId,
        typeof p["after"] === "string" ? p["after"] : ""
      );
      const counts = this.store.db
        .prepare(
          "SELECT state,COUNT(*) total FROM attention_items WHERE scope_id=? GROUP BY state"
        )
        .all(scopeId);
      return AttentionInbox.parse({
        schema_version: 1,
        execution_takeover: false,
        scope_id: scopeId,
        items,
        counts,
        next_after: items.length === 100 ? items.at(-1)!.item_id : null,
        coverage: this.observer.inventory(scopeId).coverage,
      });
    }
    if (method === "attention.get") {
      const item = this.store.getItem(scopeId, str("item_id"));
      if (!item) throw new Error("not_found");
      return item;
packages/cli/src/daily-command.ts
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
packages/core/src/state/db.ts
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

tests-final.log
$ vitest run src/daily-attention.test.ts src/daily-cli.test.ts src/attention-dashboard.test.ts

 RUN  v3.2.6 /Volumes/AIMATE_WORK/Developer/CodeX/.worktrees/osstack/firstmate-cockpit/packages/cli

 ✓ src/daily-attention.test.ts (15 tests) 55ms
 ✓ src/attention-dashboard.test.ts (9 tests) 201ms
 ✓ src/daily-cli.test.ts (25 tests) 607ms

 Test Files  3 passed (3)
      Tests  49 passed (49)
   Start at  11:54:02
   Duration  1.68s (transform 530ms, setup 28ms, collect 1.02s, tests 864ms, environment 0ms, prepare 87ms)


typecheck-final.log
$ tsc --noEmit

biome-final.log
Checked 4 files in 10ms. No fixes applied.
