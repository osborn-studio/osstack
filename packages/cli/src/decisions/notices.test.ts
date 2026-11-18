import { readFileSync } from "node:fs";
import { openDb, DecisionQueries, type DecisionQuery, type DecisionRow } from "@osstack/core";
import type Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { createDecisionNoticeSource } from "./notices.js";

const row = (id: string): DecisionRow => ({
  id, scope_id: null, waiting_since: null, revision: null, summary: "Check /private/work/file at https://host.invalid/private",
  state: "escalated", reason: null, kind: "loop_card", details_json: "{}",
});

it("prepares only SELECTs and imports only read dependencies", () => {
  const db = openDb({ path: ":memory:" });
  try {
    db.pragma("query_only=ON");
    const prepare = vi.spyOn(db, "prepare");
    const source = createDecisionNoticeSource(new DecisionQueries(db), () => ["scope"], Date.now);
    expect(source.pending()).toEqual([]);
    expect(source.incompleteSources).toEqual([]);
    expect(prepare).toHaveBeenCalledTimes(6);
    for (const [sql] of prepare.mock.calls) expect(sql).toMatch(/^SELECT /);
  } finally { db.close(); }
  const imports = [...readFileSync(new URL("./notices.ts", import.meta.url), "utf8").matchAll(/from ["']([^"']+)/g)].map(m => m[1]);
  expect(imports.every(name => ["node:crypto", "./list.js", "@osstack/core", "@osstack/protocol", "../contained-mission-redact.js"].includes(name!))).toBe(true);
});

it("pages to the cap, distinguishes truncation, and keeps first sight stable without a journal", () => {
  const queries = new DecisionQueries({ prepare: () => ({ all: () => [] }) } as unknown as Database.Database);
  const rows = Array.from({ length: 501 }, (_, i) => row(String(i).padStart(3, "0")));
  const read = vi.spyOn(queries, "loop").mockImplementation((q: DecisionQuery) => rows.filter(r => r.id > q.after).slice(0, q.limit));
  let now = 10;
  const source = createDecisionNoticeSource(queries, () => [], () => now++);
  const first = source.pending();
  expect(first).toHaveLength(500);
  expect(source.truncated).toBe(true);
  expect(read.mock.calls.every(([q]) => q.limit <= 100)).toBe(true);
  expect(first[0]).toMatchObject({ scope_id: "host", waiting_since: 10 });
  expect(first[0]!.reference).not.toMatch(/private|host\.invalid/);
  rows.pop();
  rows[0]!.summary = "updated title";
  expect(source.pending()[0]).toMatchObject({ item_id: first[0]!.item_id, waiting_since: 10 });
  expect(source.truncated).toBe(false);
});

it("sends the redacted reference and its opaque identifiers in the webhook body", async () => {
  const queries = new DecisionQueries({ prepare: () => ({ all: () => [] }) } as unknown as Database.Database);
  const token = "fixture-secret-123";
  vi.spyOn(queries, "autonomy").mockReturnValue([{ ...row("run-1"), summary:
    "Review /private/work/file https://host.invalid/x Authorization: Bearer " + token }]);
  const [decision] = createDecisionNoticeSource(queries, () => [], Date.now).pending();
  const { webhookAttentionSender } = await import("../attention-webhook-delivery.js");
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  await webhookAttentionSender({ url: new URL("https://fixture.invalid"), key: null }, { send })({
    delivery_id: decision!.item_id + ":1", item_id: decision!.item_id, scope_id: "host",
    decision: decision!, question: decision!.reference, state: "open",
  }, new AbortController().signal);
  const body = String(send.mock.calls[0]?.[1]?.body);
  expect(body).not.toMatch(/private|host\.invalid|https?:\/\/|fixture-secret/);
  expect(JSON.parse(body)).toMatchObject({ item_id: decision!.item_id, reason_code: "decision_pending_local",
    decision: { source: "autonomy", source_id: "run-1", local_signature_required: true },
    reference: { usage: "reference_only", summary: decision!.reference } });
});
