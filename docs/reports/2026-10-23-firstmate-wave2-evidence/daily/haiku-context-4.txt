Review ONLY this final follow-up for the three round-3 findings. Return concise JSON {findings:[],verdict}; do not reopen previously settled architecture. Verify: discarded unknown snapshots no longer consume retained-output budget; reason distinguishes source_coverage_unknown from clock_moved_backwards; docs admit physical in-flight reads can exceed two if transport ignores abort. Note existing code checks controller.signal.throwIfAborted immediately after await reader and BEFORE any parsing/accounting, so a late aborted result never charges bytes. Report new concrete P0/P1/P2 regressions only.
Prior full audit 3 had zero P0/P1, one P2 retained-output budget bug, and two P3s described above.
diff --git a/docs/guides/attention-daily.md b/docs/guides/attention-daily.md
index 21ea9d37..02981590 100644
--- a/docs/guides/attention-daily.md
+++ b/docs/guides/attention-daily.md
@@ -28,13 +28,13 @@ more than five seconds ahead is unknown and its counts are discarded (small RPC
 Each repository snapshot is internally consistent; the whole portfolio is not one
 transaction and duplicate registry aliases must not be summed as distinct scopes.
 
-At most 100 enabled repositories are sampled with two concurrent readers, a 500 ms
+At most 100 enabled repositories are sampled with two concurrent waiting slots, a 500 ms
 per-read timeout and a two-second asynchronous budget. Remaining repositories have
 explicit unknown/omitted coverage. Each read requests at most 100 scopes; full
 repository totals remain separate from the displayed page and truncation is
 reported. Timers cannot preempt synchronous SQLite work; this relies on the bounded
 existing Attention read model. Cancellable transports should honor the supplied
-signal; late results from non-cooperating transports are discarded.
+signal. A non-cooperating transport can continue after its slot times out; underlying in-flight operations may exceed two, although no more than 100 repository reads are started and the overall asynchronous budget still applies. Late results are discarded before parsing or budget accounting.
 
 ## Decisions and compatibility
 
diff --git a/packages/cli/src/daily-attention.test.ts b/packages/cli/src/daily-attention.test.ts
index 6b9d6c41..74344f3f 100644
--- a/packages/cli/src/daily-attention.test.ts
+++ b/packages/cli/src/daily-attention.test.ts
@@ -99,6 +99,8 @@ it("drops future-clock counts instead of suggesting a current human wait", async
   expect(mismatch.repos[0]?.reason).toBe("invalid_snapshot");
   const futureScope = await readDailyAttention(entries(), { nowMs: 100, reader: () => ({ ...raw, status: "stale", sampled_at_ms: 100, scopes: raw.scopes.map(scope => ({ ...scope, coverage: "unknown", reason: "clock_moved_backwards" })) }) });
   expect(futureScope.repos[0]).toMatchObject({ status: "unknown", reason: "clock_moved_backwards", snapshot: null });
+  const unknownScope = await readDailyAttention(entries(), { nowMs: 100, reader: () => ({ ...raw, sampled_at_ms: 100, scopes: raw.scopes.map(scope => ({ ...scope, sampled_at_ms: 100, coverage: "unknown", reason: "source_unknown" })) }) });
+  expect(unknownScope.repos[0]).toMatchObject({ status: "unknown", reason: "source_coverage_unknown", snapshot: null });
 });
 
 it("caps persisted snapshot bytes and discloses budget-exhausted repository coverage", async () => {
@@ -108,7 +110,11 @@ it("caps persisted snapshot bytes and discloses budget-exhausted repository cove
   const result = await readDailyAttention(Array.from({ length: 3 }, (_, n) => ({ ...entries()[0]!, repo_id: String(n) })), { nowMs: 100, reader: () => raw });
   expect(result.repos.filter(repo => repo.reason === "response_budget_exhausted")).toHaveLength(1);
   expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2 * 1024 * 1024);
-  const timed = await readDailyAttention(Array.from({ length: 4 }, (_, n) => ({ ...entries()[0]!, repo_id: String(n) })), { nowMs: 100, budgetMs: 10, timeoutMs: 50, reader: () => new Promise(() => {}) });
+  let call = 0;
+  const discarded = await readDailyAttention(Array.from({ length: 3 }, (_, n) => ({ ...entries()[0]!, repo_id: String(n) })), { nowMs: 100, reader: () => ++call === 1 ? { ...raw, sampled_at_ms: 10_000 } : raw });
+  expect(discarded.repos.filter(repo => repo.status === "available")).toHaveLength(2);
+  expect(discarded.repos.some(repo => repo.reason === "response_budget_exhausted")).toBe(false);
+  const timed = await readDailyAttention(Array.from({ length: 10 }, (_, n) => ({ ...entries()[0]!, repo_id: String(n) })), { nowMs: 100, budgetMs: 10, timeoutMs: 50, reader: () => new Promise(() => {}) });
   expect(timed.repos.some(repo => repo.reason === "budget_exhausted")).toBe(true);
   expect(renderDailyAttention(timed).join("\n")).toContain("budget\\_exhausted");
 });
