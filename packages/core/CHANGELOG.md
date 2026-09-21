# @osstack/core

## 0.17.0

### Minor Changes

- a007f58: Lazy-load heavy optional dependencies to cut CLI startup module-load cost from ~324ms to ~190ms.

  - `@osstack/agents`: the claude-code adapter now imports `@anthropic-ai/claude-agent-sdk` (grpc/opentelemetry/protobufjs tree, ~150ms) on first `query()` call instead of at module load. Import failures surface through the existing event contracts (`session.terminal failed` / `adapter_threw`), abort is re-checked after the import window, and a failed load is not memoized so later calls can retry.
  - `@osstack/core`: **BREAKING** — `initOtel()` changed from `void` to `Promise<void>`. The OTel NodeSDK/OTLP exporter modules (~100ms) now load lazily inside `initOtel()`, so consumers that never enable tracing skip the cost. Callers must `await initOtel(...)`; un-awaited calls compile-error under `@typescript-eslint/no-floating-promises` and would otherwise start tracing asynchronously (early spans dropped).
  - `@osstack/cli`: daemon startup awaits `initOtel(...)`.

## 0.16.0

### Minor Changes

- ad57096: Add governed, durable Codex and Claude session relay support with resumable native session identity, optimistic concurrency, idempotent inbound messages, bounded recovery diagnostics, and repository-context preservation.

## 0.15.0

### Patch Changes

- 0743a2a: Exclude compiled test and spec artifacts from npm tarballs, scan every packed workspace package for leaks, and verify release candidates against the real npm dependency graph.
- Updated dependencies [0743a2a]
  - @osstack/protocol@0.15.0

## 0.13.0

### Minor Changes

- 4fb11c0: Add project-allowlisted deployment, automatic rollback and freeze, and Mac Mini guarded-autonomy operations.
- b99bbfb: Add durable R0-R4 guarded autonomy and automated R1/R2 GitHub delivery,
  including exact-base candidate pinning, diff-bound R3 approval, SHA-bound
  merged-PR recovery, and fail-closed dependency/security validation.

### Patch Changes

- Updated dependencies [4fb11c0]
- Updated dependencies [b99bbfb]
  - @osstack/protocol@0.13.0

## Unreleased

### Minor Changes

- Add repository policy schema v2 plus append-only autonomy run, transition,
  approval, and decision persistence with deterministic restart replay.
- Add strict project deployment allowlists, durable deployment/freeze state,
  restart-safe autonomy projections, append-only rollback drills, and a
  redacted Owner notification outbox.

## 0.12.0

### Minor Changes

- 4a3dffd: Make knowledge-hygiene ReportV2 the default `neat check` contract, add honest
  coverage and assessment scope, evidence-bound semantic auditing, recoverable
  memory and narrative transactions, append-only V2 lifecycle history, and
  cross-repository dependency obligations with an isolated no-tools judge.
  Explicit `--schema-version 1` remains available for one minor release and now
  emits a deprecation warning.

## 0.11.0

### Minor Changes

- f041063: Add canonical portable probe ledgers, manifest-last repository rendering, artifact receipts, and destination attestations.
- a483f6e: Add transactional SQLite persistence for live probe sessions and command receipts.
- 4a6c00b: Add generic fail-closed kanban transition guards and register the probe readiness adapter at the CLI composition root before execution moves.
- 83aac82: Expose read-only probe portfolio summaries and include current open-item aging and required-item completion in daily briefs when probe sessions exist.

  Push repository filters into the SQLite projection queries so scoped daily and supervisor reads do not scan unrelated probe history.

- 223a240: Emit replayable probe metric facts, derive all section 10 outcome rates from append-only events with explicit legacy coverage, and surface baseline-only aggregation in supervisor reports.
- 9f1aa1b: Carry strict verifier-reported implementation deviations through Loop events and idempotently register evidence-bound `mid_build` probe items for linked tasks.

## 0.10.0

### Minor Changes

