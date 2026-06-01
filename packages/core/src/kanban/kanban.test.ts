import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../state/db.js";
import { KanbanRepository, IllegalCardTransition, CardNotFound } from "./repository.js";
import { getBoard, computeStats, renderBoardSummary, type BoardView } from "./board.js";
import { KanbanNotifier, type OutboundMessage } from "./notify.js";
import { BOARD_COLUMNS, isLegalCardTransition } from "./schema.js";

let tmp: string;
let dbPath: string;
let db: ReturnType<typeof openDb>;
let repo: KanbanRepository;
let clock: number;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-kanban-"));
  dbPath = join(tmp, "state.db");
  db = openDb({ path: dbPath });
  clock = 1000;
  repo = new KanbanRepository(db, dbPath, () => clock);
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

function tick(s = 1): void { clock += s; }

describe("migration #4 — kanban tables exist", () => {
  it("creates all five kanban tables", () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ["kanban_cards", "kanban_card_links", "kanban_card_comments", "kanban_card_events", "kanban_notify_subs"]) {
      expect(names).toContain(t);
    }
    expect(Number(db.pragma("user_version", { simple: true }))).toBeGreaterThanOrEqual(4);
  });
});

describe("schema — board columns + transitions", () => {
  it("declares the six Hermes-parity columns in order", () => {
    expect(BOARD_COLUMNS).toEqual(["triage", "todo", "ready", "running", "blocked", "done"]);
  });
  it("allows any non-archived move, blocks archived→non-triage", () => {
    expect(isLegalCardTransition("triage", "done")).toBe(true);
    expect(isLegalCardTransition("running", "blocked")).toBe(true);
    expect(isLegalCardTransition("archived", "triage")).toBe(true);
    expect(isLegalCardTransition("archived", "running")).toBe(false);
  });
});

describe("KanbanRepository — cards", () => {
  it("creates a card in triage and emits a created event", () => {
    const c = repo.createCard({ card_id: "c1", title: "Write API" });
    expect(c.status).toBe("triage");
    expect(c.priority).toBe(0);
    const events = repo.eventsSince(0);
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe("created");
  });

  it("moves a card and stamps started_at / completed_at", () => {
    repo.createCard({ card_id: "c1", title: "x" });
    tick();
    const running = repo.moveCard("c1", "running");
    expect(running.status).toBe("running");
    expect(running.started_at).toBe(clock);
    tick();
    const done = repo.moveCard("c1", "done");
    expect(done.completed_at).toBe(clock);
    // moved + completed events emitted
    const kinds = repo.eventsSince(0).map((e) => e.kind);
    expect(kinds).toContain("moved");
    expect(kinds).toContain("completed");
  });

  it("blocking a card records the reason and emits a blocked event", () => {
    repo.createCard({ card_id: "c1", title: "x", status: "running" });
    const blocked = repo.moveCard("c1", "blocked", { blocked_reason: "waiting on review" });
    expect(blocked.blocked_reason).toBe("waiting on review");
    const evt = repo.eventsSince(0).find((e) => e.kind === "blocked")!;
    expect(JSON.parse(evt.payload!).blocked_reason).toBe("waiting on review");
  });

  it("rejects illegal archived→running transition", () => {
    repo.createCard({ card_id: "c1", title: "x" });
    repo.archive("c1");
    expect(() => repo.moveCard("c1", "running")).toThrow(IllegalCardTransition);
  });

  it("throws CardNotFound for unknown card", () => {
    expect(() => repo.moveCard("nope", "done")).toThrow(CardNotFound);
  });

  it("patchCard updates fields + clears assignee when null passed", () => {
    repo.createCard({ card_id: "c1", title: "x", assignee: "claude-code" });
    const p = repo.patchCard("c1", { title: "y", priority: 5, assignee: null });
    expect(p.title).toBe("y");
    expect(p.priority).toBe(5);
    expect(p.assignee).toBeNull();
  });

  it("listCards orders by priority desc then created_at, hides archived by default", () => {
    repo.createCard({ card_id: "lo", title: "lo", priority: 1 });
    tick();
    repo.createCard({ card_id: "hi", title: "hi", priority: 9 });
    tick();
    repo.createCard({ card_id: "arch", title: "arch" });
    repo.archive("arch");
    const ids = repo.listCards().map((c) => c.card_id);
    expect(ids).toEqual(["hi", "lo"]);
    expect(repo.listCards({ includeArchived: true }).map((c) => c.card_id)).toContain("arch");
  });

  it("getCardByTask links a card to an osstack task", () => {
    repo.createCard({ card_id: "c1", title: "x", task_id: "task_42" });
    expect(repo.getCardByTask("task_42")?.card_id).toBe("c1");
    expect(repo.getCardByTask("missing")).toBeUndefined();
  });
});

