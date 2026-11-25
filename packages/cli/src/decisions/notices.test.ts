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
    expect(prepare).toHaveBeenCalledTimes(7);
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

it.each(["contained_mission", "ci_repair", "autonomy", "hermes", "revision_chain", "loop"] as const)("preserves %s delivery identity", async source => {
  const { createHash } = await import("node:crypto");
  const queries = new DecisionQueries({ prepare: () => ({ all: () => [] }) } as unknown as Database.Database);
  vi.spyOn(queries, source).mockReturnValue([{ ...row("item"), waiting_since: 17 }]);
  const id = createHash("sha256").update(JSON.stringify([source, "item", 17])).digest("hex").slice(0,32);
  expect(createDecisionNoticeSource(queries, () => ["scope"], Date.now).pending()[0]?.item_id).toBe("decision:" + id);
});

it.each(["ci_repair","local_failure_repair"])("offers only abandon for a stopped %s candidate", async kind => {
  const { decisionItem } = await import("./list.js");
  expect(decisionItem("contained_mission", { ...row("stop"), reason: "verify_chain_depth_limit", state: "awaiting_decision",
    details_json: JSON.stringify({ [kind]: {} }) }).allowed_answers).toEqual(["abandon"]);
});

it.each(['{"origin_mission_id":"root","parent_mission_id":"parent","depth":9}', 'broken'])("keeps a legacy or unreadable lineage notice ordinary", lineage_json => {
  const queries = new DecisionQueries({ prepare: () => ({ all: () => [] }) } as unknown as Database.Database);
  vi.spyOn(queries, "contained_mission").mockReturnValue([{ ...row("stop"), state: "awaiting_decision", reason: "verify_chain_depth_limit", lineage_json }]);
  const notice = createDecisionNoticeSource(queries, () => ["scope"], Date.now).pending()[0]!;
  expect(notice.source_id).toBe("stop");
  expect(Object.keys(notice)).not.toContain("reason");
  expect(Object.keys(notice)).not.toContain("chain");
});

async function chainNoticeFixture(state: "awaiting_review" | "ready_for_human") {
  const { publishedRecheck } = await import("@osstack/core/dist/state/local-failure-recheck.testkit.js");
  const h = publishedRecheck();
  h.recordConfirmation(); h.confirm();
  const { db, principal } = h.f, chainId = h.chain().chain_id;
  db.prepare("UPDATE engineering_revision_chains SET state=?,revision=revision+1 WHERE chain_id=?").run(state, chainId);
  const queries = new DecisionQueries(db);
  const source = createDecisionNoticeSource(queries, () => principal.read_scopes, () => h.now);
  const notices = () => source.pending().filter(item => item.source === "revision_chain");
  return { h, principal, chainId, queries, source, notices };
}

it("lists a live awaiting_review chain with a waiting recheck without sending a notice", async () => {
  const { listDecisions } = await import("./list.js");
  const { h, principal, chainId, queries, source, notices } = await chainNoticeFixture("awaiting_review");
  try {
    h.open();
    const list = await listDecisions(queries, {}, () => principal);
    expect(list.items).toContainEqual(expect.objectContaining({ source: "revision_chain", source_id: chainId }));
    expect(notices()).toEqual([]);
    expect(source.incompleteSources).toEqual([]);
  } finally { h.f.db.close(); }
});

it("preserves the ready_for_human notice when its chain gains a waiting recheck", async () => {
  const { h, chainId, notices } = await chainNoticeFixture("ready_for_human");
  try {
    const before = notices();
    expect(before).toMatchObject([{ source_id: chainId }]);
    h.open();
    expect(notices()).toEqual(before);
  } finally { h.f.db.close(); }
});

it("pages past recheck-only chains and counts only notices toward truncation", () => {
  const queries = new DecisionQueries({ prepare: () => ({ all: () => [] }) } as unknown as Database.Database);
  const rows = Array.from({ length: 750 }, (_, i) => ({
    ...row(String(i).padStart(3, "0")), kind: "live",
    state: i < 150 || i >= 650 ? "awaiting_review" : "ready_for_human",
    details_json: '{"recheck":{"mission_id":"root","attempt":1}}',
  }));
  vi.spyOn(queries, "revision_chain").mockImplementation(q => rows.filter(r => r.id > q.after).slice(0, q.limit));
  const now = vi.fn(() => 10);
  const source = createDecisionNoticeSource(queries, () => ["scope"], now);
  expect(source.pending().map(item => item.source_id)).toEqual(rows.slice(150, 650).map(r => r.id));
  expect(now).toHaveBeenCalledTimes(500);
  expect(source.truncated).toBe(false);
  expect(source.incompleteSources).toEqual([]);
});
