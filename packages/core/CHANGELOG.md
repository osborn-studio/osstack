# @osstack/core

## 0.23.0

### Minor Changes

- 95534c7: Add opt-in reminders for overdue open Attention decisions (migration 48). With `OSSTACK_ATTENTION_REMINDERS=1`, supervision queues at most one reminder per pass for the oldest decision left open past `OSSTACK_ATTENTION_REMINDER_OVERDUE_SECS` (default 1800), repeating with doubling intervals capped at `OSSTACK_ATTENTION_REMINDER_BACKOFF_MAX_SECS` (default 14400). Schedules survive restarts, quiet scopes neither schedule nor reset, and resolving a decision stops its reminders. Reminders reuse the local notification drain under their own delivery IDs and grant no authority. Invalid enabled settings refuse daemon startup. Managed upgrade and the read-only Attention status view now qualify schema 48.
- 12de1f7: Add the Attention return brief (migration 49). Postures now record when they were entered; re-asserting the current posture keeps its start. Leaving `away` for `attended` (`attention.posture` / `osstack attention posture`) returns a bounded, read-only brief for the away interval: every decision still waiting on you (oldest first, with age and reminder count, always with total and omitted counts), decisions opened and resolved while away, and first notices or reminders that dead-lettered in the interval (plus undated pre-49 dead letters). `osstack attention return-brief --scope ID --actor NAME [--since MS] [--limit N]` previews it without changing posture. Decision settlements and dead letters are recorded with their time in two new local ledgers. The brief is information only and grants no authority. Managed upgrade and the read-only Attention status view now qualify schema 49.
- eb35fbb: Add a bounded behavior registry evaluator for caller-supplied build pins, clock, policy and trust context. It checks source membership, qualification signatures, evidence and dependencies relative to those inputs. It does not authenticate the trust context, verify the operations-root signature, persist a revocation epoch or grant execution authority. It is not wired into daemon routing.
- 5b3400e: Add migration 50 with an additive contained-Mission ledger: Missions, append-only events and workspace claims, behind a `ContainedMissionStore` that enforces the W11 state machine, candidate binding, repair-cycle limits and stop evidence. Managed upgrade and the attention read model qualify schema 50, and in-flight contained work counts as an upgrade hold.
- 7939a10: Add schema 47 Mission and Wait storage, atomic answer reservations, cancellation proofs, and conservative recovery. Existing attention actions remain the sole dispatch authority.

### Patch Changes

- 85e19da: Reject unknown behavior trust and policy fields, cache failed artifact reads and manifest parses, and normalize malformed context echoes. Preserve the frozen Behavior V1 signing format while keeping corrupt data within the evidence work budget.
- 0d9dca7: Add the contained Mission runner. It advances one step at a time from workspace creation through qualification, a proxy executor turn, patch classification, exact host-side patch application and plumbing commit, to verification and repair cycles. Every executor channel is secret-scanned and redacted before anything is recorded, and decisions follow the W11 decision table.

  Patch changes to the runner, patch applier, mission RPC and CLI now escalate to T2 in the Mission patch classifier.

  The contained ledger now opens a stop obligation on entering `verifying` and requires container stop evidence before a verification result is recorded.

- b5f2f93: Keep adopted Session identity faults fenced after cleared waits and source restoration. Prevent daemon drain from reporting success while execution leases remain held after asynchronous or failed cleanup.
- Updated dependencies [1372ecd]
- Updated dependencies [936aced]
- Updated dependencies [2f9d33a]
- Updated dependencies [13bfb45]
  - @osstack/protocol@0.23.0

## 0.22.0

### Minor Changes

- 0a61d27: Add scoped read-only attention snapshots and opt-in persistent decision observation, guarded manual answers, delivery receipts, explicit foreground handoff, and local notification artifacts. Add bounded Loop/CI observation and offline planning helpers. The observer makes no model calls and confers no execution or approval authority.

  Daemon ownership now uses a fixed-file native exclusive lock before startup side effects. Interrupted Loop/daily sessions require explicit recovery; startup and loop cycles preserve unknown worktrees. Ambiguous or failed session instructions are no longer automatically replayed; an explicit, recorded owner disposition is available without claiming their effects succeeded. SQLite migrations 40–41 add the independent attention records.

- c8dc83f: Complete Firstmate adoption entry points for bounded scout promotion, evidence-backed lesson drafts, multi-check Graph contracts, source generation/event ledgers and explicitly approved context, paired model evaluation, private worker observers, independently authorized remote Graph cancellation, GitHub follow-up delivery, and managed multi-home upgrade recovery. Keep external provider, terminal backend, SSH and service-manager qualification explicit and disabled without host authority.
- c129a31: Bind explicitly requested V2 delivery to frozen scope, host verification receipts, and requested completion boundaries. Add pinned local prompt context with byte budgets and adapter-boundary receipts, evidence-backed investigation drafts, and explicit read-only local deployment identity inventory. Legacy execution remains available; these additions do not imply remote, publication or deployment qualification.
- c48e29a: Add bounded read-only worker viewing, pinned local-source inspection, signed single-attempt follow-up delivery ledgers, and explicit multi-home upgrade planning/status. External delivery adapters and native shared-installation upgrade execution require separate host qualification and are not enabled by default.
- 3d5fdc0: Add bounded persistent run-event projection, isolate approval/clarification resolution echoes, and expose scoped worker state views plus read-only Attention summaries in manual and scheduled daily briefs. Migrate the control-plane database incrementally to schema 42 without rewriting historical migrations.
- 7e5a84d: Bind Graph delivery to frozen host contracts and context evidence, add pinned SSH read-only worker observation, and expose bounded cooperative supervision with scoped recovery diagnostics.
- 63064cd: Add explicitly enabled advisory triage with persistent budgets and unresolved-stop quarantine, and a scoped local follow-up ledger with immutable evidence, unsent drafts and source-condition resolution. Connect actual CLI and daemon entrypoints without granting external delivery or source execution authority.
- b185daa: Integrate scoped Attention summaries into the main cockpit, bound supervision and local notification work, and add deterministic routing qualification against the actual routing entrypoints.