- 1b48a7d: Merge-orchestration closed loop (S1). A new `osstack stack` command family turns a
  stack of GitHub PRs into a driveable, self-reflecting workflow — extension-only over
  the existing kanban/loop/github/cli primitives.

  - `@osstack/core`: additive migration #7 — typed kanban cards (`card_type`, `meta`)
    plus a `kanban_card_checks` table; repository gains typed-card + checklist ops
    (`putCheck`/`setCheckState`/`listChecks`), dependency links, and deterministic
    bottom-up `topoOrder` (cycle throws). Existing kanban/event/memory semantics are
    backward-compatible (new columns default; event `kind` stays free-form).
  - `@osstack/github`: `stack.ts` — `ingestStack` (read-only `gh pr view` → dependency
    DAG) and `detectDrift` (conflicting/ci_failing/ci_pending/not_mergeable/orphan_base).
  - `@osstack/loop`: pure `renderStackRetro` — a retrospective that cites which checks
    caught issues and derives missing-gate suggestions.
  - `@osstack/cli`: `stack ingest|board|move|check|timeline|runbook|recommend|retro`,
    memory-backed routing recommendation, and an offline dry-run fixture.

  S1 records and drives; humans still merge. No auto-merge, no auto-agent-dispatch, no
  CI webhook/daemon.

- daeb3c4: Add the additive knowledge-hygiene history migration and core-owned repository
  APIs. Persist report identity and normalized run/finding/occurrence/resolution
  events without report blobs, with idempotent cross-connection recording,
  recurrence tracking, and complete-report-only absence closure.
- 7396e6f: Complete the opt-in neat R4 workflow. Record exact finding confidence, query
  append-only history for configurable repeated high-confidence candidates, and
  preserve pre-R4 history as automation-ineligible `unknown`. Add the optional
  non-gating `loop run --neat-finalize` evidence attachment and preview-first
  `neat propose`; only `--yes` under an authorizing policy persists stable,
  evidence-backed, high-risk drafts, with no automatic hook or policy change.
- 6a4a9d4: Policy Profile loader + `osstack policy check` + observe-mode gate (R1.3,
  POLICY_PROFILE_V1). The human-owned, git-tracked contract that bounds what
  osstack may do in a repository, enforced by the kernel — not by prompt text.

  - `@osstack/core`: `packages/core/src/policy/profile.ts` — fail-closed Zod
    schemas for `.osstack/repo.yaml` (`RepoConfig`) and `.osstack/policy.yaml`
    (`PolicyProfile`), `.strict()` at every nesting level, the closed 13-category
    vocabulary (P-005), and cross-list disjointness via `superRefine` (P-003).
    `loadRepoConfig` / `loadPolicyProfile` return `undefined` for an absent file
    (legacy mode) and throw with the file path + issue list for a present-but-
    invalid file (P-001). `profileBudgetToLoopBudget` maps budgets onto the loop
    budget primitives per the P-003 table (minutes ×60000) without importing
    `@osstack/loop`. Adds the `yaml` dependency (already used by cli/config).
  - `@osstack/cli`: new read-only `osstack policy check [--repo-path P] [--json]`
    validates both files and prints mode/budgets/category lists or the precise
    errors (exit 0 valid or both absent; exit 1 invalid). First enforcement point:
    `deliver` and `loop run` consult the workspace profile after workspace
    resolution — `mode: observe` refuses execution (exit 2) before any
    worktree/task work; `propose`/`execute`/absent behave exactly as before; an
    invalid policy file fails closed (exit 1).

  No behavior change when policy files are absent. Finer-grained
  `allowed_auto_changes` / auto-apply wiring is deferred to a later increment.

- 3223420: Adopt `@osstack/protocol` additively (R1.2). Both packages now re-export the
  kernel contracts under a `protocol` namespace (`export * as protocol`) and ship
  pure, tested mappers from their own shapes to the protocol shapes — no breaking
  changes, no consumer forced to switch. core adds `storedEventToEnvelope`,
  `runRowToRunSummary` (finalized rows only; `expired` -> `failed`), and
  `approvalRowToRequest`; loop adds `toProtocolTask` and
  `completedTaskToRunSummary` (`escalated` -> `cancelled`).