describe("KanbanRepository — comments + links", () => {
  it("adds comments and counts them", () => {
    repo.createCard({ card_id: "c1", title: "x" });
    repo.addComment("c1", "osborn", "looks good");
    repo.addComment("c1", "claude", "shipping");
    expect(repo.listComments("c1").length).toBe(2);
    expect(repo.eventsSince(0).filter((e) => e.kind === "commented").length).toBe(2);
  });

  it("links parent→child and counts both directions", () => {
    repo.createCard({ card_id: "epic", title: "epic" });
    repo.createCard({ card_id: "sub", title: "sub" });
    repo.link("epic", "sub");
    expect(repo.linkCounts("epic")).toEqual({ parents: 0, children: 1 });
    expect(repo.linkCounts("sub")).toEqual({ parents: 1, children: 0 });
    repo.unlink("epic", "sub");
    expect(repo.linkCounts("epic")).toEqual({ parents: 0, children: 0 });
  });

  it("refuses self-link", () => {
    repo.createCard({ card_id: "c1", title: "x" });
    expect(() => repo.link("c1", "c1")).toThrow();
  });
});

describe("getBoard — derivation + incremental polling", () => {
  it("groups cards into columns with enrichment", () => {
    repo.createCard({ card_id: "a", title: "a", status: "todo" });
    repo.createCard({ card_id: "b", title: "b", status: "running" });
    repo.addComment("a", "x", "note");
    const view = getBoard(repo, { now: () => clock }) as BoardView;
    expect(view.changed).toBe(true);
    const todo = view.columns.find((c) => c.name === "todo")!;
    expect(todo.cards[0]!.comment_count).toBe(1);
    expect(view.columns.find((c) => c.name === "running")!.cards.length).toBe(1);
  });

  it("short-circuits with changed:false when no events since cursor", () => {
    repo.createCard({ card_id: "a", title: "a" });
    const latest = repo.latestEventId();
    const view = getBoard(repo, { since: latest });
    expect(view.changed).toBe(false);
    expect(view.latest_event_id).toBe(latest);
  });

  it("returns changed:true when a new event arrives after the cursor", () => {
    repo.createCard({ card_id: "a", title: "a" });
    const cursor = repo.latestEventId();
    repo.moveCard("a", "todo");
    const view = getBoard(repo, { since: cursor });
    expect(view.changed).toBe(true);
  });

  it("computeStats tallies by_status and by_assignee", () => {
    repo.createCard({ card_id: "a", title: "a", status: "todo", assignee: "claude-code" });
    repo.createCard({ card_id: "b", title: "b", status: "todo" });
    const stats = computeStats(repo.listCards());
    expect(stats.total).toBe(2);
    expect(stats.by_status.todo).toBe(2);
    expect(stats.by_assignee["claude-code"]).toBe(1);
    expect(stats.by_assignee.unassigned).toBe(1);
  });

  it("renderBoardSummary produces a compact one-liner", () => {
    repo.createCard({ card_id: "a", title: "a", status: "todo" });
    repo.createCard({ card_id: "b", title: "b", status: "done" });
    const view = getBoard(repo, { now: () => clock }) as BoardView;
    const s = renderBoardSummary(view);
    expect(s).toContain("todo:1");
    expect(s).toContain("done:1");
    expect(s).toContain("2 cards");
  });
});

