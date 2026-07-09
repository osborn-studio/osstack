// Kanban Zod row schemas. Tables are created by core migration #4
// (packages/core/src/state/migrations.ts).
//
// Borrowed from Hermes Agent's kanban (hermes-webui/api/kanban_bridge.py),
// adapted to osstack conventions:
//   - REAL unix-seconds timestamps (matches the rest of osstack state)
//   - Zod validation on every read/write
//   - the board column model is a const tuple so it's greppable in one place

import { z } from "zod";

// ──────────────────────────────────────────────────────────────────────
// Board columns — the workflow lanes. Order is display order, left→right.
// `archived` is a terminal sink not shown by default (Hermes parity).
// ──────────────────────────────────────────────────────────────────────

export const BOARD_COLUMNS = ["triage", "todo", "ready", "running", "blocked", "done"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const CardStatus = z.enum(["triage", "todo", "ready", "running", "blocked", "done", "archived"]);
export type CardStatus = z.infer<typeof CardStatus>;

/**
 * Legal status transitions. We keep this permissive (a board is a human tool,
 * users drag cards around freely) but block the two moves Hermes also blocks:
 *   - nothing transitions OUT of `archived` except back to `triage` (un-archive)
 *   - everything else is allowed, including direct jumps.
 * The repository enforces it; standalone planning stays frictionless.
 */
export function isLegalCardTransition(from: CardStatus, to: CardStatus): boolean {
  if (from === to) return true;
  if (from === "archived") return to === "triage";
  return true;
}

// ──────────────────────────────────────────────────────────────────────
// Rows
// ──────────────────────────────────────────────────────────────────────

export const CardRow = z.object({
  card_id: z.string().min(1),
  board: z.string().min(1).default("default"),
  /** Optional link to an osstack task in the run pipeline. */
  task_id: z.string().nullable().default(null),
  title: z.string().min(1),
  body: z.string().default(""),
  status: CardStatus.default("triage"),
  /** Higher = more urgent. Sorts descending within a column. */
  priority: z.number().int().default(0),
  assignee: z.string().nullable().default(null),
  blocked_reason: z.string().nullable().default(null),
  tenant_id: z.string().nullable().default(null),
  /** What kind of work this card represents (migration #7). */
  card_type: z.enum(["pr", "implementation", "review", "merge"]).default("implementation"),
  /** Free-form JSON string, e.g. PR number/branch/links (migration #7). */
  meta: z.string().nullable().default(null),
  created_at: z.number(),
  updated_at: z.number(),
  started_at: z.number().nullable().default(null),
  completed_at: z.number().nullable().default(null),
});
export type CardRow = z.infer<typeof CardRow>;

export const CardCommentRow = z.object({
  comment_id: z.number().int(),
  card_id: z.string(),
  author: z.string(),
  body: z.string(),
  created_at: z.number(),
});
export type CardCommentRow = z.infer<typeof CardCommentRow>;

/** Per-card ordered verification checklist row (migration #7). */
export const CardCheckRow = z.object({
  card_id: z.string(),
  idx: z.number().int(),
  label: z.string(),
  state: z.enum(["pending", "pass", "fail"]).default("pending"),
  detail: z.string().nullable().default(null),
  updated_at: z.number(),
});
export type CardCheckRow = z.infer<typeof CardCheckRow>;

export const CardEventRow = z.object({
  event_id: z.number().int(),
  card_id: z.string(),
  board: z.string(),
  /** e.g. "created", "moved", "commented", "linked", "progress", "blocked", "completed" */
  kind: z.string(),
  /** JSON string (parsed lazily by readers). */
  payload: z.string().nullable().default(null),
  created_at: z.number(),
});
export type CardEventRow = z.infer<typeof CardEventRow>;

export const NotifySubRow = z.object({
  card_id: z.string(),
  /** "telegram" | "slack" | ... — free-form so future transports drop in. */
  platform: z.string(),
  chat_id: z.string(),
  thread_id: z.string().default(""),
  user_id: z.string().nullable().default(null),
  /** Cursor: highest card_event id already delivered to this subscription. */
  last_event_id: z.number().int().default(0),
  created_at: z.number(),
});
export type NotifySubRow = z.infer<typeof NotifySubRow>;