- 392f8b0: R1.5 — contract-gated `osstack start` / `osstack control` lifecycle. v1 owns the
  contract lifecycle + approval records only; it never spawns delivery.

  - `@osstack/core`: new `contract_approvals` (authoritative current lifecycle
    state: pending/approved/revising/stopped) + `contract_approval_decisions`
    (append-only approve/revise/stop history) tables (migration #8), the
    repository (`insertContractApproval` / `getContractApprovalByContract` /
    `getContractApproval` / `recordContractDecision` / `listContractDecisions`)
    and protocol mappers (`contractApprovalRowToRequest` /
    `contractApprovalRowToDecision`). DEDICATED tables, not the run-coupled
    `approvals` table, because a contract has no run at approval time.
  - `@osstack/cli`: new `start` and `control` commands.
    - `osstack start "<goal>" --repo-id <id> [--risk R] [--json]` requires the repo
      registered + a valid `.osstack/repo.yaml`; `mode: observe` is refused
      (policy_denied, exit 2), an invalid policy fails closed (exit 1). Records the
      contract atomically (kanban card + pending approval in one transaction),
      then writes the Execution Contract markdown to a git-tracked path in the
      target repo (`.osstack/contracts/<id>.md` — review the TBDs and commit it).
      `--json` emits a strict protocol `AgentCommandResult` with status
      `needs_approval`, an `ApprovalRequest`, and the exact `control approve`
      invocation as `next_actions[0]`.
    - `osstack control <contract-id> status|approve|revise|stop [--json]`.
      The approval row is authoritative; the kanban card is a best-effort
      projection (a failed card move degrades to a warning, never a crash).
      `approve` records a protocol `ApprovalDecision` (human actors only — an
      agent actor is refused as policy_denied per A-004) and emits the
      ready-to-run `osstack deliver …` command, POSIX-single-quoted so hostile
      goal text cannot execute on paste, plus a raw `deliver_args` argv array for
      agent consumers — it does NOT spawn delivery. `revise`/`stop` update status
      with a `--reason`; `status` renders the contract + the full append-only
      approval trail.

- 99ca3b4: State repositories relocated to core; CLI store becomes a compat shim.

  R1.1 (ADR-001 §D2): the run/task/event persistence moved from
  `packages/cli/src/store.ts` into `@osstack/core`
  (`packages/core/src/state/run-store.ts`). `@osstack/core` now owns and exports the
  four writers (`insertTask`, `insertRun`, `appendEvent`, `finalizeRun`) plus the
  readers consolidated from the CLI's raw-SQL sites (`getRun`, `listEventsForRun`,
  `countRuns`, `countRunsSince`, `countEvents`, `countPendingTasks`). An external
  consumer can now read run/event state through the kernel without the
  product-private CLI. `packages/cli/src/store.ts` is now a deprecated compat
  re-export shim (import from `@osstack/core` instead). Ownership relocation only —
  no DB behavior or schema change.

### Patch Changes

- Updated dependencies [12b6796]
  - @osstack/protocol@0.10.0

## 0.2.0

### Minor Changes

- Ship the osstack upgrade evidence, governance, compliance, Knowledge Cloud, cockpit, and product companion surfaces.

  - Add official Knowledge Cloud packs, indexing, ingest, cloud service, Docker/Fly/Render deployment assets, and smoke tests.
  - Add governed delivery, proof/report/scorecard/compliance evidence, PR bodies, and product companion specs.
  - Expand loop evidence, knowledge traces, cockpit reporting, checkpointing, and npm install smoke coverage.

## 0.1.0

### Minor Changes

- 45b3b78: Initial public release (0.1.0): engineering hardening + self-update.

  - Version is read from package.json instead of hardcoded `0.0.0`; daemon and
    CLI exchange `protocol_version` on connect.
  - `osstack upgrade` self-update command: registry check → state.db backup →
    daemon drain/shutdown → `npm i -g` → restart → health check → automatic
    rollback on failure. `osstack status` shows the version handshake and
    update availability.
  - Daemon probes the npm registry once per 24h (disable: OSSTACK_UPDATE_CHECK=0)
    and surfaces `update_available` in `health`.
  - Daemon pidfile guard refuses duplicate instances; socket moved from
    /tmp/osstack.sock to ~/.osstack/daemon.sock.
  - Hermes binary resolution no longer hardcodes a machine-specific path
    (use HERMES_BIN or HERMES_AGENT_HOME).
  - launchd templates: ai.osstack.autoupgrade weekly self-update job.
  - Biome linting, GitHub Actions CI, daemon RPC smoke tests.
