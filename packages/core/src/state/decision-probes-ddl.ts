export const DECISION_PROBES_DDL = `
  CREATE TABLE decision_probes (
    probe_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK(state IN ('pending','answered','continued')),
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    answer TEXT,
    answer_id TEXT,
    answer_digest TEXT,
    answered_by TEXT,
    answered_at INTEGER,
    continued_at INTEGER
  ) WITHOUT ROWID;
  CREATE UNIQUE INDEX decision_probes_answer_id ON decision_probes(answer_id) WHERE answer_id IS NOT NULL;
  CREATE INDEX decision_probes_pending_expiry ON decision_probes(expires_at) WHERE state='pending';
`;