describe("notify subscriptions + KanbanNotifier (Telegram hook)", () => {
  it("a fresh subscription only sees FUTURE events", async () => {
    repo.createCard({ card_id: "c1", title: "x" }); // event 1 (created) — before sub
    repo.subscribe({ card_id: "c1", platform: "telegram", chat_id: "123" });
    // No new events yet → nothing to deliver
    const sent: OutboundMessage[] = [];
    const notifier = new KanbanNotifier(repo, async (m) => { sent.push(m); });
    expect(await notifier.drain()).toBe(0);
    // Now move the card → one new event
    repo.moveCard("c1", "running");
    expect(await notifier.drain()).toBe(1);
    expect(sent[0]!.chat_id).toBe("123");
    expect(sent[0]!.text).toContain("moved");
  });

  it("advances the cursor so events are delivered exactly once", async () => {
    repo.createCard({ card_id: "c1", title: "x" });
    repo.subscribe({ card_id: "c1", platform: "telegram", chat_id: "123" });
    repo.moveCard("c1", "todo");
    const sent: OutboundMessage[] = [];
    const notifier = new KanbanNotifier(repo, async (m) => { sent.push(m); });
    await notifier.drain();
    await notifier.drain(); // second pass: nothing new
    expect(sent.length).toBe(1);
  });

  it("does not advance cursor when transport throws (retries next tick)", async () => {
    repo.createCard({ card_id: "c1", title: "x" });
    repo.subscribe({ card_id: "c1", platform: "telegram", chat_id: "123" });
    repo.moveCard("c1", "todo");
    let attempts = 0;
    const notifier = new KanbanNotifier(repo, async () => {
      attempts++;
      if (attempts === 1) throw new Error("network down");
    });
    expect(await notifier.drain()).toBe(0); // first fails
    expect(await notifier.drain()).toBe(1); // retry succeeds
  });

  it("drainCard only touches one card's subscriptions", async () => {
    repo.createCard({ card_id: "c1", title: "x" });
    repo.createCard({ card_id: "c2", title: "y" });
    repo.subscribe({ card_id: "c1", platform: "telegram", chat_id: "1" });
    repo.subscribe({ card_id: "c2", platform: "telegram", chat_id: "2" });
    repo.moveCard("c1", "todo");
    repo.moveCard("c2", "todo");
    const sent: OutboundMessage[] = [];
    const notifier = new KanbanNotifier(repo, async (m) => { sent.push(m); });
    await notifier.drainCard("c1");
    expect(sent.length).toBe(1);
    expect(sent[0]!.card_id).toBe("c1");
  });

  it("unsubscribe removes the subscription", () => {
    repo.createCard({ card_id: "c1", title: "x" });
    repo.subscribe({ card_id: "c1", platform: "telegram", chat_id: "123" });
    expect(repo.listSubscriptions({ card_id: "c1" }).length).toBe(1);
    expect(repo.unsubscribe("c1", "telegram", "123")).toBe(true);
    expect(repo.listSubscriptions({ card_id: "c1" }).length).toBe(0);
  });

  it("progress note emits an event subscribers receive", async () => {
    repo.createCard({ card_id: "c1", title: "x" });
    repo.subscribe({ card_id: "c1", platform: "telegram", chat_id: "123" });
    repo.progress("c1", "halfway done", "claude-code");
    const sent: OutboundMessage[] = [];
    const notifier = new KanbanNotifier(repo, async (m) => { sent.push(m); });
    await notifier.drain();
    expect(sent[0]!.text).toContain("halfway done");
  });
});
