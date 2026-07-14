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
  {
    id: 5,
    name: "pitfall_lessons",
    // Learning Control Plane: durable pitfall KB extracted from failed,
    // escalated, blocked, or otherwise instructive runs.
    sql: `
      CREATE TABLE IF NOT EXISTS pitfall_lessons (
        pitfall_id          TEXT PRIMARY KEY,
        family              TEXT NOT NULL,
        fingerprint         TEXT NOT NULL UNIQUE,
        tech_stack_json     TEXT NOT NULL,
        symptom             TEXT NOT NULL,
        resolution          TEXT NOT NULL,
        verified_count      INTEGER NOT NULL DEFAULT 1 CHECK (verified_count >= 0),
        source_run_ids_json TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
        tenant_id           TEXT,
        created_at          REAL NOT NULL,
        updated_at          REAL NOT NULL,
        last_seen_at        REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pitfall_lessons_family
        ON pitfall_lessons(family, status, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pitfall_lessons_tenant
        ON pitfall_lessons(tenant_id, status, last_seen_at DESC);
    `,
  },
  {
    id: 6,
    name: "supervisor_control_plane",
    // Recursive control plane: feedback assets, improvement proposals,
    // versioned evaluators, evaluator epochs, anchor cases, and quarantined
    // scores. Populated by @osstack/supervisor via the CLI; all deterministic.
    sql: `
      CREATE TABLE IF NOT EXISTS feedback_assets (
        asset_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        source_trace_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        failure_family TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        suggested_storage_path TEXT,
        status TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_assets_repo_status
        ON feedback_assets (repo_id, status);
      CREATE INDEX IF NOT EXISTS idx_feedback_assets_trace
        ON feedback_assets (source_trace_id);

      CREATE TABLE IF NOT EXISTS improvement_proposals (
        proposal_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        source_asset_ids_json TEXT NOT NULL,
        target TEXT NOT NULL,
        risk TEXT NOT NULL,
        title TEXT NOT NULL,
        rationale TEXT NOT NULL,
        proposed_changes_json TEXT NOT NULL,
        required_gates_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_improvement_proposals_repo_status
        ON improvement_proposals (repo_id, status);

      CREATE TABLE IF NOT EXISTS evaluator_versions (
        evaluator_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        version TEXT NOT NULL,
        title TEXT NOT NULL,
        rubric TEXT NOT NULL,
        implementation_ref TEXT,
        status TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evaluator_versions_repo_status
        ON evaluator_versions (repo_id, status);

      CREATE TABLE IF NOT EXISTS evaluator_epochs (
        epoch_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        frozen_evaluator_id TEXT NOT NULL,
        started_at REAL NOT NULL,
        ended_at REAL,
        anchor_case_ids_json TEXT NOT NULL,
        challenger_evaluator_ids_json TEXT NOT NULL,
        promotion_decision_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_evaluator_epochs_repo_started
        ON evaluator_epochs (repo_id, started_at);

      CREATE TABLE IF NOT EXISTS anchor_cases (
        case_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        source_trace_id TEXT,
        input_summary TEXT NOT NULL,
        expected_verdict TEXT NOT NULL,
        expected_failure_family TEXT,
        evidence_refs_json TEXT NOT NULL,
        adversarial INTEGER NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_anchor_cases_repo_adversarial
        ON anchor_cases (repo_id, adversarial);

      CREATE TABLE IF NOT EXISTS score_quarantine (
        quarantine_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        score_id TEXT NOT NULL,
        evaluator_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_score_quarantine_repo_evaluator
        ON score_quarantine (repo_id, evaluator_id);
    `,
  },
  {
    id: 7,
    name: "kanban_typed_cards",
    // Typed cards + verification checks: lets a card declare what kind of
    // work it represents (pr/implementation/review/merge) and carry a
    // free-form JSON `meta` blob (e.g. PR number, branch, links), plus a
    // per-card ordered checklist of verification steps (kanban_card_checks)
    // used by the merge-orchestration loop to gate a card's progress.
    sql: `
      ALTER TABLE kanban_cards ADD COLUMN card_type TEXT NOT NULL DEFAULT 'implementation';
      ALTER TABLE kanban_cards ADD COLUMN meta TEXT;
      CREATE INDEX IF NOT EXISTS idx_kanban_cards_type ON kanban_cards(board, card_type);

      CREATE TABLE IF NOT EXISTS kanban_card_checks (
        card_id    TEXT    NOT NULL,
        idx        INTEGER NOT NULL,
        label      TEXT    NOT NULL,
        state      TEXT    NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','pass','fail')),
        detail     TEXT,
        updated_at REAL    NOT NULL,
        PRIMARY KEY (card_id, idx)
      );
      CREATE INDEX IF NOT EXISTS idx_kanban_checks_card ON kanban_card_checks(card_id);
    `,
  },
  {
    id: 8,
    name: "contract_approvals",
    // R1.5 contract-gated delivery: approval records for Execution Contracts.
    //
    // Why a DEDICATED table and NOT the existing `approvals` table: `approvals`
    // is `run_id NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE` — it is
    // structurally coupled to a run in the daemon hot loop (populated by the
    // approval.requested/approval.resolved event double-write in run-store.ts,
    // and read by approvalRowToRequest as a non-null run_id). A contract has NO
    // run at approval time (control v1 does NOT spawn deliver; deliver runs
    // later, if ever). Forcing a synthetic run row would violate that FK's
    // intent and pollute idx_approvals_run + the run-scoped daemon queries. So
    // contract approvals get their own minimal table, keyed by contract_id.
    //
    // `contract_approvals` is the AUTHORITATIVE current lifecycle state of a
    // contract (the kanban card is a best-effort projection). One row per
    // contract; the same approval_id lives for the contract's life so the
    // protocol ApprovalRequest (emitted at `start`) and ApprovalDecision
    // (emitted at `approve`) round-trip against one record. State machine
    // (see contract-approvals.ts):
    //   pending --approve--> approved
    //   pending|approved --revise--> revising --approve--> approved
    //   any non-stopped --stop--> stopped (terminal)
    //
    // `contract_approval_decisions` is the APPEND-ONLY decision history: every
    // approve/revise/stop appends a row. The current-state row stays for O(1)
    // guards; the trail renders in `control status`.
    sql: `
      CREATE TABLE IF NOT EXISTS contract_approvals (
        approval_id      TEXT PRIMARY KEY,
        contract_id      TEXT NOT NULL,
        action           TEXT NOT NULL,
        risk             TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
        status           TEXT NOT NULL CHECK (status IN ('pending','approved','revising','stopped')),
        requested_at     REAL NOT NULL,
        decided_by_type  TEXT CHECK (decided_by_type IN ('human','agent')),
        decided_by_id    TEXT,
        decided_at       REAL,
        reason           TEXT,
        created_at       REAL NOT NULL,
        updated_at       REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_contract_approvals_contract
        ON contract_approvals(contract_id);

      CREATE TABLE IF NOT EXISTS contract_approval_decisions (
        decision_id  TEXT PRIMARY KEY,
        approval_id  TEXT NOT NULL,
        contract_id  TEXT NOT NULL,
        action       TEXT NOT NULL CHECK (action IN ('approve','revise','stop')),
        actor_type   TEXT NOT NULL CHECK (actor_type IN ('human','agent')),
        actor_id     TEXT NOT NULL,
        reason       TEXT,
        decided_at   REAL NOT NULL,
        created_at   REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_contract_approval_decisions_contract
        ON contract_approval_decisions(contract_id, decided_at);
    `,
  },
  {
    id: 9,
    name: "resumable_agent_sessions",
    // Durable native-agent session identity and exactly-once remote input.
    // Tool arguments, command output and reasoning never enter these tables.
    sql: `
      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id        TEXT PRIMARY KEY,
        task_id           TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        run_id            TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        agent_id          TEXT NOT NULL,
        native_session_id TEXT,
        state             TEXT NOT NULL CHECK (state IN (
          'starting','running','awaiting_decision','idle','completed','failed','cancelled'
        )),
        resume_supported  INTEGER NOT NULL CHECK (resume_supported IN (0,1)),
        version           INTEGER NOT NULL CHECK (version > 0),
        updated_at        REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_task
        ON agent_sessions(task_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent_state
        ON agent_sessions(agent_id, state, updated_at DESC);

      CREATE TABLE IF NOT EXISTS session_turns (
        turn_id        TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
        ordinal        INTEGER NOT NULL CHECK (ordinal > 0),
        state          TEXT NOT NULL CHECK (state IN (
          'starting','running','awaiting_decision','idle','completed','failed','cancelled'
        )),
        assistant_text TEXT NOT NULL DEFAULT '',
        decision_json  TEXT,
        created_at     REAL NOT NULL,
        updated_at     REAL NOT NULL,
        UNIQUE(session_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_session_turns_session_ordinal
        ON session_turns(session_id, ordinal DESC);

      CREATE TABLE IF NOT EXISTS session_messages (
        message_id   TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
        turn_id      TEXT NOT NULL,
        direction    TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
        kind         TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state        TEXT NOT NULL CHECK (state IN ('pending','accepted','applied','failed')),
        created_at   REAL NOT NULL,
        applied_at   REAL
      );
      CREATE INDEX IF NOT EXISTS idx_session_messages_session_state
        ON session_messages(session_id, state, created_at);
      CREATE INDEX IF NOT EXISTS idx_session_messages_turn
        ON session_messages(turn_id, created_at);
    `,
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.id;