### Patch Changes

- 1d945a4: Stop attention delivery batches when their budget timer expires, even if the monotonic clock has not reached the nominal deadline. Keep the shorter per-send timeout distinct so longer batches can continue within their remaining budget.

- Updated dependencies [0a61d27]
- Updated dependencies [c129a31]
- Updated dependencies [c48e29a]
- Updated dependencies [7e5a84d]
- Updated dependencies [63064cd]
  - @osstack/protocol@0.22.0

## 0.21.0

### Minor Changes

- 1fa74af: Add experimental bounded changeset proposal, durable invocation/apply evidence, guarded multifile application, and apply-bound artifact freezing. Preserve historical Graph v4 compiler resolution and include complete cumulative and incremental review inputs. Add canonical writer guard capabilities with retained admission on uncertainty. Production changeset executor registration remains disabled pending lifecycle and reviewer integration.

## 0.20.0

### Minor Changes

- 1263519: Add trusted local `improve deliver`: one preview confirmation approves a draft proposal, builds and reviews a candidate, replays the saved patch in a clean checkout, verifies it again, and creates a draft GitHub PR. Persist delivery intents, exact commit bindings, cooperative stops and read-only reconciliation in schema 27. PR verification replaces ambient environment inheritance; existing verifier callers keep their defaults. Uncertain writes are never retried automatically. This does not enable daemon delegation, merge, release or hostile-worker isolation.
- 29a3a17: Execute digest-approved low-risk improvement proposals in a retained candidate worktree with independent structured review, exact file boundaries, replay-safe execution records, and hashed evidence. Candidate verification does not mark a proposal applied or prove effectiveness. Add strict Codex completion and per-run execution environment support.
- 5a82b1c: Add signed, finite phase continuation for the controlled no-tools planning/review
  session runtime. Bind frozen output checks and instructions to the exact session,
  runtime policy, owner key, initial turn/version, deadlines and cumulative budgets.

  Migration 24 persists grants and attempts alongside existing session receipts.
  Revoke stops subsequent actions; crash recovery never automatically resends an
  uncertain accepted delivery. Add collaborator inspect/draft/sign/install/status/revoke
  commands. This does not grant code execution, GitHub approval, merge or deployment
  powers to unrestricted agent sessions.

- f4de18d: Bind new candidate executions to worker identities and fence controlled writes after a durable stop request. Add `improve stop` and a complete `improve baseline` export. Indeterminate execution outcomes retain active occupancy instead of allowing an unsafe retry.

  Core clients must pass the worker returned by `claim` to `recordWorktree` and `complete` for new executions. Pre-migration unowned records remain readable. Schema 26 requires a backed-up, coordinated upgrade; stopping is cooperative and does not attest to OS process termination or enable recovery.

### Patch Changes

- 071c1ff: Add versioned session continuation requests and durable waiting diagnostics.
  Parsing an agent-reported request does not authorize automatic continuation.
  Track resumed sessions during daemon drain and
  cancellation, and preserve uncertain delivery receipts in status output.

  Keep improvement proposal identities and reviewed history stable. Gate-only checks
  no longer claim that a candidate was applied. Migration 23 preserves legacy lesson
  counters and records explicit failure observations without claiming effectiveness.

- f4c55ec: Align npm package repository metadata and Trusted Publisher tooling with the transferred osborn-studio/osstack repository. Existing mismatched trust mappings still require explicit operator review.
- 9f17623: Avoid false Graph worker heartbeat expiry after host event-loop stalls, preserve proven cleanup for rejected admission, and reconcile the exact legacy v4 preparation cancellation through independently checked worker-exit, workspace and lock-absence evidence. Preserve all original action outcomes and never replay effects or unlink replacement locks. Install the macOS daemon with the responsive process class used by the verified deployment.
- 9011913: Complete the controlled internal executable Graph beta: preserve reconciliation-only repository locks across legacy acquisition, block upgrades while graph execution remains unresolved, and explicitly reject unsupported Node/Bun graph runtimes. Batch raw Git artifact capture and restoration with independent content and protocol limits so real repository delivery completes within its existing deadline.

  Add compatibility, fault, runtime and performance verification, plus a real internal provider pilot and operations guide. Unknown external effects retain their lock and budget reservation; ready produces a candidate artifact without merging or deploying it.

- 4a2646c: Preserve completed Git identity-query output when the daemon event loop stalls, while keeping bounded output and termination of hung queries. Reuse the guarded queries for repository policy checks and add macOS canonical-path regression coverage before merge.
- Updated dependencies [071c1ff]
- Updated dependencies [f4c55ec]
- Updated dependencies [c1f4619]
- Updated dependencies [9011913]
- Updated dependencies [5a82b1c]
  - @osstack/protocol@0.20.0

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
