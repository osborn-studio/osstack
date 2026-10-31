// Migration 49: facts the return brief needs, recorded when they happen.
// - attention_postures.entered_at: when the current posture was entered, so
//   leaving `away` knows the away interval. Pre-49 rows keep NULL (unknown).
// - attention_item_settlements: when a decision last left the waiting set
//   (open, answer_uncertain, source_missing). Written by trigger from the
//   transition's own updated_at, so every settling path is covered.
// - attention_dead_letters: one row per first notice or reminder attempt
//   that dead-lettered, with the time it did. Reminder rows are reused per
//   sequence, so the outbox alone would lose earlier dead letters.
// None of these grant authority; they only feed a read-only brief.
export const ATTENTION_RETURN_DDL = `
  ALTER TABLE attention_postures ADD COLUMN entered_at INTEGER;
  CREATE TABLE attention_item_settlements (
    scope_id TEXT NOT NULL, item_id TEXT NOT NULL, revision INTEGER NOT NULL,
    state TEXT NOT NULL, settled_at INTEGER NOT NULL,
    PRIMARY KEY(scope_id,item_id)
  );
  CREATE INDEX attention_item_settlements_at ON attention_item_settlements(scope_id,settled_at,item_id);
  CREATE TRIGGER attention_items_settled AFTER UPDATE OF state ON attention_items
  WHEN old.state IN ('open','answer_uncertain','source_missing')
    AND new.state NOT IN ('open','answer_uncertain','source_missing')
  BEGIN
    INSERT OR REPLACE INTO attention_item_settlements(scope_id,item_id,revision,state,settled_at)
    VALUES(new.scope_id,new.item_id,new.revision,new.state,new.updated_at);
  END;
  CREATE TABLE attention_dead_letters (
    delivery_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('first_notice','reminder')),
    scope_id TEXT NOT NULL, item_id TEXT NOT NULL, revision INTEGER NOT NULL,
    sequence INTEGER, error TEXT, dead_at INTEGER NOT NULL
  );
  CREATE INDEX attention_dead_letters_at ON attention_dead_letters(scope_id,dead_at,delivery_id);
`;
