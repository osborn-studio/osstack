// Migration 48: one row per unresolved decision, holding its reminder schedule
// and the current attempt in the same columns as attention_deliveries. The
// item's revision may change while it stays unresolved (a new source version,
// a source that went missing and came back); `revision` records the revision
// the current reminder was scheduled for, and the schedule survives the change.
export const ATTENTION_REMINDERS_DDL = `
  CREATE TABLE attention_reminders (
    delivery_id TEXT NOT NULL UNIQUE, scope_id TEXT NOT NULL, item_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0), opened_at INTEGER NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence>0), last_at INTEGER NOT NULL,
    delay_ms INTEGER NOT NULL CHECK(delay_ms>0),
    state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL DEFAULT 0, error TEXT,
    PRIMARY KEY(scope_id,item_id)
  );
  CREATE INDEX attention_reminders_due ON attention_reminders(state,next_at);
`;
