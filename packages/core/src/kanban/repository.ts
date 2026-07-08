// KanbanRepository — CRUD over cards/comments/links + the per-card event log.
//
// Design principle borrowed from Hermes: EVERY state change appends a row to
// kanban_card_events. That event log is the single source the notifier drains
// to push progress to Telegram, and the basis for cheap incremental board
// polling (clients pass `since=<last event id>` and get changed:false if
// nothing moved). So the rule is: never mutate a card without emit()'ing.
//
// All writes go through withWrite() so the disk-full preflight (G1) applies.

import type Database from "better-sqlite3";
import { withWrite } from "../state/db.js";
import {
  CardCheckRow,
  CardCommentRow,
  CardEventRow,
  CardRow,
  NotifySubRow,
  isLegalCardTransition,
  type CardStatus,
} from "./schema.js";

export class IllegalCardTransition extends Error {
  constructor(readonly from: CardStatus, readonly to: CardStatus) {
    super(`Illegal kanban card transition: ${from} -> ${to}`);
    this.name = "IllegalCardTransition";
  }
}

export class CardNotFound extends Error {
  constructor(readonly cardId: string) {
    super(`Kanban card not found: ${cardId}`);
    this.name = "CardNotFound";
  }
}

export class CardCheckNotFound extends Error {
  constructor(readonly cardId: string, readonly idx: number) {
    super(`Kanban card check not found: ${cardId}#${idx}`);
    this.name = "CardCheckNotFound";
  }
}

export interface NewCard {
  card_id: string;
  board?: string;
  task_id?: string | null;
  title: string;
  body?: string;
  status?: CardStatus;
  priority?: number;
  assignee?: string | null;
  tenant_id?: string | null;
  card_type?: "pr" | "implementation" | "review" | "merge";
  meta?: string | null;
}