diff --git a/packages/cli/src/daily-attention.ts b/packages/cli/src/daily-attention.ts
index 3b1479cb..85fe4dd9 100644
--- a/packages/cli/src/daily-attention.ts
+++ b/packages/cli/src/daily-attention.ts
@@ -93,14 +93,18 @@ export async function readDailyAttention(
             for (const key of Object.keys(counts.shape) as (keyof z.infer<typeof counts>)[])
               if (snapshot.totals[key] !== snapshot.scopes.reduce((sum, scope) => sum + scope[key], 0)) throw new Error("invalid_snapshot");
           }
-          const bytes = Buffer.byteLength(JSON.stringify(snapshot));
-          if (persistedBytes + bytes > 2 * 1024 * 1024) throw new Error("response_budget_exhausted");
-          persistedBytes += bytes;
-          const clockInvalid = snapshot.sampled_at_ms > options.nowMs + 5000 || snapshot.scopes.some(scope => scope.coverage === "unknown");
+          const unknownScope = snapshot.scopes.some(scope => scope.coverage === "unknown");
+          const clockInvalid = snapshot.sampled_at_ms > options.nowMs + 5000 || snapshot.scopes.some(scope => scope.coverage === "unknown" && (scope.reason === "clock_moved_backwards" || scope.sampled_at_ms > options.nowMs + 5000));
           const stale = options.nowMs - snapshot.sampled_at_ms > 65_000;
           const expiredEmpty = stale && snapshot.status === "not_watched";
