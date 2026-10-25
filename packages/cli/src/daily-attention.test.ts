import { afterEach, beforeEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
  const other = join(root, "other"); mkdirSync(other);
  const result = await readDailyAttention([...entries(), { repo_id: "two", path: other, enabled: true }], {
    nowMs: 100, timeoutMs: 20, budgetMs: 100,
    reader: ({ workspacePath, signal }) => {
      if (workspacePath === other) return { ...snapshot(), workspace_path: other };
      signal.addEventListener("abort", () => { aborted = true; });
      return new Promise(() => {});
    },
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
  const unknownScope = await readDailyAttention(entries(), { nowMs: 100, reader: () => ({ ...raw, sampled_at_ms: 100, scopes: raw.scopes.map(scope => ({ ...scope, sampled_at_ms: 100, coverage: "unknown", reason: "source_unknown" })) }) });
  expect(unknownScope.repos[0]).toMatchObject({ status: "unknown", reason: "source_coverage_unknown", snapshot: null });
});

it("caps persisted snapshot bytes and discloses budget-exhausted repository coverage", async () => {
  const counts = { subjects: 1, unmonitored_subjects: 0, human_waits: 1, system_waits: 0, unknown_waits: 0, items: 1, other_items: 0, open_items: 1, pending_answers: 0, uncertain_answers: 0, missing_source_items: 0, applied_answers: 0, dead_letters: 0 };
  const totals = Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value * 100]));
  const raw = { ...snapshot(), status: "available", totals: { ...totals, scopes: 100 }, returned: 100, scopes: Array.from({ length: 100 }, (_, n) => ({ ...counts, scope_id: n.toString(16).padStart(64, "0"), task_id: "task", task_title: "t".repeat(4096), repo_path: root, sampled_at_ms: 100, coverage: "covered", reason: "r".repeat(4096) })) };
  const result = await readDailyAttention(Array.from({ length: 3 }, (_, n) => ({ ...entries()[0]!, repo_id: String(n) })), { nowMs: 100, reader: () => raw });
  expect(result.repos.filter(repo => repo.reason === "response_budget_exhausted")).toHaveLength(1);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2 * 1024 * 1024);
  let call = 0;
  const discarded = await readDailyAttention(Array.from({ length: 3 }, (_, n) => ({ ...entries()[0]!, repo_id: String(n) })), { nowMs: 100, reader: () => ++call === 1 ? { ...raw, sampled_at_ms: 10_000 } : raw });
  expect(discarded.repos.filter(repo => repo.status === "available")).toHaveLength(2);
  expect(discarded.repos.some(repo => repo.reason === "response_budget_exhausted")).toBe(false);
  const timed = await readDailyAttention(Array.from({ length: 10 }, (_, n) => ({ ...entries()[0]!, repo_id: String(n) })), { nowMs: 100, budgetMs: 10, timeoutMs: 50, reader: () => new Promise(() => {}) });
  expect(timed.repos.some(repo => repo.reason === "budget_exhausted")).toBe(true);
  expect(renderDailyAttention(timed).join("\n")).toContain("budget\\_exhausted");
});
