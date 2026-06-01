// SQLite migrations. Each migration is idempotent (CREATE ... IF NOT EXISTS)
// or guarded by user_version pragma so it runs exactly once.
//
// Engine pragmas (WAL etc.) are applied at connection open in db.ts, NOT here.

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "initial_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS tasks (
        task_id            TEXT PRIMARY KEY,
        title              TEXT NOT NULL,
        description        TEXT NOT NULL DEFAULT '',
        hermes_session_id  TEXT,
        status             TEXT NOT NULL CHECK (status IN ('pending','running','done','failed','cancelled')),
        created_at         REAL NOT NULL,
        updated_at         REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        run_id                    TEXT PRIMARY KEY,
        task_id                   TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        session_id                TEXT NOT NULL,
        agent_id                  TEXT NOT NULL,
        capability_id             TEXT NOT NULL,
        phase                     TEXT NOT NULL,
        outcome                   TEXT,
        started_at                REAL NOT NULL,
        completed_at              REAL,
        duration_ms               REAL,
        tokens_in                 INTEGER NOT NULL DEFAULT 0,
        tokens_out                INTEGER NOT NULL DEFAULT 0,
        retry_count               INTEGER NOT NULL DEFAULT 0,
        human_intervention_count  INTEGER NOT NULL DEFAULT 0,
        pii_redacted_count        INTEGER NOT NULL DEFAULT 0,
        gbrain_page_id            TEXT,
        hermes_session_id         TEXT,
        last_step                 TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_task     ON runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_runs_agent    ON runs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_runs_phase    ON runs(phase);
      CREATE INDEX IF NOT EXISTS idx_runs_outcome  ON runs(outcome);

      CREATE TABLE IF NOT EXISTS events (
        event_id      TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        session_id    TEXT NOT NULL,
        seq           INTEGER NOT NULL,
        type          TEXT NOT NULL,
        created_at    REAL NOT NULL,
        terminal      INTEGER NOT NULL DEFAULT 0,
        payload_json  TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_events_run_seq ON events(run_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_run            ON events(run_id);
      CREATE INDEX IF NOT EXISTS idx_events_type           ON events(type);

      CREATE TABLE IF NOT EXISTS agents (
        agent_id      TEXT PRIMARY KEY,
        display_name  TEXT NOT NULL,
        cost_tier     TEXT NOT NULL CHECK (cost_tier IN ('low','mid','high')),
        last_seen_at  REAL,
        available     INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS approvals (
        approval_id     TEXT PRIMARY KEY,
        run_id          TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        status          TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','timed_out')),
        action_summary  TEXT NOT NULL,
        risk            TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
        requested_at    REAL NOT NULL,
        resolved_at     REAL,
        choice          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals(run_id);

      CREATE TABLE IF NOT EXISTS clarifies (
        clarify_id    TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        status        TEXT NOT NULL CHECK (status IN ('pending','answered','timed_out','abandoned')),
        question      TEXT NOT NULL,
        requested_at  REAL NOT NULL,
        resolved_at   REAL,
        answer        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_clarifies_run ON clarifies(run_id);
    `,
  },
  {
    id: 2,
    name: "memory_facts",
    // PartnerOS feedback loop: every user correction / preference / constraint
    // becomes a durable fact that future agent runs can read. See
    // packages/core/src/state/schema.ts → MemoryFactRow for field semantics
    // and docs/external/partneros-analysis.md §五.4 for the integration plan.
    sql: `
      CREATE TABLE IF NOT EXISTS memory_facts (
        fact_id       TEXT PRIMARY KEY,
        subject_type  TEXT NOT NULL CHECK (subject_type IN ('client','matter','workflow','tenant','agent')),
        subject_id    TEXT NOT NULL,
        fact_type     TEXT NOT NULL CHECK (fact_type IN ('preference','correction','constraint','observation')),
        fact_text     TEXT NOT NULL,
        source_type   TEXT NOT NULL CHECK (source_type IN ('user_confirmation','agent_inference','telegram','approval_note','intent_extras')),
        source_id     TEXT,
        confidence    REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
        status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','archived')),
        created_at    REAL NOT NULL,
        updated_at    REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_facts_subject
        ON memory_facts(subject_type, subject_id, status);
      CREATE INDEX IF NOT EXISTS idx_memory_facts_status
        ON memory_facts(status);
    `,
  },
  {
    id: 3,
    name: "multi_tenant_columns",
    // Multi-tenancy (partneros-analysis.md §五.10 / 路径 A 项 10).
    //
    // Strategy: ALTER TABLE ... ADD COLUMN tenant_id (nullable) on every
    // domain table. NULL means "default tenant" — i.e. single-tenant
    // installations keep working unchanged. Compound indexes on
    // (tenant_id, subject_id, status) speed up tenant-scoped reads.
    //
    // SQLite limitation: cannot ALTER an existing CHECK constraint or PK,
    // so we don't add tenant_id to PRIMARY KEY. The application is the
    // gatekeeper for "no cross-tenant fact ids".
    sql: `
      ALTER TABLE memory_facts ADD COLUMN tenant_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_memory_facts_tenant_subject
        ON memory_facts(tenant_id, subject_type, subject_id, status);

      ALTER TABLE tasks ADD COLUMN tenant_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(tenant_id);

      ALTER TABLE runs ADD COLUMN tenant_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_runs_tenant ON runs(tenant_id);

      ALTER TABLE approvals ADD COLUMN tenant_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_approvals_tenant ON approvals(tenant_id);

      ALTER TABLE clarifies ADD COLUMN tenant_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_clarifies_tenant ON clarifies(tenant_id);
    `,
  },
  {
    id: 4,
    name: "kanban",
    // Kanban board layer — best practices borrowed from Hermes Agent's kanban
    // (hermes-webui/api/kanban_bridge.py). See packages/core/src/kanban/.
    //
    // Highlights adapted:
    //   - 6-lane board model (triage→todo→ready→running→blocked→done, +archived)
    //   - per-card event log with monotonic id for incremental polling
    //   - notify subscriptions: a (platform, chat_id, thread_id) tuple can
    //     subscribe to a card and receive event pushes — the Telegram hook
    //     that lets Hermes relay osstack board progress into a chat.
    //   - parent/child links (dependency DAG), comments, priority, assignee.
    //
    // A card MAY reference an osstack task (task_id) so the daemon can
    // auto-create/auto-move cards as the run pipeline advances; standalone
    // cards (task_id NULL) are also allowed for pure planning.
    sql: `
      CREATE TABLE IF NOT EXISTS kanban_cards (
        card_id        TEXT PRIMARY KEY,
        board          TEXT NOT NULL DEFAULT 'default',
        task_id        TEXT,
        title          TEXT NOT NULL,
        body           TEXT NOT NULL DEFAULT '',
        status         TEXT NOT NULL DEFAULT 'triage'
                         CHECK (status IN ('triage','todo','ready','running','blocked','done','archived')),
        priority       INTEGER NOT NULL DEFAULT 0,
        assignee       TEXT,
        blocked_reason TEXT,
        tenant_id      TEXT,
        created_at     REAL NOT NULL,
        updated_at     REAL NOT NULL,
        started_at     REAL,
        completed_at   REAL
      );
      CREATE INDEX IF NOT EXISTS idx_kanban_cards_board_status ON kanban_cards(board, status);
      CREATE INDEX IF NOT EXISTS idx_kanban_cards_task         ON kanban_cards(task_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_cards_assignee     ON kanban_cards(assignee);
      CREATE INDEX IF NOT EXISTS idx_kanban_cards_priority     ON kanban_cards(board, priority DESC);

      CREATE TABLE IF NOT EXISTS kanban_card_links (
        parent_id TEXT NOT NULL,
        child_id  TEXT NOT NULL,
        PRIMARY KEY (parent_id, child_id)
      );
      CREATE INDEX IF NOT EXISTS idx_kanban_links_child  ON kanban_card_links(child_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_links_parent ON kanban_card_links(parent_id);

      CREATE TABLE IF NOT EXISTS kanban_card_comments (
        comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id    TEXT NOT NULL,
        author     TEXT NOT NULL,
        body       TEXT NOT NULL,
        created_at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kanban_comments_card ON kanban_card_comments(card_id, created_at);

      CREATE TABLE IF NOT EXISTS kanban_card_events (
        event_id   INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id    TEXT NOT NULL,
        board      TEXT NOT NULL DEFAULT 'default',
        kind       TEXT NOT NULL,
        payload    TEXT,
        created_at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kanban_events_card  ON kanban_card_events(card_id, event_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_events_board ON kanban_card_events(board, event_id);

      CREATE TABLE IF NOT EXISTS kanban_notify_subs (
        card_id       TEXT NOT NULL,
        platform      TEXT NOT NULL,
        chat_id       TEXT NOT NULL,
        thread_id     TEXT NOT NULL DEFAULT '',
        user_id       TEXT,
        last_event_id INTEGER NOT NULL DEFAULT 0,
        created_at    REAL NOT NULL,
        PRIMARY KEY (card_id, platform, chat_id, thread_id)
      );
      CREATE INDEX IF NOT EXISTS idx_kanban_subs_card ON kanban_notify_subs(card_id);
    `,
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.id;
