// Migration 48: one row per open-decision reminder episode, holding its
// schedule and the current attempt in the same columns as attention_deliveries.
export const ATTENTION_REMINDERS_DDL = `
  CREATE TABLE attention_reminders (
    delivery_id TEXT NOT NULL UNIQUE, scope_id TEXT NOT NULL, item_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0), opened_at INTEGER NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence>0), last_at INTEGER NOT NULL,
    delay_ms INTEGER NOT NULL CHECK(delay_ms>0),
    state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL DEFAULT 0, error TEXT,
    PRIMARY KEY(scope_id,item_id,revision)
  );
  CREATE INDEX attention_reminders_due ON attention_reminders(state,next_at);
`;
