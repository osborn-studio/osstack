// KanbanNotifier — drains new card events to subscribers (the Telegram hook).
//
// This is the piece that makes "通过 Telegram Bot 调用 osstack 看板" work:
// Hermes (or any host) registers a subscription against a card with a
// platform/chat_id; the notifier periodically (or on demand) reads events
// past each subscription's cursor, formats them, hands them to an injected
// transport, and advances the cursor on successful delivery.
//
// Transport-agnostic by design: osstack-core never imports a Telegram SDK.
// The Hermes skill (or the daemon) supplies a `send` function. This keeps
// core dependency-free and lets the same notifier feed Slack, a webhook,
// stdout (tests), etc.

import type { KanbanRepository } from "./repository.js";
import type { CardEventRow, NotifySubRow } from "./schema.js";

/** A single formatted message ready to deliver to one subscription. */
export interface OutboundMessage {
  platform: string;
  chat_id: string;
  thread_id: string;
  card_id: string;
  text: string;
  /** The event ids this message covers (cursor advances to max). */
  event_ids: number[];
}

/** Injected transport. Resolve = delivered (cursor advances). Reject = retry next tick. */
export type NotifyTransport = (msg: OutboundMessage) => Promise<void>;

export interface NotifierOptions {
  /** Map a batch of events for one card into display text. Overridable. */
  formatEvents?: (card_id: string, events: readonly CardEventRow[]) => string;
  /** Max events to deliver per subscription per tick (avoids flooding). */
  batchLimit?: number;
}

function defaultFormat(card_id: string, events: readonly CardEventRow[]): string {
  const lines = events.map((e) => {
    let detail = "";
    if (e.payload) {
      try {
        const p = JSON.parse(e.payload) as Record<string, unknown>;
        if (e.kind === "moved") detail = ` ${p.from} → ${p.to}`;
        else if (e.kind === "blocked") detail = ` (${p.blocked_reason ?? "blocked"})`;
        else if (e.kind === "progress") detail = `: ${p.note ?? ""}`;
        else if (e.kind === "commented") detail = `: ${p.author ?? ""}: ${String(p.body ?? "").slice(0, 120)}`;
        else if (e.kind === "completed") detail = " ✅";
        else if (e.kind === "created") detail = `: ${p.title ?? ""}`;
      } catch { /* ignore malformed payload */ }
    }
    return `• ${e.kind}${detail}`;
  });
  return `📋 ${card_id}\n${lines.join("\n")}`;
}

export class KanbanNotifier {
  private readonly format: (card_id: string, events: readonly CardEventRow[]) => string;
  private readonly batchLimit: number;

  constructor(
    private readonly repo: KanbanRepository,
    private readonly transport: NotifyTransport,
    opts: NotifierOptions = {},
  ) {
    this.format = opts.formatEvents ?? defaultFormat;
    this.batchLimit = opts.batchLimit ?? 20;
  }

  /**
   * One drain pass over all subscriptions. For each sub with new events,
   * format + deliver via transport, then advance the cursor. Failed
   * deliveries leave the cursor unmoved so they retry next tick.
   * Returns the number of subscriptions that received a message.
   */
  async drain(): Promise<number> {
    const subs = this.repo.listSubscriptions();
    let delivered = 0;
    for (const sub of subs) {
      const sent = await this.drainSubscription(sub);
      if (sent) delivered++;
    }
    return delivered;
  }

  /** Drain a single card's subscriptions (used right after a mutation). */
  async drainCard(card_id: string): Promise<number> {
    const subs = this.repo.listSubscriptions({ card_id });
    let delivered = 0;
    for (const sub of subs) {
      const sent = await this.drainSubscription(sub);
      if (sent) delivered++;
    }
    return delivered;
  }

  private async drainSubscription(sub: NotifySubRow): Promise<boolean> {
    const events = this.repo.eventsSince(sub.last_event_id, {
      card_id: sub.card_id,
      limit: this.batchLimit,
    });
    if (events.length === 0) return false;
    const maxId = Math.max(...events.map((e) => e.event_id));
    const msg: OutboundMessage = {
      platform: sub.platform,
      chat_id: sub.chat_id,
      thread_id: sub.thread_id,
      card_id: sub.card_id,
      text: this.format(sub.card_id, events),
      event_ids: events.map((e) => e.event_id),
    };
    try {
      await this.transport(msg);
    } catch {
      return false; // leave cursor; retry next tick
    }
    this.repo.advanceCursor(sub.card_id, sub.platform, sub.chat_id, sub.thread_id, maxId);
    return true;
  }
}