-          return { workspace_path: path, status: clockInvalid || expiredEmpty ? "unknown" as const : snapshot.status === "unavailable" ? "unknown" as const : stale && snapshot.totals ? "stale" as const : snapshot.status,
-            reason: clockInvalid ? "clock_moved_backwards" : stale && snapshot.totals ? "cached_snapshot_expired" : snapshot.reason, snapshot: clockInvalid || expiredEmpty ? null : snapshot };
+          const discard = clockInvalid || unknownScope || expiredEmpty;
+          if (!discard) {
+            const bytes = Buffer.byteLength(JSON.stringify(snapshot));
+            if (persistedBytes + bytes > 2 * 1024 * 1024) throw new Error("response_budget_exhausted");
+            persistedBytes += bytes;
+          }
+          return { workspace_path: path, status: discard ? "unknown" as const : snapshot.status === "unavailable" ? "unknown" as const : stale && snapshot.totals ? "stale" as const : snapshot.status,
+            reason: clockInvalid ? "clock_moved_backwards" : unknownScope ? "source_coverage_unknown" : stale && snapshot.totals ? "cached_snapshot_expired" : snapshot.reason, snapshot: discard ? null : snapshot };
         };
         Object.assign(result, await Promise.race([read(), failure]));
       } catch (error) {

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
          const unknownScope = snapshot.scopes.some(scope => scope.coverage === "unknown");
          const clockInvalid = snapshot.sampled_at_ms > options.nowMs + 5000 || snapshot.scopes.some(scope => scope.coverage === "unknown" && (scope.reason === "clock_moved_backwards" || scope.sampled_at_ms > options.nowMs + 5000));
          const stale = options.nowMs - snapshot.sampled_at_ms > 65_000;
          const expiredEmpty = stale && snapshot.status === "not_watched";
          const discard = clockInvalid || unknownScope || expiredEmpty;
          if (!discard) {
            const bytes = Buffer.byteLength(JSON.stringify(snapshot));
            if (persistedBytes + bytes > 2 * 1024 * 1024) throw new Error("response_budget_exhausted");
            persistedBytes += bytes;
          }
          return { workspace_path: path, status: discard ? "unknown" as const : snapshot.status === "unavailable" ? "unknown" as const : stale && snapshot.totals ? "stale" as const : snapshot.status,
            reason: clockInvalid ? "clock_moved_backwards" : unknownScope ? "source_coverage_unknown" : stale && snapshot.totals ? "cached_snapshot_expired" : snapshot.reason, snapshot: discard ? null : snapshot };
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

$ vitest run src/daily-attention.test.ts src/daily-cli.test.ts src/attention-dashboard.test.ts

 RUN  v3.2.6 /Volumes/AIMATE_WORK/Developer/CodeX/.worktrees/osstack/firstmate-cockpit/packages/cli

 ❯ src/daily-attention.test.ts (15 tests | 1 failed) 69ms
   ✓ keeps unavailable, disabled, and absent provider distinct without fabricated counts or DB migrations 7ms
   ✓ rejects a malformed or wrongly scoped RPC snapshot: {"tenant":"foreign"} 1ms
   ✓ rejects a malformed or wrongly scoped RPC snapshot: {"workspace_path":"/elsewhere"} 1ms
   ✓ rejects a malformed or wrongly scoped RPC snapshot: {"scope_filter":"local_overview"} 1ms
   ✓ rejects a malformed or wrongly scoped RPC snapshot: {"scopes":[{"scope_id":"evil"}]} 1ms
   ✓ rejects a malformed or wrongly scoped RPC snapshot: {"returned":1} 1ms
   × bounds stalled reads, propagates abort, and still reads another repo 26ms
     → expected [ 'disabled', 'unknown' ] to deeply equal [ 'unknown', 'disabled' ]
   ✓ does not call providers after cancellation and caps enabled registry work 1ms
   ✓ escapes untrusted Markdown and terminal controls in its own section 2ms
   ✓ rejects stale cached health claims and discloses truncated full totals 1ms
   ✓ accepts small RPC clock skew but labels a far-future snapshot unknown 1ms
   ✓ rejects truncated snapshots that hide omitted scopes or lack a continuation cursor 1ms
   ✓ shows not-watched coverage without presenting zero waits and classifies missing paths 1ms
   ✓ drops future-clock counts instead of suggesting a current human wait 1ms
   ✓ caps persisted snapshot bytes and discloses budget-exhausted repository coverage 26ms
 ✓ src/attention-dashboard.test.ts (9 tests) 182ms
 ✓ src/daily-cli.test.ts (25 tests) 852ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/daily-attention.test.ts > bounds stalled reads, propagates abort, and still reads another repo
AssertionError: expected [ 'disabled', 'unknown' ] to deeply equal [ 'unknown', 'disabled' ]

- Expected
+ Received

  [
-   "unknown",
    "disabled",
+   "unknown",
  ]

 ❯ src/daily-attention.test.ts:37:43
     35|     reader: (() => { let calls = 0; return ({ signal }) => { if (++cal…
     36|   });
     37|   expect(result.repos.map(r => r.status)).toEqual(["unknown", "disable…
       |                                           ^
     38|   expect(result.repos[0]?.reason).toBe("read_timeout");
     39|   expect(aborted).toBe(true);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed | 2 passed (3)
      Tests  1 failed | 48 passed (49)
   Start at  11:57:53
   Duration  2.23s (transform 712ms, setup 25ms, collect 1.38s, tests 1.10s, environment 0ms, prepare 89ms)

/Volumes/AIMATE_WORK/Developer/CodeX/.worktrees/osstack/firstmate-cockpit/packages/cli:
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @osstack/cli@0.21.0 test: `vitest run src/daily-attention.test.ts src/daily-cli.test.ts src/attention-dashboard.test.ts`
Exit status 1

$ tsc --noEmit
