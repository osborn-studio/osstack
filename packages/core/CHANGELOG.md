# @osstack/core

## 0.24.0

### Minor Changes

- 4845be0: Add signed live revision grants for the Grok bridge (phase 5-A, migration 53). `osstack mission grant-revisions --mission ROOT` (or `--chain CHAIN` to extend one) needs an interactive terminal on stdin and stderr, shows the exact grant the daemon previewed (repository, PR, head, base, scope, principal, rounds, expiry, budget), requires typing `GRANT <preview digest>`, and only then reads the host-private Ed25519 issuer key (`bridge/revision-issuer-<key>.pem`, mode 0600) and signs; the daemon only verifies the signature against `bridge/revision-issuer.json`, so a process that merely holds the RPC credential cannot grant. Defaults follow the owner decision: 1 round (`--rounds 2` explicit, 2 is the cap), valid 24 hours (at most 7 days), review deadline 24 hours reset after each confirmed push, budget 3600 s executor, 3600 s container, 48 h wall clock. The daemon re-reads the live PR before issuing (open, authored by the registered publisher, published head and base) and re-checks every fact when the signed grant arrives; nonces are single use and last 60 seconds. `osstack mission chain-decide --chain RC --decision abandon|takeover|reconcile` closes a live chain (voiding its reservation and asking for the running child to be cancelled) and needs no terminal; `reconcile` is reported as unavailable until the receipt reader lands. `osstack mission grant-keygen --key ID` creates the issuer key pair on the host. Migration 53 adds two triggers and one unique index (at most one pending push intent per chain): a live chain's grant may be replaced only upward and never rebound to another Mission, PR, repository or scope, and a shadow chain's grant is fixed. Core gains the grant schema and signing helpers, `RevisionChainStore.replaceGrant`/`stopLive`/`closeLive`/`transaction`, and a budget origin in `budget_json`; the CLI gains `assertGrantLive`/`enforceGrantLive` for the dispatch and push fences of later phases and a live-chain grant summary (no signature, digest, nonce or identities) in `mission status --json`. The grant RPC methods answer `bridge_live_disabled` and `OSSTACK_BRIDGE=1` is still refused with `BRIDGE_LIVE_NOT_IMPLEMENTED`: nothing is dispatched or pushed yet. The upgrade gate now requires both grant triggers on schema 53 homes and refuses older homes that already carry them.
- 0329eb8: Add the App E shadow-merger core for the Grok bridge (migration 52): a per-PR observation fence (`issued_seq`/`accepted_seq`, DB-issued numbers instead of wall-clock ordering, so a late stale observation is refused even after a deduplicated one), an append-only decision change sequence, outcome segments (`closed_unmerged` may go straight to `merged`; nothing is accepted after a merge), a cycle table, a `MergerShadowStore` whose writer surface is three methods, and the pure `evaluateMergeGates` (gates G0–G8 incl. G4b, every failing code returned, `unevaluated` for incomplete reads) with the two open owner decisions exposed as typed options defaulting to the strict choice. The CLI only raises its schema gates (`ATTENTION_READ_QUALIFIED_SCHEMA`, `UPGRADE_QUALIFIED_SCHEMA`) to 52 and requires the four new tables before an upgrade; nothing reads or writes them yet.
- cafadc1: Add the revision-chain ledger for the Grok bridge (migration 51): chains, per-head reservations, publication intents, an append-only chain event trail and shadow decisions, with database-level guards (one reservation per head, one in-flight reservation per chain, per-mode grant checks, shadow chains refused any reservation or intent) plus a pure `decideChainStep` state machine and a `RevisionChainStore` whose shadow surface (`shadowChainWriter`) cannot reach the live reservation APIs. The CLI only raises its schema gates (`ATTENTION_READ_QUALIFIED_SCHEMA`, `UPGRADE_QUALIFIED_SCHEMA`) to 51 and counts in-flight reservations and unsettled intents as upgrade holds; nothing reads or writes the new tables yet.
- ccef9bb: Add the same-PR revision child Mission for the Grok bridge (phase 5-B). A live chain can now reserve a round, create a child Mission on a new local branch `osstack/mission/<id>` starting at the chain's published head, and dispatch it in one `BEGIN IMMEDIATE` transaction (all PR reads, feedback extraction and grant, budget and protected-set checks happen before it, so a crash leaves exactly one child with its reservation, or nothing). The child inherits the root's goal, repository, allowed paths, caps, verify command, verification paths and publication terms field by field; `publish_target` and `revision_feedback` exist only on specs the dispatcher builds (`mission.start` cannot carry them). Reviewer text reaches the executor only inside a nonce-delimited block framed as untrusted data, redacted, stripped of control and bidi characters and bounded, and in repair turns as well; it cannot change allowed paths, verify or the protected set. A revision child's diff is also classified from the root's start commit, so a within-caps root cannot be pushed over its caps by revisions. Budget is charged per launch (`chargeLaunch`: executor turns and verifications), refunded down to actual time, held per child, and topped up on a budget re-grant by exactly the raise; `mission decide resume_budget|resume_grant` re-enters the launch that was stopped, and a halted Mission may re-enter `candidate_ready` only as the same candidate. `ports.publish` refuses any spec with a `publish_target`, and the runner stops a revision child at `delivering` before any publish port runs: nothing can be pushed or opened yet (the revision publisher is 5-C), and `OSSTACK_BRIDGE=1` is still refused.
- 32726b6: Close the two open Codex round-2 P2 findings of the shadow merger (App E M-C) with migration 55 (`engineering_merger_scans`), additive: one table (`engineering_merger_shadow_scans`), three nullable columns (`scan_id` on cycles and outcomes, `last_poll_at` on watermarks), a partial unique index and five triggers; no rebuild of migration 52's tables.

  - Each scan now takes a database-issued scan id (`MergerShadowStore.beginScan`, committed before the scan's first observation). Its cycle row and every outcome it records carry that id, new cycle and outcome rows must name an existing scan (`merger_unknown_scan`), and one scan writes at most one cycle. The comparison report resolves "the detecting scan" by that id instead of the `cycle_after` stamp (the newest cycle when the scan began), so two overlapping processes can no longer attribute an outcome to the other's scan. `recordCycle` takes the scan id first and `MergerOutcomeInput` requires `scan_id`; outcomes written before 55 keep the `cycle_after` path.
  - The per-PR poll marker `last_poll_at` is written in the same statement that issues the observation number and only moves forward (`merger_poll_regressed`). The reconciler computes the next hourly closed-PR poll from it (`MergerLedgerView.lastPollAt`), so a restart no longer postpones polling by up to an hour; a PR without a marker still waits one full gap.

  The native-upgrade gate and the attention read gate are qualified for schema 55; the upgrade gate additionally requires the scan table, the index, the five triggers and the three columns at 55 and refuses a pre-55 home that already has any of them. Observation fence and ticket semantics are unchanged.

- 8dc4976: Add the W13-A host child-process ledger as migration 54 (`engineering_host_processes`): partial unique indexes (one open record per Mission and per remote branch), insert-shape and insert-gate triggers, and triggers that refuse workspace-claim release, `cancelled`, `pr_opened` and clearing `stop_obligation` while any record is not proven stopped. `HostProcessStore` exports the `launching`/`registered`/`release`/`stopped` journal the gated launcher writes through (durable top-level transactions, `host_process_nested_transaction` otherwise), recovery queries, and `settleStopped`, which clears the stop obligation and leaves `stop_unknown` in one owner transaction. `containedUpgradeHolds` now also counts every open record directly. The attention read gate is qualified for schema 54; the native-upgrade gate is too, and additionally requires the table and all fourteen triggers at schema 54 (a pre-54 home that already has them is refused).

### Patch Changes

- fb32543: Add the read-only PR reader for the Grok bridge shadow reconciler (phase 4-C): a `gh api graphql` transport that refuses mutations, a complete paginated pull-request read (reviews, threads with nested comment paging, commits, timeline) that reports `complete: false` on caps or errors, `normalizeSnapshot` to the body-free `PrSnapshot`, a second-read move check, a host-private `producers.json` registry loader, and `scripts/record-pr-timeline.mjs` with a de-identifying fixture recorder plus the recorded #340-#363 decision corpus. `PrSnapshot` gains an optional `observed_at`. Nothing is wired into the CLI or daemon yet; the new modules are not imported eagerly.
- 8f5d406: Add revision push receipt, refusal, and confirmation contracts for the same-PR bridge path.

  Deferred to 5-D/5-E: receipt reconciliation proof and landed recovery (finding 5), cancellation requests on refusal (finding 9), and the release-time grant/child/chain recheck integration (finding 10).

- 64013bc: Add the Grok bridge shadow reconciler (phase 4-D). With `OSSTACK_BRIDGE=shadow` and a host-private `$OSSTACK_HOME/bridge/producers.json`, the contained-Mission service observes `pr_opened` Mission PRs read-only (host `gh` credentials, query documents only) and records what the bridge would do as shadow revision-chain events and decisions: a chain per Mission PR on first sight, a scan every five minutes over at most ten open chains, a second read before `would_reserve` / `would_mark_ready`, and fixed-code `read_failed` events. It never uses App credentials, never writes the Mission ledger and is never awaited on the Mission tick. `OSSTACK_BRIDGE` unset or `0` is off, `shadow` without `producers.json` is off with a log line, `1` fails the service start with `BRIDGE_LIVE_NOT_IMPLEMENTED` and any other value with `BRIDGE_MODE_INVALID`. `osstack mission status --json` gains a `chain` field (shadow chain state, stop reason, published head and latest shadow decisions; `null` when none). The PR reader now also fetches the PR author for discovery. Core gains read-only lookups: `ContainedMissionStore.listPrOpened`, `RevisionChainStore.chainForMission` / `chainForPr` and the matching `ShadowChainWriter` members.
- 203df2d: Stop a live revision chain when the PR base changes while a pending push head is visible.
- 4827af6: Close the live-path gaps the bridge TLA+ model found in the revision-chain store: an uncertain push receipt stops any chain that is not already stopped or closed, a failed push receipt stops an in-flight round, a stopped chain cannot resume while a push receipt is pending or uncertain, at most one push intent is pending per chain, a new head is accepted only from the confirmed intent that extends the published head, decisions are whitelisted per source state, a confirmed push settles its reservation once the child is terminal, and reserve, dispatch and push-intent writes check the live grant's expiry against an injected clock. `RevisionChainStore` gains an optional clock argument and `nextConfirmedPushHead`.
- 49d9a17: Contained Mission local git writes (`update-ref`, `worktree add`, real-index `read-tree` and `update-index --refresh`) now run through the gated host-process launcher and its ledger: registered before they can write, released only after the Mission fence passes, and proven stopped afterwards. Restart recovery proves each open record stopped by observation only (it never signals a process); a record it cannot prove puts the Mission in `stop_unknown` and keeps the workspace claim, cancel and obligation clear closed. An interrupted workspace creation ends in `awaiting_decision` (`workspace_recovered`), and the new `resume_workspace` decision verifies and re-materializes it. Stale `index.lock` files left by a killed writer are removed after the proof. The periodic re-check is available as an opt-in host option and is off by default.

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
