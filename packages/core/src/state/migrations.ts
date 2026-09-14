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
    name: "knowledge_hygiene_history",
    // ADR-003: normalized event history. Full report blobs remain caller-owned;
    // core stores report identity, bounded finding metadata, occurrences, and
    // explicit resolutions only.
    sql: `
      CREATE TABLE IF NOT EXISTS knowledge_hygiene_runs (
        run_id            TEXT PRIMARY KEY,
        report_sha256     TEXT NOT NULL UNIQUE,
        schema_version    TEXT NOT NULL,
        repo_id           TEXT NOT NULL,
        repo_root         TEXT NOT NULL,
        mode              TEXT NOT NULL CHECK (mode IN ('all','worktree','range','base_to_worktree')),
        diff_id           TEXT,
        config_sha256     TEXT,
        generated_at      REAL NOT NULL,
        recorded_at       REAL NOT NULL,
        complete          INTEGER NOT NULL CHECK (complete IN (0,1)),
        skipped_files     INTEGER NOT NULL,
        error_count       INTEGER NOT NULL,
        warning_count     INTEGER NOT NULL,
        info_count        INTEGER NOT NULL,
        suppressed_count  INTEGER NOT NULL,
        resolved_count    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_hygiene_runs_repo_generated
        ON knowledge_hygiene_runs(repo_id, generated_at, run_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_hygiene_runs_diff
        ON knowledge_hygiene_runs(diff_id);

      CREATE TABLE IF NOT EXISTS knowledge_hygiene_findings (
        repo_id            TEXT NOT NULL,
        fingerprint        TEXT NOT NULL,
        rule_id            TEXT NOT NULL,
        surface            TEXT NOT NULL,
        severity           TEXT NOT NULL CHECK (severity IN ('error','warning','info')),
        location_path      TEXT NOT NULL,
        rationale          TEXT NOT NULL,
        first_seen_at      REAL NOT NULL,
        last_seen_at       REAL NOT NULL,
        occurrence_count   INTEGER NOT NULL CHECK (occurrence_count >= 1),
        current_state      TEXT NOT NULL CHECK (current_state IN ('active','resolved','closed_absent')),
        closed_at          REAL,
        last_run_id        TEXT NOT NULL REFERENCES knowledge_hygiene_runs(run_id),
        PRIMARY KEY (repo_id, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_hygiene_findings_repo_state
        ON knowledge_hygiene_findings(repo_id, current_state, severity, last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_knowledge_hygiene_findings_rule
        ON knowledge_hygiene_findings(repo_id, rule_id, current_state);

      CREATE TABLE IF NOT EXISTS knowledge_hygiene_occurrences (
        run_id              TEXT NOT NULL REFERENCES knowledge_hygiene_runs(run_id) ON DELETE CASCADE,
        repo_id              TEXT NOT NULL,
        fingerprint          TEXT NOT NULL,
        state                TEXT NOT NULL CHECK (state IN ('active','resolved','closed_absent')),
        severity             TEXT NOT NULL CHECK (severity IN ('error','warning','info')),
        observed_at          REAL NOT NULL,
        resolution_outcome   TEXT,
        PRIMARY KEY (run_id, repo_id, fingerprint, state),
        FOREIGN KEY (repo_id, fingerprint)
          REFERENCES knowledge_hygiene_findings(repo_id, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_hygiene_occurrences_repo_time
        ON knowledge_hygiene_occurrences(repo_id, observed_at, run_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_hygiene_occurrences_state
        ON knowledge_hygiene_occurrences(repo_id, state, observed_at);

      CREATE TABLE IF NOT EXISTS knowledge_hygiene_resolutions (
        resolution_id      TEXT PRIMARY KEY,
        run_id             TEXT NOT NULL REFERENCES knowledge_hygiene_runs(run_id) ON DELETE CASCADE,
        repo_id            TEXT NOT NULL,
        diff_id            TEXT NOT NULL,
        fingerprint        TEXT NOT NULL,
        outcome            TEXT NOT NULL CHECK (outcome IN ('fixed','reviewed_no_change','accepted_risk','suppressed','obsolete')),
        actor_kind         TEXT NOT NULL CHECK (actor_kind IN ('human','agent')),
        actor_id           TEXT NOT NULL,
        reason             TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        resolved_at        REAL NOT NULL,
        UNIQUE (diff_id, fingerprint),
        FOREIGN KEY (repo_id, fingerprint)
          REFERENCES knowledge_hygiene_findings(repo_id, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_hygiene_resolutions_repo_time
        ON knowledge_hygiene_resolutions(repo_id, resolved_at, fingerprint);
    `,
  },
  {
    id: 10,
    name: "knowledge_hygiene_confidence",
    // R4 recurrence proposals require per-occurrence high-confidence evidence.
    // Historical rows predate this field and remain deliberately ineligible.
    sql: `
      ALTER TABLE knowledge_hygiene_findings
        ADD COLUMN confidence TEXT NOT NULL DEFAULT 'unknown'
        CHECK (confidence IN ('high','medium','low','unknown'));
      ALTER TABLE knowledge_hygiene_occurrences
        ADD COLUMN confidence TEXT NOT NULL DEFAULT 'unknown'
        CHECK (confidence IN ('high','medium','low','unknown'));
      CREATE INDEX IF NOT EXISTS idx_knowledge_hygiene_occurrences_confidence
        ON knowledge_hygiene_occurrences(confidence, state, repo_id, fingerprint);
    `,
  },
  {
    id: 11,
    name: "probe_sessions",
    // ADR-004: live probe sessions are core-owned transactional projections.
    // Governance validates domain JSON before this store receives it; these
    // tables keep only bounded indexes plus the canonical validated snapshots.
    sql: `
      CREATE TABLE IF NOT EXISTS probe_sessions (
        session_id      TEXT PRIMARY KEY,
        repo_id         TEXT NOT NULL,
        state           TEXT NOT NULL CHECK (state IN ('active','paused','completed','abandoned')),
        revision        INTEGER NOT NULL CHECK (revision >= 1),
        snapshot_json   TEXT NOT NULL,
        created_at_ms   INTEGER NOT NULL,
        updated_at_ms   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_probe_sessions_repo_state_updated
        ON probe_sessions(repo_id, state, updated_at_ms);

      CREATE TABLE IF NOT EXISTS probe_items (
        session_id       TEXT NOT NULL REFERENCES probe_sessions(session_id) ON DELETE CASCADE,
        item_id          TEXT NOT NULL,
        question_id      TEXT NOT NULL,
        state            TEXT NOT NULL CHECK (state IN ('open','deferred','resolved','waived','invalidated')),
        current_quadrant TEXT NOT NULL CHECK (current_quadrant IN ('kk','ku','uk','uu')),
        severity         TEXT NOT NULL CHECK (severity IN ('high','medium','low')),
        updated_at_ms    INTEGER NOT NULL,
        item_json        TEXT NOT NULL,
        PRIMARY KEY (session_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_probe_items_session_state_severity
        ON probe_items(session_id, state, severity);
      CREATE INDEX IF NOT EXISTS idx_probe_items_session_question
        ON probe_items(session_id, question_id);

      CREATE TABLE IF NOT EXISTS probe_events (
        event_id        TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL REFERENCES probe_sessions(session_id) ON DELETE CASCADE,
        revision        INTEGER NOT NULL CHECK (revision >= 1),
        type            TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        event_json      TEXT NOT NULL,
        occurred_at_ms  INTEGER NOT NULL,
        UNIQUE (session_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_probe_events_session_time
        ON probe_events(session_id, occurred_at_ms, revision);

      CREATE TABLE IF NOT EXISTS probe_artifacts (
        receipt_id        TEXT PRIMARY KEY,
        session_id        TEXT NOT NULL REFERENCES probe_sessions(session_id) ON DELETE CASCADE,
        exported_revision INTEGER NOT NULL CHECK (exported_revision >= 1),
        idempotency_key   TEXT NOT NULL,
        actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('human','agent')),
        actor_id          TEXT NOT NULL,
        manifest_json     TEXT NOT NULL,
        rendered_at_ms    INTEGER NOT NULL,
        UNIQUE (session_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_probe_artifacts_session_revision
        ON probe_artifacts(session_id, exported_revision, rendered_at_ms);

      CREATE TABLE IF NOT EXISTS probe_command_receipts (
        scope_key        TEXT NOT NULL,
        idempotency_key  TEXT NOT NULL,
        request_sha256   TEXT NOT NULL,
        result_json      TEXT NOT NULL,
        created_at_ms    INTEGER NOT NULL,
        PRIMARY KEY (scope_key, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_probe_command_receipts_created
        ON probe_command_receipts(created_at_ms, scope_key);
    `,
  },
  {
    id: 12,
    name: "knowledge_hygiene_v2_history",
    // V2 is deliberately additive. The V1 finding-state CHECK remains intact;
    // append-only lifecycle events and their rebuildable projection live here.
    sql: `
      CREATE TABLE IF NOT EXISTS knowledge_hygiene_runs_v2 (
        run_id             TEXT PRIMARY KEY,
        report_sha256      TEXT NOT NULL UNIQUE,
        schema_version     TEXT NOT NULL CHECK (schema_version = '2'),
        repo_id            TEXT NOT NULL,
        repo_root          TEXT NOT NULL,
        mode               TEXT NOT NULL CHECK (mode IN ('all','worktree','range','base_to_worktree')),
        diff_id            TEXT,
        config_sha256      TEXT,
        generated_at       REAL NOT NULL,
        recorded_at        REAL NOT NULL,
        inventory_complete INTEGER NOT NULL CHECK (inventory_complete IN (0,1)),
        coverage_json      TEXT NOT NULL,
        health_claim       TEXT NOT NULL CHECK (health_claim IN ('findings_present','assessed_scope_clean','assessment_incomplete')),
        error_count        INTEGER NOT NULL,
        warning_count      INTEGER NOT NULL,
        info_count         INTEGER NOT NULL,
        suppressed_count   INTEGER NOT NULL,
        resolved_count     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_hygiene_runs_v2_repo_time
        ON knowledge_hygiene_runs_v2(repo_id, generated_at, run_id);

      CREATE TABLE IF NOT EXISTS knowledge_hygiene_findings_v2 (
        repo_id           TEXT NOT NULL,
        fingerprint       TEXT NOT NULL,
        finding_json      TEXT NOT NULL,
        first_seen_at     REAL NOT NULL,
        last_seen_at      REAL NOT NULL,
        occurrence_count INTEGER NOT NULL CHECK (occurrence_count >= 1),
        last_run_id       TEXT NOT NULL REFERENCES knowledge_hygiene_runs_v2(run_id),
        PRIMARY KEY (repo_id, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_hygiene_findings_v2_last_seen
        ON knowledge_hygiene_findings_v2(repo_id, last_seen_at, fingerprint);

      CREATE TABLE IF NOT EXISTS knowledge_hygiene_occurrences_v2 (
        run_id       TEXT NOT NULL REFERENCES knowledge_hygiene_runs_v2(run_id) ON DELETE CASCADE,
        repo_id       TEXT NOT NULL,
        fingerprint   TEXT NOT NULL,
        observed_at   REAL NOT NULL,
        PRIMARY KEY (run_id, repo_id, fingerprint),
        FOREIGN KEY (repo_id, fingerprint)
          REFERENCES knowledge_hygiene_findings_v2(repo_id, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_hygiene_occurrences_v2_repo_time
        ON knowledge_hygiene_occurrences_v2(repo_id, observed_at, run_id);

      CREATE TABLE IF NOT EXISTS knowledge_hygiene_resolution_events_v2 (
        event_id      TEXT PRIMARY KEY,
        repo_id       TEXT NOT NULL,
        fingerprint   TEXT NOT NULL,
        from_state    TEXT NOT NULL,
        to_state      TEXT NOT NULL,
        event_json    TEXT NOT NULL,
        occurred_at   REAL NOT NULL,
        FOREIGN KEY (repo_id, fingerprint)
          REFERENCES knowledge_hygiene_findings_v2(repo_id, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_hygiene_resolution_events_v2_finding
        ON knowledge_hygiene_resolution_events_v2(repo_id, fingerprint, occurred_at, event_id);

      CREATE TABLE IF NOT EXISTS knowledge_hygiene_finding_state_v2 (
        repo_id        TEXT NOT NULL,
        fingerprint    TEXT NOT NULL,
        current_state  TEXT NOT NULL CHECK (current_state IN (
          'open','mechanically_applied','mechanically_resolved','semantically_resolved',
          'reviewed_no_change','accepted_risk','suppressed','obsolete','closed_absent','resolved_legacy'
        )),
        last_event_id  TEXT,
        updated_at     REAL NOT NULL,
        PRIMARY KEY (repo_id, fingerprint),
        FOREIGN KEY (repo_id, fingerprint)
          REFERENCES knowledge_hygiene_findings_v2(repo_id, fingerprint),
        FOREIGN KEY (last_event_id)
          REFERENCES knowledge_hygiene_resolution_events_v2(event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_hygiene_finding_state_v2_state
        ON knowledge_hygiene_finding_state_v2(repo_id, current_state, updated_at);
    `,
  },
  {
    id: 13,
    name: "knowledge_hygiene_v2_assessment_scope",
    sql: `
      ALTER TABLE knowledge_hygiene_runs_v2
        ADD COLUMN assessment_scope_json TEXT NOT NULL
        DEFAULT '{"selected_rule_ids":[]}';
    `,
  },
  {
    id: 14,
    name: "knowledge_hygiene_plan_events",
    sql: `
      CREATE TABLE IF NOT EXISTS knowledge_hygiene_plan_events (
        event_id     TEXT PRIMARY KEY,
        plan_id      TEXT NOT NULL,
        revision     INTEGER NOT NULL CHECK (revision >= 1),
        from_state   TEXT,
        to_state     TEXT NOT NULL,
        event_json   TEXT NOT NULL,
        occurred_at  REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_hygiene_plan_events_plan
        ON knowledge_hygiene_plan_events(plan_id, occurred_at, event_id);

      CREATE TABLE IF NOT EXISTS knowledge_hygiene_plan_projection (
        plan_id          TEXT PRIMARY KEY,
        kind             TEXT NOT NULL CHECK (kind IN ('memory','narrative','dependency')),
        repo_id          TEXT NOT NULL,
        revision         INTEGER NOT NULL CHECK (revision >= 1),
        state            TEXT NOT NULL CHECK (state IN (
          'draft','partially_approved','approved','applying','applied',
          'recovery_required','recovered','stale','cancelled'
        )),
        artifact_path    TEXT NOT NULL,
        artifact_sha256  TEXT NOT NULL,
        last_event_id    TEXT NOT NULL REFERENCES knowledge_hygiene_plan_events(event_id),
        updated_at       REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_hygiene_plan_projection_repo
        ON knowledge_hygiene_plan_projection(repo_id, state, updated_at);
    `,
  },
  {
    id: 15,
    name: "dependency_obligation_inbox",
    sql: `
      CREATE TABLE IF NOT EXISTS dependency_registry_scopes (
        registry_scope  TEXT PRIMARY KEY,
        registry_path   TEXT NOT NULL UNIQUE,
        updated_at      REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dependency_obligation_events (
        event_id       TEXT PRIMARY KEY,
        obligation_id  TEXT NOT NULL,
        revision       INTEGER NOT NULL CHECK (revision >= 1),
        from_state     TEXT,
        to_state       TEXT NOT NULL,
        event_json     TEXT NOT NULL,
        occurred_at    REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dependency_obligation_events_obligation
        ON dependency_obligation_events(obligation_id, revision, event_id);

      CREATE TABLE IF NOT EXISTS dependency_obligation_projection (
        obligation_id       TEXT PRIMARY KEY,
        registry_scope      TEXT NOT NULL,
        downstream_repo_id  TEXT NOT NULL,
        revision            INTEGER NOT NULL CHECK (revision >= 1),
        state               TEXT NOT NULL CHECK (state IN (
          'candidate','advisory','promoted','dismissed','expired'
        )),
        snapshot_json       TEXT NOT NULL,
        last_event_id       TEXT NOT NULL REFERENCES dependency_obligation_events(event_id),
        updated_at          REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dependency_obligation_inbox
        ON dependency_obligation_projection(
          registry_scope, downstream_repo_id, state, updated_at
        );

      CREATE TABLE IF NOT EXISTS declared_dependency_edge_events (
        event_id      TEXT PRIMARY KEY,
        edge_id       TEXT NOT NULL,
        revision      INTEGER NOT NULL CHECK (revision >= 1),
        from_state    TEXT,
        to_state      TEXT NOT NULL,
        event_json    TEXT NOT NULL,
        occurred_at   REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_declared_dependency_edge_events_edge
        ON declared_dependency_edge_events(edge_id, revision, event_id);

      CREATE TABLE IF NOT EXISTS declared_dependency_edge_projection (
        edge_id                 TEXT PRIMARY KEY,
        registry_scope          TEXT NOT NULL,
        downstream_repo_id      TEXT NOT NULL,
        revision                INTEGER NOT NULL CHECK (revision >= 1),
        state                   TEXT NOT NULL CHECK (state IN (
          'confirmed','review_due','revoked'
        )),
        source_config_sha256    TEXT NOT NULL,
        edge_json               TEXT NOT NULL,
        last_event_id           TEXT NOT NULL REFERENCES declared_dependency_edge_events(event_id),
        updated_at              REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_declared_dependency_edge_repo
        ON declared_dependency_edge_projection(
          registry_scope, downstream_repo_id, state, updated_at
        );
    `,
  },
  {
    id: 16,
    name: "knowledge_hygiene_dependency_plan_kind",
    sql: `
      ALTER TABLE knowledge_hygiene_plan_projection
        RENAME TO knowledge_hygiene_plan_projection_v14;
      CREATE TABLE knowledge_hygiene_plan_projection (
        plan_id          TEXT PRIMARY KEY,
        kind             TEXT NOT NULL CHECK (kind IN (
          'memory','narrative','dependency'
        )),
        repo_id          TEXT NOT NULL,
        revision         INTEGER NOT NULL CHECK (revision >= 1),
        state            TEXT NOT NULL CHECK (state IN (
          'draft','partially_approved','approved','applying','applied',
          'recovery_required','recovered','stale','cancelled'
        )),
        artifact_path    TEXT NOT NULL,
        artifact_sha256  TEXT NOT NULL,
        last_event_id    TEXT NOT NULL REFERENCES knowledge_hygiene_plan_events(event_id),
        updated_at       REAL NOT NULL
      );
      INSERT INTO knowledge_hygiene_plan_projection (
        plan_id, kind, repo_id, revision, state, artifact_path,
        artifact_sha256, last_event_id, updated_at
      ) SELECT
        plan_id, kind, repo_id, revision, state, artifact_path,
        artifact_sha256, last_event_id, updated_at
      FROM knowledge_hygiene_plan_projection_v14;
      DROP TABLE knowledge_hygiene_plan_projection_v14;
      CREATE INDEX idx_knowledge_hygiene_plan_projection_repo
        ON knowledge_hygiene_plan_projection(repo_id, state, updated_at);
    `,
  },
  {
    id: 17,
    name: "guarded_autonomy_runs",
    sql: `
      CREATE TABLE autonomy_run_transitions (
        transition_id        TEXT PRIMARY KEY,
        autonomy_run_id      TEXT NOT NULL,
        seq                  INTEGER NOT NULL CHECK (seq >= 1),
        from_state           TEXT CHECK (
          from_state IS NULL OR from_state IN (
            'queued','classifying','awaiting_approval','blocked','preparing',
            'building','verifying','repairing','reviewing','post_classifying',
            'candidate_proof','committing','pushing','opening_pr','waiting_ci',
            'merging','final_proof','blocked_delivery','delivery_evidence_failed',
            'escalated','cancelled','completed'
          )
        ),
        to_state             TEXT NOT NULL CHECK (to_state IN (
          'queued','classifying','awaiting_approval','blocked','preparing',
          'building','verifying','repairing','reviewing','post_classifying',
          'candidate_proof','committing','pushing','opening_pr','waiting_ci',
          'merging','final_proof','blocked_delivery','delivery_evidence_failed',
          'escalated','cancelled','completed'
        )),
        event_json           TEXT NOT NULL,
        contract_decision_id TEXT REFERENCES contract_approval_decisions(decision_id),
        occurred_at          REAL NOT NULL,
        UNIQUE (autonomy_run_id, seq)
      );
      CREATE INDEX idx_autonomy_run_transitions_run
        ON autonomy_run_transitions(autonomy_run_id, seq);
      CREATE TRIGGER autonomy_run_transitions_no_update
        BEFORE UPDATE ON autonomy_run_transitions
        BEGIN
          SELECT RAISE(ABORT, 'autonomy run transitions are append-only');
        END;
      CREATE TRIGGER autonomy_run_transitions_no_delete
        BEFORE DELETE ON autonomy_run_transitions
        BEGIN
          SELECT RAISE(ABORT, 'autonomy run transitions are append-only');
        END;

      CREATE TABLE autonomy_run_projection (
        autonomy_run_id      TEXT PRIMARY KEY,
        task_id              TEXT NOT NULL,
        repo_id              TEXT NOT NULL,
        workspace_path       TEXT NOT NULL,
        state                TEXT NOT NULL CHECK (state IN (
          'queued','classifying','awaiting_approval','blocked','preparing',
          'building','verifying','repairing','reviewing','post_classifying',
          'candidate_proof','committing','pushing','opening_pr','waiting_ci',
          'merging','final_proof','blocked_delivery','delivery_evidence_failed',
          'escalated','cancelled','completed'
        )),
        revision             INTEGER NOT NULL CHECK (revision >= 1),
        contract_sha256      TEXT NOT NULL CHECK (
          length(contract_sha256) = 64 AND contract_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        diff_sha256          TEXT CHECK (
          diff_sha256 IS NULL OR (
            length(diff_sha256) = 64 AND diff_sha256 NOT GLOB '*[^0-9a-f]*'
          )
        ),
        preflight_risk_json  TEXT,
        post_diff_risk_json  TEXT,
        approval_json        TEXT,
        routing_json         TEXT,
        budget_json          TEXT NOT NULL,
        attempt_json         TEXT NOT NULL,
        candidate_proof_json TEXT,
        git_delivery_json    TEXT,
        final_proof_json     TEXT,
        last_transition_id   TEXT NOT NULL
          REFERENCES autonomy_run_transitions(transition_id),
        created_at           REAL NOT NULL,
        updated_at           REAL NOT NULL
      );
      CREATE INDEX idx_autonomy_run_projection_repo_state
        ON autonomy_run_projection(repo_id, state, updated_at);
      CREATE UNIQUE INDEX idx_autonomy_run_projection_one_active_repo
        ON autonomy_run_projection(repo_id)
        WHERE state NOT IN (
          'blocked','delivery_evidence_failed','escalated','cancelled','completed'
        );
    `,
  },
  {
    id: 18,
    name: "guarded_deploy_state",
    sql: `
      DROP TRIGGER autonomy_run_transitions_no_update;
      DROP TRIGGER autonomy_run_transitions_no_delete;
      DROP INDEX idx_autonomy_run_transitions_run;
      DROP INDEX idx_autonomy_run_projection_repo_state;
      DROP INDEX idx_autonomy_run_projection_one_active_repo;

      ALTER TABLE autonomy_run_projection
        RENAME TO autonomy_run_projection_v17;
      ALTER TABLE autonomy_run_transitions
        RENAME TO autonomy_run_transitions_v17;

      CREATE TABLE autonomy_run_transitions (
        transition_id        TEXT PRIMARY KEY,
        autonomy_run_id      TEXT NOT NULL,
        seq                  INTEGER NOT NULL CHECK (seq >= 1),
        from_state           TEXT CHECK (
          from_state IS NULL OR from_state IN (
            'queued','classifying','awaiting_approval','blocked','preparing',
            'building','verifying','repairing','reviewing','post_classifying',
            'candidate_proof','committing','pushing','opening_pr','waiting_ci',
            'merging','deploying_staging','verifying_staging',
            'deploying_production','health_checking','rolling_back',
            'deploy_frozen','final_proof','blocked_delivery',
            'delivery_evidence_failed','escalated','cancelled','completed'
          )
        ),
        to_state             TEXT NOT NULL CHECK (to_state IN (
          'queued','classifying','awaiting_approval','blocked','preparing',
          'building','verifying','repairing','reviewing','post_classifying',
          'candidate_proof','committing','pushing','opening_pr','waiting_ci',
          'merging','deploying_staging','verifying_staging',
          'deploying_production','health_checking','rolling_back',
          'deploy_frozen','final_proof','blocked_delivery',
          'delivery_evidence_failed','escalated','cancelled','completed'
        )),
        event_json           TEXT NOT NULL,
        contract_decision_id TEXT
          REFERENCES contract_approval_decisions(decision_id),
        occurred_at          REAL NOT NULL,
        UNIQUE (autonomy_run_id, seq)
      );
      INSERT INTO autonomy_run_transitions (
        transition_id, autonomy_run_id, seq, from_state, to_state, event_json,
        contract_decision_id, occurred_at
      ) SELECT
        transition_id, autonomy_run_id, seq, from_state, to_state, event_json,
        contract_decision_id, occurred_at
      FROM autonomy_run_transitions_v17;

      CREATE TABLE autonomy_run_projection (
        autonomy_run_id      TEXT PRIMARY KEY,
        task_id              TEXT NOT NULL,
        repo_id              TEXT NOT NULL,
        workspace_path       TEXT NOT NULL,
        state                TEXT NOT NULL CHECK (state IN (
          'queued','classifying','awaiting_approval','blocked','preparing',
          'building','verifying','repairing','reviewing','post_classifying',
          'candidate_proof','committing','pushing','opening_pr','waiting_ci',
          'merging','deploying_staging','verifying_staging',
          'deploying_production','health_checking','rolling_back',
          'deploy_frozen','final_proof','blocked_delivery',
          'delivery_evidence_failed','escalated','cancelled','completed'
        )),
        revision             INTEGER NOT NULL CHECK (revision >= 1),
        contract_sha256      TEXT NOT NULL CHECK (
          length(contract_sha256) = 64 AND
          contract_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        diff_sha256          TEXT CHECK (
          diff_sha256 IS NULL OR (
            length(diff_sha256) = 64 AND
            diff_sha256 NOT GLOB '*[^0-9a-f]*'
          )
        ),
        preflight_risk_json  TEXT,
        post_diff_risk_json  TEXT,
        approval_json        TEXT,
        routing_json         TEXT,
        budget_json          TEXT NOT NULL,
        attempt_json         TEXT NOT NULL,
        candidate_proof_json TEXT,
        git_delivery_json    TEXT,
        deploy_json          TEXT,
        rollback_json        TEXT,
        final_proof_json     TEXT,
        last_transition_id   TEXT NOT NULL
          REFERENCES autonomy_run_transitions(transition_id),
        created_at           REAL NOT NULL,
        updated_at           REAL NOT NULL
      );
      INSERT INTO autonomy_run_projection (
        autonomy_run_id, task_id, repo_id, workspace_path, state, revision,
        contract_sha256, diff_sha256, preflight_risk_json,
        post_diff_risk_json, approval_json, routing_json, budget_json,
        attempt_json, candidate_proof_json, git_delivery_json,
        deploy_json, rollback_json, final_proof_json, last_transition_id,
        created_at, updated_at
      ) SELECT
        autonomy_run_id, task_id, repo_id, workspace_path, state, revision,
        contract_sha256, diff_sha256, preflight_risk_json,
        post_diff_risk_json, approval_json, routing_json, budget_json,
        attempt_json, candidate_proof_json, git_delivery_json,
        NULL, NULL, final_proof_json, last_transition_id, created_at, updated_at
      FROM autonomy_run_projection_v17;

      DROP TABLE autonomy_run_projection_v17;
      DROP TABLE autonomy_run_transitions_v17;

      CREATE INDEX idx_autonomy_run_transitions_run
        ON autonomy_run_transitions(autonomy_run_id, seq);
      CREATE TRIGGER autonomy_run_transitions_no_update
        BEFORE UPDATE ON autonomy_run_transitions
        BEGIN
          SELECT RAISE(ABORT, 'autonomy run transitions are append-only');
        END;
      CREATE TRIGGER autonomy_run_transitions_no_delete
        BEFORE DELETE ON autonomy_run_transitions
        BEGIN
          SELECT RAISE(ABORT, 'autonomy run transitions are append-only');
        END;
      CREATE INDEX idx_autonomy_run_projection_repo_state
        ON autonomy_run_projection(repo_id, state, updated_at);
      CREATE UNIQUE INDEX idx_autonomy_run_projection_one_active_repo
        ON autonomy_run_projection(repo_id)
        WHERE state NOT IN (
          'blocked','delivery_evidence_failed','escalated','cancelled','completed'
        );

      CREATE TABLE autonomy_deploy_freezes (
        repo_id                 TEXT NOT NULL,
        target                  TEXT NOT NULL CHECK (target = 'production'),
        frozen                  INTEGER NOT NULL CHECK (frozen IN (0,1)),
        reason                  TEXT NOT NULL,
        source_run_id           TEXT NOT NULL
          REFERENCES autonomy_run_projection(autonomy_run_id),
        frozen_at               REAL NOT NULL,
        cleared_at              REAL,
        cleared_by_type         TEXT CHECK (
          cleared_by_type IS NULL OR cleared_by_type = 'human'
        ),
        cleared_by_id           TEXT,
        clear_reason            TEXT,
        clear_decision_sha256   TEXT CHECK (
          clear_decision_sha256 IS NULL OR (
            length(clear_decision_sha256) = 64 AND
            clear_decision_sha256 NOT GLOB '*[^0-9a-f]*'
          )
        ),
        clear_key_id            TEXT,
        PRIMARY KEY (repo_id, target),
        CHECK (
          (
            frozen = 1 AND cleared_at IS NULL AND
            cleared_by_type IS NULL AND cleared_by_id IS NULL AND
            clear_reason IS NULL AND clear_decision_sha256 IS NULL AND
            clear_key_id IS NULL
          ) OR (
            frozen = 0 AND cleared_at IS NOT NULL AND
            cleared_by_type = 'human' AND cleared_by_id IS NOT NULL AND
            clear_reason IS NOT NULL AND clear_decision_sha256 IS NOT NULL AND
            clear_key_id IS NOT NULL
          )
        )
      );
      CREATE INDEX idx_autonomy_deploy_freezes_active
        ON autonomy_deploy_freezes(frozen, repo_id);
    `,
  },
  {
    id: 19,
    name: "autonomy_notification_outbox",
    sql: `
      CREATE TABLE autonomy_notification_outbox (
        notification_id      TEXT PRIMARY KEY,
        dedupe_key           TEXT NOT NULL UNIQUE,
        kind                 TEXT NOT NULL CHECK (kind IN (
          'awaiting_approval','escalated','deploy_frozen',
          'rollback_failed','delivery_evidence_failed'
        )),
        autonomy_run_id      TEXT NOT NULL
          REFERENCES autonomy_run_projection(autonomy_run_id),
        repo_id              TEXT NOT NULL,
        run_state            TEXT NOT NULL,
        payload_json         TEXT NOT NULL,
        status               TEXT NOT NULL CHECK (status IN (
          'pending','delivered','dead_letter','acknowledged'
        )),
        attempt_count        INTEGER NOT NULL DEFAULT 0
          CHECK (attempt_count >= 0),
        next_attempt_at      REAL NOT NULL,
        last_attempt_at      REAL,
        delivered_at         REAL,
        dead_lettered_at     REAL,
        acknowledged_at     REAL,
        acknowledged_by     TEXT,
        last_error_code      TEXT CHECK (
          last_error_code IS NULL OR last_error_code IN (
            'timeout','transport_error','invalid_response'
          )
        ),
        created_at           REAL NOT NULL,
        updated_at           REAL NOT NULL,
        CHECK (
          (status = 'pending' AND delivered_at IS NULL
            AND dead_lettered_at IS NULL AND acknowledged_at IS NULL
            AND acknowledged_by IS NULL)
          OR
          (status = 'delivered' AND delivered_at IS NOT NULL
            AND dead_lettered_at IS NULL AND acknowledged_at IS NULL
            AND acknowledged_by IS NULL)
          OR
          (status = 'dead_letter' AND delivered_at IS NULL
            AND dead_lettered_at IS NOT NULL AND acknowledged_at IS NULL
            AND acknowledged_by IS NULL)
          OR
          (status = 'acknowledged' AND acknowledged_at IS NOT NULL
            AND acknowledged_by IS NOT NULL)
        )
      );
      CREATE INDEX idx_autonomy_notification_outbox_due
        ON autonomy_notification_outbox(
          status, next_attempt_at, created_at
        );
      CREATE INDEX idx_autonomy_notification_outbox_attention
        ON autonomy_notification_outbox(status, created_at);
      CREATE INDEX idx_autonomy_notification_outbox_run
        ON autonomy_notification_outbox(autonomy_run_id, created_at);
    `,
  },
  {
    id: 20,
    name: "autonomy_rollback_drills",
    sql: `
      CREATE TABLE autonomy_rollback_drills (
        drill_id                         TEXT PRIMARY KEY,
        repo_id                          TEXT NOT NULL,
        target                           TEXT NOT NULL
          CHECK (target = 'controlled_non_production'),
        workspace_path                   TEXT NOT NULL,
        deploy_script_digest_sha256      TEXT NOT NULL CHECK (
          length(deploy_script_digest_sha256) = 64 AND
          deploy_script_digest_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        rollback_evidence_json           TEXT NOT NULL,
        post_rollback_health_json        TEXT,
        passed                           INTEGER NOT NULL CHECK (passed IN (0,1)),
        failure_reason                   TEXT CHECK (
          failure_reason IS NULL OR failure_reason IN (
            'rollback_failed','post_rollback_health_failed'
          )
        ),
        started_at                       REAL NOT NULL,
        completed_at                     REAL NOT NULL,
        CHECK (completed_at >= started_at),
        CHECK (
          (passed = 1 AND failure_reason IS NULL
            AND post_rollback_health_json IS NOT NULL)
          OR
          (passed = 0 AND failure_reason IS NOT NULL)
        )
      );
      CREATE INDEX idx_autonomy_rollback_drills_repo
        ON autonomy_rollback_drills(repo_id, completed_at DESC, drill_id);
      CREATE TRIGGER autonomy_rollback_drills_no_update
        BEFORE UPDATE ON autonomy_rollback_drills
        BEGIN
          SELECT RAISE(ABORT, 'autonomy rollback drills are append-only');
        END;
      CREATE TRIGGER autonomy_rollback_drills_no_delete
        BEFORE DELETE ON autonomy_rollback_drills
        BEGIN
          SELECT RAISE(ABORT, 'autonomy rollback drills are append-only');
        END;
    `,
  },
  {
    id: 21,
    name: "resumable_agent_sessions",
    // Durable native-agent session identity and idempotent local input reservation.
    // Tool arguments, command output and reasoning never enter these tables.
    sql: `
      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id        TEXT PRIMARY KEY,
        task_id           TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        run_id            TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        agent_id          TEXT NOT NULL,
        request_sha256    TEXT NOT NULL CHECK (
          length(request_sha256) = 64 AND
          request_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
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
  {
    id: 22,
    name: "agent_session_repo_path",
    // Claude Code resolves persisted native sessions within the original cwd.
    // Existing rows remain empty until an operator performs a verified local
    // backfill; all newly created governed sessions persist the absolute path.
    sql: `
      ALTER TABLE agent_sessions ADD COLUMN repo_path TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    id: 23,
    name: "pitfall_observation_provenance",
    // Legacy verified_count/source_run_ids mixed failures and unrelated
    // successful runs. Preserve them verbatim; only new explicit observations
    // populate this column. Never infer a verified-use history from old counts.
    sql: `
      ALTER TABLE pitfall_lessons
        ADD COLUMN observation_run_ids_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    id: 24,
    name: "session_continuation_grants",
    sql: `
      CREATE TABLE session_continuation_grants (
        grant_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
        body_json TEXT NOT NULL,
        digest TEXT NOT NULL,
        key_id TEXT NOT NULL,
        signature TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','completed','blocked','revoked')),
        reason TEXT,
        step_index INTEGER NOT NULL DEFAULT 0 CHECK (step_index >= 0),
        checks_used INTEGER NOT NULL DEFAULT 0 CHECK (checks_used >= 0),
        resumes_used INTEGER NOT NULL DEFAULT 0 CHECK (resumes_used >= 0),
        retries_used INTEGER NOT NULL DEFAULT 0 CHECK (retries_used >= 0),
        expected_turn_id TEXT NOT NULL,
        expected_version INTEGER NOT NULL CHECK (expected_version > 0),
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      CREATE UNIQUE INDEX idx_session_continuation_one_active
        ON session_continuation_grants(session_id) WHERE status = 'active';
      CREATE INDEX idx_session_continuation_session
        ON session_continuation_grants(session_id, created_at DESC, grant_id);
      CREATE TABLE session_continuation_attempts (
        attempt_id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL REFERENCES session_continuation_grants(grant_id) ON DELETE CASCADE,
        step_index INTEGER NOT NULL CHECK (step_index >= 0),
        source_turn_id TEXT NOT NULL,
        source_version INTEGER NOT NULL CHECK (source_version > 0),
        decision_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('checking','reserved','applied','blocked','abandoned')),
        check_result_json TEXT,
        message_id TEXT UNIQUE REFERENCES session_messages(message_id),
        reservation_version INTEGER,
        action TEXT CHECK (action IN ('continue','retry')),
        completed_turn_id TEXT,
        completed_version INTEGER,
        reason TEXT,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      CREATE UNIQUE INDEX idx_session_continuation_one_attempt
        ON session_continuation_attempts(grant_id) WHERE status IN ('checking','reserved');
    `,
  },
  {
    id: 25,
    name: "graph_run_identity_and_worker_leases",
    sql: `
      CREATE TABLE graph_runs (
        graph_run_id TEXT PRIMARY KEY NOT NULL,
        scope_json TEXT NOT NULL,
        source_json TEXT NOT NULL,
        input_artifact_ref TEXT NOT NULL,
        template TEXT NOT NULL,
        identity_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','running','ready','failed','cancelled','waiting_input','cancel_pending','reconciliation_required')),
        generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation BETWEEN 0 AND 9007199254740991),
        revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991),
        lease_owner TEXT,
        lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR typeof(lease_expires_at) = 'integer' AND lease_expires_at BETWEEN 0 AND 9007199254740991),
        lease_acquired_at INTEGER CHECK (lease_acquired_at IS NULL OR typeof(lease_acquired_at) = 'integer' AND lease_acquired_at BETWEEN 0 AND 9007199254740991),
        created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
        updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN created_at AND 9007199254740991),
        CHECK ((generation = 0 AND lease_owner IS NULL AND lease_expires_at IS NULL AND lease_acquired_at IS NULL)
          OR (generation > 0 AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_acquired_at IS NOT NULL AND lease_expires_at > lease_acquired_at)),
        UNIQUE(scope_json, graph_run_id)
      );
      CREATE INDEX idx_graph_runs_scope_status ON graph_runs(scope_json, status, created_at, graph_run_id);
      CREATE INDEX idx_graph_runs_input_ref ON graph_runs(scope_json, input_artifact_ref);
      CREATE INDEX idx_graph_runs_source_parent ON graph_runs(scope_json, json_extract(source_json, '$.parentRunId'));
      CREATE INDEX idx_graph_runs_lease_expiry ON graph_runs(lease_expires_at) WHERE lease_owner IS NOT NULL;
      CREATE TABLE graph_requests (
        scope_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        graph_run_id TEXT NOT NULL,
        input_digest TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('start','resume','cancel')),
        created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
        PRIMARY KEY(scope_json, idempotency_key),
        FOREIGN KEY(scope_json, graph_run_id) REFERENCES graph_runs(scope_json, graph_run_id)
      );
      CREATE INDEX idx_graph_requests_run ON graph_requests(graph_run_id);
      CREATE TABLE graph_worker_leases (
        graph_run_id TEXT NOT NULL REFERENCES graph_runs(graph_run_id),
        generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation BETWEEN 1 AND 9007199254740991),
        owner TEXT NOT NULL,
        acquired_at INTEGER NOT NULL CHECK (typeof(acquired_at) = 'integer' AND acquired_at BETWEEN 0 AND 9007199254740991),
        expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at > acquired_at AND expires_at <= 9007199254740991),
        stopped_worker_json TEXT,
        PRIMARY KEY(graph_run_id, generation),
        CHECK ((generation = 1 AND stopped_worker_json IS NULL) OR (generation > 1 AND stopped_worker_json IS NOT NULL))
      );
      CREATE TRIGGER graph_runs_identity_immutable BEFORE UPDATE OF graph_run_id, scope_json, source_json, input_artifact_ref, template, identity_json, created_at ON graph_runs
        BEGIN SELECT RAISE(ABORT, 'graph run identity is immutable'); END;
      CREATE TRIGGER graph_runs_terminal_sealed BEFORE UPDATE ON graph_runs
        WHEN OLD.status IN ('ready','failed','cancelled')
        BEGIN SELECT RAISE(ABORT, 'terminal graph run is immutable'); END;
      CREATE TRIGGER graph_requests_no_update BEFORE UPDATE ON graph_requests
        BEGIN SELECT RAISE(ABORT, 'graph request is immutable'); END;
      CREATE TRIGGER graph_requests_no_delete BEFORE DELETE ON graph_requests
        BEGIN SELECT RAISE(ABORT, 'graph request is immutable'); END;
      CREATE TRIGGER graph_worker_leases_identity_immutable BEFORE UPDATE OF graph_run_id, generation, owner, acquired_at, stopped_worker_json ON graph_worker_leases
        BEGIN SELECT RAISE(ABORT, 'graph lease identity is immutable'); END;
      CREATE TRIGGER graph_worker_leases_no_delete BEFORE DELETE ON graph_worker_leases
        BEGIN SELECT RAISE(ABORT, 'graph lease history is immutable'); END;
    `,
  },
  {
    id: 26,
    name: "graph_action_ledger_and_original_budget",
    sql: `
      ALTER TABLE graph_runs ADD COLUMN spec_json TEXT;
      CREATE TRIGGER graph_runs_spec_immutable BEFORE UPDATE OF spec_json ON graph_runs
        BEGIN SELECT RAISE(ABORT, 'graph original spec is immutable'); END;
      CREATE TABLE graph_actions (
        effect_key TEXT PRIMARY KEY,
        graph_run_id TEXT NOT NULL REFERENCES graph_runs(graph_run_id),
        epoch INTEGER NOT NULL CHECK (typeof(epoch) = 'integer' AND epoch BETWEEN 0 AND 2),
        node_id TEXT NOT NULL,
        effect_slot TEXT NOT NULL,
        logical_attempt INTEGER NOT NULL CHECK (typeof(logical_attempt) = 'integer' AND logical_attempt BETWEEN 1 AND 9007199254740991),
        effect_json TEXT NOT NULL,
        action_json TEXT NOT NULL,
        business_digest TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation BETWEEN 1 AND 9007199254740991),
        reservation_tokens INTEGER NOT NULL CHECK (typeof(reservation_tokens) = 'integer' AND reservation_tokens BETWEEN 0 AND 9007199254740991),
        state TEXT NOT NULL CHECK (state IN ('intent','running','confirmed','failed','unknown','cancel_pending')),
        execution_ref TEXT,
        outcome_json TEXT,
        uncertainty_json TEXT,
        actual_tokens INTEGER CHECK (actual_tokens IS NULL OR (typeof(actual_tokens) = 'integer' AND actual_tokens BETWEEN 0 AND 9007199254740991)),
        observed_tokens INTEGER NOT NULL DEFAULT 0 CHECK (typeof(observed_tokens) = 'integer' AND observed_tokens BETWEEN 0 AND 9007199254740991),
        accounting_blocked INTEGER NOT NULL DEFAULT 0 CHECK (accounting_blocked IN (0,1)),
        retry_safe INTEGER NOT NULL DEFAULT 0 CHECK (retry_safe IN (0,1)),
        created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
        updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN created_at AND 9007199254740991),
        UNIQUE(graph_run_id, epoch, node_id, effect_slot, logical_attempt),
        CHECK ((state IN ('confirmed','failed')) = (outcome_json IS NOT NULL)),
        CHECK (retry_safe = 0 OR state = 'failed'),
        CHECK (actual_tokens IS NULL OR state IN ('confirmed','failed'))
      );
      CREATE INDEX idx_graph_actions_run_state ON graph_actions(graph_run_id, state);
      CREATE TRIGGER graph_actions_identity_immutable BEFORE UPDATE OF effect_key, graph_run_id, epoch, node_id,
        effect_slot, logical_attempt, effect_json, action_json, business_digest, generation, reservation_tokens, created_at ON graph_actions
        BEGIN SELECT RAISE(ABORT, 'graph action identity is immutable'); END;
      CREATE TRIGGER graph_actions_outcome_immutable BEFORE UPDATE ON graph_actions
        WHEN OLD.state IN ('confirmed','failed')
        BEGIN SELECT RAISE(ABORT, 'graph action outcome is immutable'); END;
      CREATE TRIGGER graph_actions_no_delete BEFORE DELETE ON graph_actions
        BEGIN SELECT RAISE(ABORT, 'graph action history is immutable'); END;
    `,
  },
  {
    id: 27,
    name: "graph_checkpoints",
    sql: `
      CREATE TABLE graph_checkpoints (
        graph_run_id TEXT NOT NULL REFERENCES graph_runs(graph_run_id),
        namespace TEXT NOT NULL CHECK (length(namespace) <= 1024),
        checkpoint_id TEXT NOT NULL CHECK (length(checkpoint_id) BETWEEN 1 AND 256),
        parent_checkpoint_id TEXT,
        checkpoint TEXT NOT NULL CHECK (length(CAST(checkpoint AS BLOB)) <= 1048576),
        metadata TEXT NOT NULL CHECK (length(CAST(metadata AS BLOB)) <= 1048576),
        new_versions TEXT NOT NULL CHECK (length(CAST(new_versions AS BLOB)) <= 1048576),
        PRIMARY KEY (graph_run_id, namespace, checkpoint_id)
      );
      CREATE INDEX idx_graph_checkpoints_page ON graph_checkpoints(graph_run_id, checkpoint_id DESC, namespace DESC);
      -- Pending writes can arrive before put; bind to the run, not a yet-absent checkpoint.
      CREATE TABLE graph_checkpoint_writes (
        graph_run_id TEXT NOT NULL REFERENCES graph_runs(graph_run_id),
        namespace TEXT NOT NULL CHECK (length(namespace) <= 1024),
        checkpoint_id TEXT NOT NULL CHECK (length(checkpoint_id) BETWEEN 1 AND 256),
        task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 256),
        write_index INTEGER NOT NULL CHECK (write_index BETWEEN -4 AND 4095),
        channel TEXT NOT NULL CHECK (length(channel) BETWEEN 1 AND 256),
        value TEXT NOT NULL CHECK (length(CAST(value AS BLOB)) <= 1048576),
        PRIMARY KEY (graph_run_id, namespace, checkpoint_id, task_id, write_index)
      );
      CREATE TABLE graph_checkpoint_requests (
        graph_run_id TEXT NOT NULL REFERENCES graph_runs(graph_run_id),
        request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 256),
        payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
        response_json TEXT NOT NULL CHECK (length(response_json) <= 1024),
        generation INTEGER NOT NULL CHECK (generation >= 1),
        PRIMARY KEY (graph_run_id, request_id)
      );
    `,
  },
  {
    id: 28,
    name: "graph_recovery_decisions",
    sql: `
      CREATE TABLE graph_recovery_decisions (
        graph_run_id TEXT NOT NULL REFERENCES graph_runs(graph_run_id),
        receipt_id TEXT NOT NULL,
        effect_key TEXT REFERENCES graph_actions(effect_key),
        interrupt_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        proof_json TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        committed_at INTEGER NOT NULL CHECK(committed_at >= 0 AND committed_at <= 9007199254740991),
        PRIMARY KEY(graph_run_id, receipt_id)
      );
      CREATE TRIGGER graph_recovery_decisions_no_update BEFORE UPDATE ON graph_recovery_decisions
        BEGIN SELECT RAISE(ABORT, 'graph recovery decision immutable'); END;
      CREATE TRIGGER graph_recovery_decisions_no_delete BEFORE DELETE ON graph_recovery_decisions
        BEGIN SELECT RAISE(ABORT, 'graph recovery decision immutable'); END;
    `,
  },
  {
    id: 29,
    name: "graph_worker_launches",
    sql: `
      CREATE TABLE graph_worker_launches (
        graph_run_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation >= 1 AND generation <= 9007199254740991),
        owner TEXT NOT NULL,
        identity_json TEXT NOT NULL,
        launched_at INTEGER NOT NULL CHECK(launched_at >= 0 AND launched_at <= 9007199254740991),
        PRIMARY KEY(graph_run_id, generation),
        FOREIGN KEY(graph_run_id, generation) REFERENCES graph_worker_leases(graph_run_id, generation)
      );
      CREATE TRIGGER graph_worker_launches_no_update BEFORE UPDATE ON graph_worker_launches
        BEGIN SELECT RAISE(ABORT, 'graph worker launch immutable'); END;
      CREATE TRIGGER graph_worker_launches_no_delete BEFORE DELETE ON graph_worker_launches
        BEGIN SELECT RAISE(ABORT, 'graph worker launch immutable'); END;
    `,
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.id;