export class KanbanRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly dbPath: string,
    private readonly now: () => number = () => Date.now() / 1000,
  ) {}

  // ── internal event emit (must run inside an open write txn) ──────────

  private emit(card_id: string, board: string, kind: string, payload?: unknown): void {
    this.db.prepare(`
      INSERT INTO kanban_card_events (card_id, board, kind, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(card_id, board, kind, payload === undefined ? null : JSON.stringify(payload), this.now());
  }

  // ── cards ────────────────────────────────────────────────────────────

  createCard(input: NewCard): CardRow {
    const ts = this.now();
    const row = CardRow.parse({
      card_id: input.card_id,
      board: input.board ?? "default",
      task_id: input.task_id ?? null,
      title: input.title,
      body: input.body ?? "",
      status: input.status ?? "triage",
      priority: input.priority ?? 0,
      assignee: input.assignee ?? null,
      blocked_reason: null,
      tenant_id: input.tenant_id ?? null,
      card_type: input.card_type ?? "implementation",
      meta: input.meta ?? null,
      created_at: ts,
      updated_at: ts,
      started_at: input.status === "running" ? ts : null,
      completed_at: input.status === "done" ? ts : null,
    });
    withWrite(this.db, this.dbPath, (d) => {
      d.prepare(`
        INSERT INTO kanban_cards (
          card_id, board, task_id, title, body, status, priority, assignee,
          blocked_reason, tenant_id, card_type, meta, created_at, updated_at, started_at, completed_at
        ) VALUES (
          @card_id, @board, @task_id, @title, @body, @status, @priority, @assignee,
          @blocked_reason, @tenant_id, @card_type, @meta, @created_at, @updated_at, @started_at, @completed_at
        )
      `).run(row);
      this.emit(row.card_id, row.board, "created", { title: row.title, status: row.status });
    });
    return row;
  }

  getCard(card_id: string): CardRow | undefined {
    const r = this.db.prepare("SELECT * FROM kanban_cards WHERE card_id = ?").get(card_id);
    return r ? CardRow.parse(r) : undefined;
  }

  /** Look up a card by its linked osstack task_id (for auto-sync). */
  getCardByTask(task_id: string): CardRow | undefined {
    const r = this.db.prepare("SELECT * FROM kanban_cards WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(task_id);
    return r ? CardRow.parse(r) : undefined;
  }

  /**
   * Move a card to a new column. Sets started_at on first entry to `running`
   * and completed_at on entry to `done`. Emits a "moved" (or "blocked"/
   * "completed") event so subscribers learn about it.
   */
  moveCard(card_id: string, to: CardStatus, opts: { blocked_reason?: string; actor?: string } = {}): CardRow {
    const card = this.getCard(card_id);
    if (!card) throw new CardNotFound(card_id);
    if (!isLegalCardTransition(card.status, to)) throw new IllegalCardTransition(card.status, to);
    const ts = this.now();
    const started_at = to === "running" && card.started_at === null ? ts : card.started_at;
    const completed_at = to === "done" ? ts : card.completed_at;
    const blocked_reason = to === "blocked" ? (opts.blocked_reason ?? card.blocked_reason ?? "blocked") : null;
    withWrite(this.db, this.dbPath, (d) => {
      d.prepare(`
        UPDATE kanban_cards
        SET status = ?, updated_at = ?, started_at = ?, completed_at = ?, blocked_reason = ?
        WHERE card_id = ?
      `).run(to, ts, started_at, completed_at, blocked_reason, card_id);
      const kind = to === "blocked" ? "blocked" : to === "done" ? "completed" : "moved";
      this.emit(card_id, card.board, kind, { from: card.status, to, actor: opts.actor ?? "system", blocked_reason });
    });
    return this.getCard(card_id)!;
  }

  /** Patch title/body/priority/assignee. Emits "updated". */
  patchCard(card_id: string, patch: { title?: string; body?: string; priority?: number; assignee?: string | null }): CardRow {
    const card = this.getCard(card_id);
    if (!card) throw new CardNotFound(card_id);
    const ts = this.now();
    withWrite(this.db, this.dbPath, (d) => {
      d.prepare(`
        UPDATE kanban_cards
        SET title = COALESCE(?, title),
            body = COALESCE(?, body),
            priority = COALESCE(?, priority),
            assignee = CASE WHEN ? THEN ? ELSE assignee END,
            updated_at = ?
        WHERE card_id = ?
      `).run(
        patch.title ?? null,
        patch.body ?? null,
        patch.priority ?? null,
        patch.assignee !== undefined ? 1 : 0,
        patch.assignee ?? null,
        ts,
        card_id,
      );
      this.emit(card_id, card.board, "updated", patch);
    });
    return this.getCard(card_id)!;
  }

  /** Record a progress note without a status change. Emits "progress". */
  progress(card_id: string, note: string, actor = "system"): void {
    const card = this.getCard(card_id);
    if (!card) throw new CardNotFound(card_id);
    withWrite(this.db, this.dbPath, () => {
      this.emit(card_id, card.board, "progress", { note, actor });
    });
  }

  archive(card_id: string): CardRow {
    return this.moveCard(card_id, "archived");
  }

  listCards(opts: { board?: string; status?: CardStatus; assignee?: string; includeArchived?: boolean } = {}): CardRow[] {
    let sql = "SELECT * FROM kanban_cards WHERE board = ?";
    const params: unknown[] = [opts.board ?? "default"];
    if (opts.status) { sql += " AND status = ?"; params.push(opts.status); }
    else if (!opts.includeArchived) { sql += " AND status != 'archived'"; }
    if (opts.assignee) { sql += " AND assignee = ?"; params.push(opts.assignee); }
    sql += " ORDER BY priority DESC, created_at ASC";
    return (this.db.prepare(sql).all(...params) as unknown[]).map((r) => CardRow.parse(r));
  }

  // ── checklist (per-card ordered verification steps, migration #7) ──────

  /**
   * Insert or update a checklist row at (card_id, idx). Upserts so re-running
   * a checklist definition is idempotent. Emits "check". Throws CardNotFound
   * if the card doesn't exist.
   */
  putCheck(
    card_id: string,
    idx: number,
    label: string,
    opts: { state?: "pending" | "pass" | "fail"; detail?: string | null } = {},
  ): CardCheckRow {
    const card = this.getCard(card_id);
    if (!card) throw new CardNotFound(card_id);
    const state = opts.state ?? "pending";
    const detail = opts.detail ?? null;
    const ts = this.now();
    withWrite(this.db, this.dbPath, (d) => {
      d.prepare(`
        INSERT INTO kanban_card_checks (card_id, idx, label, state, detail, updated_at)
        VALUES (@card_id, @idx, @label, @state, @detail, @updated_at)
        ON CONFLICT(card_id, idx) DO UPDATE SET
          label = excluded.label,
          state = excluded.state,
          detail = excluded.detail,
          updated_at = excluded.updated_at
      `).run({ card_id, idx, label, state, detail, updated_at: ts });
      this.emit(card_id, card.board, "check", { idx, label, state });
    });
    return CardCheckRow.parse({ card_id, idx, label, state, detail, updated_at: ts });
  }

  /**
   * Transition an existing check's state (e.g. pending -> pass). Emits
   * "check" with from/to. Throws CardCheckNotFound if the row doesn't exist.
   */
  setCheckState(
    card_id: string,
    idx: number,
    state: "pending" | "pass" | "fail",
    detail?: string | null,
  ): CardCheckRow {
    const existing = this.db.prepare(
      "SELECT * FROM kanban_card_checks WHERE card_id = ? AND idx = ?",
    ).get(card_id, idx);
    if (!existing) throw new CardCheckNotFound(card_id, idx);
    const before = CardCheckRow.parse(existing);
    const card = this.getCard(card_id);
    const ts = this.now();
    const nextDetail = detail !== undefined ? detail : before.detail;
    withWrite(this.db, this.dbPath, (d) => {
      d.prepare(`
        UPDATE kanban_card_checks
        SET state = ?, detail = ?, updated_at = ?
        WHERE card_id = ? AND idx = ?
      `).run(state, nextDetail, ts, card_id, idx);
      if (card) {
        this.emit(card_id, card.board, "check", { idx, from: before.state, to: state });
      }
    });
    return CardCheckRow.parse({ ...before, state, detail: nextDetail, updated_at: ts });
  }

  listChecks(card_id: string): CardCheckRow[] {
    return (this.db.prepare(
      "SELECT * FROM kanban_card_checks WHERE card_id = ? ORDER BY idx",
    ).all(card_id) as unknown[]).map((r) => CardCheckRow.parse(r));
  }

  // ── comments ──────────────────────────────────────────────────────────

  addComment(card_id: string, author: string, body: string): CardCommentRow {
    const card = this.getCard(card_id);
    if (!card) throw new CardNotFound(card_id);
    const ts = this.now();
    let comment_id = 0;
    withWrite(this.db, this.dbPath, (d) => {
      const r = d.prepare(`
        INSERT INTO kanban_card_comments (card_id, author, body, created_at)
        VALUES (?, ?, ?, ?)
      `).run(card_id, author, body, ts);
      comment_id = Number(r.lastInsertRowid);
      this.emit(card_id, card.board, "commented", { author, body });
    });
    return CardCommentRow.parse({ comment_id, card_id, author, body, created_at: ts });
  }

  listComments(card_id: string): CardCommentRow[] {
    return (this.db.prepare("SELECT * FROM kanban_card_comments WHERE card_id = ? ORDER BY created_at ASC").all(card_id) as unknown[])
      .map((r) => CardCommentRow.parse(r));
  }

  // ── links (dependency DAG) ──────────────────────────────────────────

  link(parent_id: string, child_id: string): void {
    if (parent_id === child_id) throw new Error("a card cannot link to itself");
    const parent = this.getCard(parent_id);
    const child = this.getCard(child_id);
    if (!parent) throw new CardNotFound(parent_id);
    if (!child) throw new CardNotFound(child_id);
    withWrite(this.db, this.dbPath, (d) => {
      d.prepare("INSERT OR IGNORE INTO kanban_card_links (parent_id, child_id) VALUES (?, ?)").run(parent_id, child_id);
      this.emit(parent_id, parent.board, "linked", { parent_id, child_id });
    });
  }

  unlink(parent_id: string, child_id: string): void {
    withWrite(this.db, this.dbPath, (d) => {
      d.prepare("DELETE FROM kanban_card_links WHERE parent_id = ? AND child_id = ?").run(parent_id, child_id);
    });
  }

  linkCounts(card_id: string): { parents: number; children: number } {
    const parents = (this.db.prepare("SELECT COUNT(*) AS n FROM kanban_card_links WHERE child_id = ?").get(card_id) as { n: number }).n;
    const children = (this.db.prepare("SELECT COUNT(*) AS n FROM kanban_card_links WHERE parent_id = ?").get(card_id) as { n: number }).n;
    return { parents, children };
  }

  // ── events ────────────────────────────────────────────────────────────

  latestEventId(board = "default"): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(event_id), 0) AS m FROM kanban_card_events WHERE board = ?").get(board) as { m: number };
    return Number(r.m || 0);
  }

  /** Events after `sinceId`, optionally scoped to one card. Ordered ascending. */
  eventsSince(sinceId: number, opts: { board?: string; card_id?: string; limit?: number } = {}): CardEventRow[] {
    let sql = "SELECT * FROM kanban_card_events WHERE event_id > ?";
    const params: unknown[] = [sinceId];
    if (opts.card_id) { sql += " AND card_id = ?"; params.push(opts.card_id); }
    else if (opts.board) { sql += " AND board = ?"; params.push(opts.board); }
    sql += " ORDER BY event_id ASC";
    if (opts.limit) { sql += " LIMIT ?"; params.push(opts.limit); }
    return (this.db.prepare(sql).all(...params) as unknown[]).map((r) => CardEventRow.parse(r));
  }

  // ── notify subscriptions (the Telegram hook) ────────────────────────

  subscribe(input: { card_id: string; platform: string; chat_id: string; thread_id?: string; user_id?: string | null }): NotifySubRow {
    const card = this.getCard(input.card_id);
    if (!card) throw new CardNotFound(input.card_id);
    const ts = this.now();
    const thread_id = input.thread_id ?? "";
    // Start the cursor at the current latest so a fresh subscriber only gets
    // FUTURE progress, not the entire history.
    const last_event_id = this.latestEventId(card.board);
    withWrite(this.db, this.dbPath, (d) => {
      d.prepare(`
        INSERT INTO kanban_notify_subs (card_id, platform, chat_id, thread_id, user_id, last_event_id, created_at)
        VALUES (@card_id, @platform, @chat_id, @thread_id, @user_id, @last_event_id, @created_at)
        ON CONFLICT(card_id, platform, chat_id, thread_id) DO UPDATE SET user_id = excluded.user_id
      `).run({
        card_id: input.card_id,
        platform: input.platform,
        chat_id: input.chat_id,
        thread_id,
        user_id: input.user_id ?? null,
        last_event_id,
        created_at: ts,
      });
    });
    return NotifySubRow.parse({
      card_id: input.card_id, platform: input.platform, chat_id: input.chat_id,
      thread_id, user_id: input.user_id ?? null, last_event_id, created_at: ts,
    });
  }

  unsubscribe(card_id: string, platform: string, chat_id: string, thread_id = ""): boolean {
    const r = this.db.prepare(
      "DELETE FROM kanban_notify_subs WHERE card_id = ? AND platform = ? AND chat_id = ? AND thread_id = ?",
    ).run(card_id, platform, chat_id, thread_id);
    return r.changes > 0;
  }

  listSubscriptions(opts: { card_id?: string } = {}): NotifySubRow[] {
    const sql = opts.card_id
      ? "SELECT * FROM kanban_notify_subs WHERE card_id = ?"
      : "SELECT * FROM kanban_notify_subs";
    const params = opts.card_id ? [opts.card_id] : [];
    return (this.db.prepare(sql).all(...params) as unknown[]).map((r) => NotifySubRow.parse(r));
  }

  /** Advance a subscription's delivered cursor (called by the notifier). */
  advanceCursor(card_id: string, platform: string, chat_id: string, thread_id: string, lastEventId: number): void {
    withWrite(this.db, this.dbPath, (d) => {
      d.prepare(`
        UPDATE kanban_notify_subs SET last_event_id = ?
        WHERE card_id = ? AND platform = ? AND chat_id = ? AND thread_id = ?
      `).run(lastEventId, card_id, platform, chat_id, thread_id);
    });
  }
}
