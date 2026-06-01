// Board derivation + stats. Read-only view over the cards in a board.
//
// Incremental polling (Hermes parity): callers pass `since` = the
// latest_event_id they last saw. If nothing has happened since, getBoard()
// returns { changed: false, latest_event_id } and skips the full payload —
// so a Telegram poll loop or dashboard refresh costs one COUNT query when idle.

import type { KanbanRepository } from "./repository.js";
import { BOARD_COLUMNS, type CardRow, type CardStatus } from "./schema.js";

export interface BoardCardView extends CardRow {
  link_counts: { parents: number; children: number };
  comment_count: number;
  age_seconds: number;
}

export interface BoardColumnView {
  name: CardStatus;
  cards: BoardCardView[];
}

export interface BoardView {
  changed: true;
  board: string;
  columns: BoardColumnView[];
  assignees: string[];
  latest_event_id: number;
  stats: BoardStats;
}

export interface BoardUnchanged {
  changed: false;
  board: string;
  latest_event_id: number;
}

export interface BoardStats {
  total: number;
  by_status: Record<string, number>;
  by_assignee: Record<string, number>;
}

export interface GetBoardOptions {
  board?: string;
  assignee?: string;
  includeArchived?: boolean;
  /** If provided and no events since, returns BoardUnchanged. */
  since?: number;
  now?: () => number;
}

export function getBoard(repo: KanbanRepository, opts: GetBoardOptions = {}): BoardView | BoardUnchanged {
  const board = opts.board ?? "default";
  const latest = repo.latestEventId(board);
  if (opts.since !== undefined && opts.since >= latest) {
    return { changed: false, board, latest_event_id: latest };
  }

  const now = opts.now ? opts.now() : Date.now() / 1000;
  const cards = repo.listCards({
    board,
    ...(opts.assignee !== undefined ? { assignee: opts.assignee } : {}),
    ...(opts.includeArchived !== undefined ? { includeArchived: opts.includeArchived } : {}),
  });

  const enrich = (c: CardRow): BoardCardView => ({
    ...c,
    link_counts: repo.linkCounts(c.card_id),
    comment_count: repo.listComments(c.card_id).length,
    age_seconds: Math.max(0, Math.round(now - c.created_at)),
  });

  const columnNames: CardStatus[] = [...BOARD_COLUMNS];
  if (opts.includeArchived) columnNames.push("archived");

  const columns: BoardColumnView[] = columnNames.map((name) => ({
    name,
    cards: cards.filter((c) => c.status === name).map(enrich),
  }));

  return {
    changed: true,
    board,
    columns,
    assignees: [...new Set(cards.map((c) => c.assignee).filter((a): a is string => !!a))].sort(),
    latest_event_id: latest,
    stats: computeStats(cards),
  };
}

export function computeStats(cards: readonly CardRow[]): BoardStats {
  const by_status: Record<string, number> = {};
  const by_assignee: Record<string, number> = {};
  for (const c of cards) {
    by_status[c.status] = (by_status[c.status] ?? 0) + 1;
    const a = c.assignee ?? "unassigned";
    by_assignee[a] = (by_assignee[a] ?? 0) + 1;
  }
  return { total: cards.length, by_status, by_assignee };
}

/** Compact one-line board summary, handy for Telegram replies. */
export function renderBoardSummary(view: BoardView): string {
  const parts = view.columns
    .filter((col) => col.cards.length > 0)
    .map((col) => `${col.name}:${col.cards.length}`);
  return `[${view.board}] ${parts.join(" · ") || "empty"} (${view.stats.total} cards)`;
}
