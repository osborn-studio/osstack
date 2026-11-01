# @osstack/cli

## 0.23.0

### Minor Changes

- 95534c7: Add opt-in reminders for overdue open Attention decisions (migration 48). With `OSSTACK_ATTENTION_REMINDERS=1`, supervision queues at most one reminder per pass for the oldest decision left open past `OSSTACK_ATTENTION_REMINDER_OVERDUE_SECS` (default 1800), repeating with doubling intervals capped at `OSSTACK_ATTENTION_REMINDER_BACKOFF_MAX_SECS` (default 14400). Schedules survive restarts, quiet scopes neither schedule nor reset, and resolving a decision stops its reminders. Reminders reuse the local notification drain under their own delivery IDs and grant no authority. Invalid enabled settings refuse daemon startup. Managed upgrade and the read-only Attention status view now qualify schema 48.
- 12de1f7: Add the Attention return brief (migration 49). Postures now record when they were entered; re-asserting the current posture keeps its start. Leaving `away` for `attended` (`attention.posture` / `osstack attention posture`) returns a bounded, read-only brief for the away interval: every decision still waiting on you (oldest first, with age and reminder count, always with total and omitted counts), decisions opened and resolved while away, and first notices or reminders that dead-lettered in the interval (plus undated pre-49 dead letters). `osstack attention return-brief --scope ID --actor NAME [--since MS] [--limit N]` previews it without changing posture. Decision settlements and dead letters are recorded with their time in two new local ledgers. The brief is information only and grants no authority. Managed upgrade and the read-only Attention status view now qualify schema 49.
- f740da8: **Behavior change — Loop no longer lands isolated-worktree work locally by default (D7), and never loses executor-made commits (D6).**

  - `osstack loop run --worktree` and `osstack deliver --worktree` used to fast-forward whatever branch the main checkout had checked out after a successful task. They now commit the verified tree on the kept `osstack/loop/...` task branch and report it (`loop.worktree.preserved`, reason `local_landing_disabled`; `worktree_commit` and `worktree_branch_preserved: true` in the completed task). Nothing in the main checkout changes, which keeps unattended/factory runs on controlled PR delivery (humans merge main).
  - Local landing is an explicit, attended opt-in: `--land-branch <B>` (requires `--worktree`; `deliver` only with `--autonomy legacy`) or `LoopRunOptions.localLanding = { targetBranch }`. It lands only the accepted commit and is refused unless the main checkout has `<B>` checked out. Daemon-managed loops (`loop start`, `loop run --daemon`) do not offer it. A `CandidatePolicy` implies its own `branch` as the target. To keep the old behavior, add `--land-branch <current branch>`.
  - `--govern` combined with `--worktree` now requires `--land-branch`, because legacy governance scans the main checkout and would otherwise pass without seeing the candidate.
  - `mergeWorktree(handle, { expectedCommit, targetBranch })` now requires both options and also refuses when the accepted commit is not the single commit on top of the worktree's recorded start.
  - `createWorktree` records `startCommit`. When the executor ran `git commit` itself, `commitWorktreeChanges` reports `executorCommitted` (with the branch tip as `commit` on a clean tree); the Loop preserves that branch (reason `executor_commits`) and refuses to land it, because review evidence was collected against the worktree HEAD. `cleanupWorktree` returns `{ branchRemoved }` and never deletes a branch whose tip is not the start commit or already contained in HEAD or another ref, including during orphan cleanup.
  - Reports and proof packs accept the new `preserved` worktree status (a commit is required).
  - `--goal` combined with `--worktree` (and `LoopRunOptions.goalCommand` with `useWorktree`) now requires local landing (`WORKTREE_GOAL_REQUIRES_LOCAL_LANDING`), because the goal command runs in the main checkout and would never observe work kept on the task branch. Daemon-managed `loop start --worktree --goal` sessions are refused for the same reason.

- bdab376: Expose seven engineering subcommands for adopting, observing, answering, deferring, cancelling and reconciling existing waiting Sessions.
- a7c4b85: Add opt-in host-authenticated Session adoption RPC, first-dispatch recovery and independent stop handling. Preserve committed unknown receipts without automatic replay.

### Patch Changes

- 71240d3: Stop a superseded Attention supervision service as soon as it sees that a newer owner generation claimed the home. Its writes were already fenced; it now also clears its timer and aborts in-flight source reads and notification sends instead of polling until daemon shutdown, and later Attention RPCs report `stale_owner`. Write-lock contention and transient faults are not treated as a take-over.
- d7d0068: The daemon now reports an Attention supervision service that a newer owner took over as `unavailable` (dashboard, daily, `health`) instead of `running`, and `osstack stats` gains an `attention` field with the take-over flag and the count and last message of errors a supervision pass swallowed.
- 0e9d9d6: Add `osstack mission start|status|cancel|decide` and the daemon `mission.*` RPC for contained Missions. Both are opt-in through `OSSTACK_CONTAINED_MISSIONS=1` together with the engineering host, and authenticated by the engineering authority file. The daemon recovers orphaned Missions at start and then advances them on its own tick. Nothing is merged or published.
- bedbb18: Add the contained Mission host (W11 M6b): real ports over the hardened git runner, the Codex proxy and contained verification; a bounded `tick` that never steps one Mission twice; restart recovery for orphaned executor turns and verifications; and the `discard_changes`, `adopt_worktree` and `retry_stop_check` decisions.
- 5b3400e: Add migration 50 with an additive contained-Mission ledger: Missions, append-only events and workspace claims, behind a `ContainedMissionStore` that enforces the W11 state machine, candidate binding, repair-cycle limits and stop evidence. Managed upgrade and the attention read model qualify schema 50, and in-flight contained work counts as an upgrade hold.
- bef1c06: Contained Missions can now open their PR: after approval (or a pre-authorized grant in the spec), the host re-validates the verified candidate, issues a single-use publication permit, and opens the PR through a fenced delivery runner. The runner journals each push and PR creation under the owner fence, re-checks the permit before each one, disables git hooks and refuses PR-changing gh commands. Authoritative delivery evidence is recorded before `pr_opened`. Nothing is ever merged.
- 0d9dca7: Add the contained Mission runner. It advances one step at a time from workspace creation through qualification, a proxy executor turn, patch classification, exact host-side patch application and plumbing commit, to verification and repair cycles. Every executor channel is secret-scanned and redacted before anything is recorded, and decisions follow the W11 decision table.

  Patch changes to the runner, patch applier, mission RPC and CLI now escalate to T2 in the Mission patch classifier.

  The contained ledger now opens a stop obligation on entering `verifying` and requires container stop evidence before a verification result is recorded.

- 6a3e760: Contained Missions now fence the host commit itself: `commitPlumbing` accepts a `fence` callback that runs before every worktree write and before the ref update, and the Mission runner's fence refuses once the daemon no longer owns the ledger or the Mission has moved on. Restart drills cover a takeover during an executor turn, a verification, a commit, and each remote mutation.
- 61463a4: Extract contained verification into an owner-neutral module (`contained-verification.ts`, M5 of the contained Mission path): Git candidate export and image build, a neutral `ContainedVerificationBinding` with canonical digest, execution registration and journal reopening, each parameterised by the owner's identity check and fence. Graph contained tests and recovery are now thin adapters with unchanged behaviour; Graph journals keep their exact bytes, and journals written before this change still reopen. Adds `missionVerificationBinding` for contained Missions and `containedCommandFromArgv`, which POSIX-quotes an argv into the single `/bin/sh -c` string the contained runner accepts. Nothing is wired into the daemon or Mission lifecycle yet.
- a5236a5: Clear `OSSTACK_SOCKET` in the CLI test setup so an exported socket cannot point the suite at a real daemon.
- b5f2f93: Keep adopted Session identity faults fenced after cleared waits and source restoration. Prevent daemon drain from reporting success while execution leases remain held after asynchronous or failed cleanup.
- 0cf68ab: Respect unresolved Session dispatch phases during managed upgrade and show only proven pre-dispatch cancellation in attention views.
- 56bd314: Preserve the committed Session send result when writer lease cleanup fails. Keep uncertain delivery errors and retained admission intact. Database-driven replay does not send the original request again; tests cover a daemon restart in the same process.

  Retained-hold visibility across process restart is not verified. Recovery and drain visibility after process death remain pending in DEBT02. This change does not add a recovery API.

- 8db3abb: Preserve completed Session start responses when writer lease cleanup fails. Clear the settled active-run marker while keeping retained admission visible to drain in the current daemon instance. Database-driven replay of the original start request does not start another Session.

  Retained-hold visibility across process restart is not verified. Recovery and drain visibility after process death remain pending in DEBT02. This change does not add a recovery API.

  Replay is a lookup of the stored Session state. A failed initial start returns `agent_failed`; replay returns `ok: true` with `state: failed` and never repeats the adapter invocation. Callers must inspect the stored state. Terminal producer fencing remains a separate change in #279.

- c5d0fc8: Reject Session start streams that end without a successful terminal event. Session send already rejected such streams; it now requires existing adapter stop confirmation before releasing their writer lease. Both paths retain admission when stop is unconfirmed. Normal completed streams still release without stop confirmation. A trusted completed terminal followed by normal iterator exhaustion establishes invocation completion even if the Session result subsequently fails validation (for example, a missing native session ID); that failed result does not retain an already completed invocation.

  Replaying the original request does not invoke the adapter again. A failed Session send replays as delivery_uncertain. For Session start replay, RPC ok means that the stored snapshot was read successfully; clients must check state, which can still be failed or starting.

  Tests use real local RPC and SQLite with a deterministic adapter, including daemon restart in the same process. This change does not qualify live provider stop behavior or add a recovery API. Cross-process retained-hold visibility and recovery remain pending in DEBT02.

- a567bd9: Return exit code 1 when any configured source cannot be checked by `osstack skills check`. Preserve exit code 2 for drift-only results and 0 for no drift or an empty list, and report failed checks separately from drift.
- Updated dependencies [95534c7]
- Updated dependencies [12de1f7]
- Updated dependencies [1372ecd]
- Updated dependencies [85e19da]
- Updated dependencies [eb35fbb]
- Updated dependencies [9d54cfd]
- Updated dependencies [540cd7a]
- Updated dependencies [1e6eeb9]
- Updated dependencies [ca24452]
- Updated dependencies [d5eea3e]
- Updated dependencies [3a5d523]
- Updated dependencies [5b3400e]
- Updated dependencies [0d9dca7]
- Updated dependencies [6a3e760]
- Updated dependencies [43db3e1]
- Updated dependencies [b103f62]
- Updated dependencies [e6d316e]
- Updated dependencies [936aced]
- Updated dependencies [bda3942]
- Updated dependencies [c310d51]
- Updated dependencies [f740da8]
- Updated dependencies [d26c920]
- Updated dependencies [41a1b0a]
- Updated dependencies [2f9d33a]
- Updated dependencies [2389dcd]
- Updated dependencies [52d7730]
- Updated dependencies [13bfb45]
- Updated dependencies [b5f2f93]
- Updated dependencies [7939a10]
- Updated dependencies [e93d640]
  - @osstack/core@0.23.0
  - @osstack/protocol@0.23.0
  - @osstack/github@0.23.0
  - @osstack/agents@0.23.0
  - @osstack/governance@0.23.0
  - @osstack/skill-registry@0.23.0
  - @osstack/loop@0.23.0
  - @osstack/autonomy@0.23.0
  - @osstack/config@0.23.0
  - @osstack/hermes-adapter@0.23.0
  - @osstack/skills@0.23.0
  - @osstack/graph@0.23.0

## 0.22.1

### Patch Changes

- 7a8d2db: Identify supported macOS lock filesystems by their system-reported names instead of unstable numeric registration IDs. Keep unknown filesystems and failed probes blocked.

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

- Updated dependencies [0a61d27]
- Updated dependencies [c8dc83f]
- Updated dependencies [c129a31]
- Updated dependencies [c48e29a]
- Updated dependencies [3d5fdc0]
- Updated dependencies [7e5a84d]
- Updated dependencies [63064cd]
- Updated dependencies [b185daa]
  - @osstack/core@0.22.0
  - @osstack/protocol@0.22.0
  - @osstack/github@0.22.0
  - @osstack/loop@0.22.0
  - @osstack/agents@0.22.0
  - @osstack/knowledge@0.22.0
  - @osstack/autonomy@0.22.0
  - @osstack/config@0.22.0
  - @osstack/hermes-adapter@0.22.0
  - @osstack/skill-registry@0.22.0
  - @osstack/skills@0.22.0
  - @osstack/graph@0.22.0

## 0.21.0

### Minor Changes

- 1fa74af: Add experimental bounded changeset proposal, durable invocation/apply evidence, guarded multifile application, and apply-bound artifact freezing. Preserve historical Graph v4 compiler resolution and include complete cumulative and incremental review inputs. Add canonical writer guard capabilities with retained admission on uncertainty. Production changeset executor registration remains disabled pending lifecycle and reviewer integration.
- e3c0989: Add a constructor-only trusted candidate context handoff to the existing guarded GitHub delivery path. Observe current branch, remote, protection, PR and unique successful required checks without writes, then re-sample context and live policy before handing the hint to the original fully rechecking delivery consumer. Absence remains the original route. No default tool identity producer, runtime activation or additional merge authority is introduced.
- e3c0989: Wire explicit private CandidatePolicy input into the existing local Loop enqueue/run paths. Preserve native lease, policy, required verification and evaluation gates; persist Task batch bindings and run bounded worktree batches with local/prepush/final preflight. Default execution remains compatible. No configuration is installed, runtime activated, push/merge enabled or cost savings claimed.
- 47e29c2: Add opt-in persistent native argument defaults for local Loop enqueue/run while preserving existing parsers, verification gates and lease handling. Reviewer-only routes now request agent admission. No configuration is installed or runtime activated. The repository's linked `@osstack/*` release policy may align other package versions; this does not establish candidate batching, CI reuse, scope2/3 completion or cost savings.

### Patch Changes

- Updated dependencies [27c2148]
- Updated dependencies [1fa74af]
- Updated dependencies [e3c0989]
  - @osstack/loop@0.21.0
  - @osstack/github@0.21.0
  - @osstack/agents@0.21.0
  - @osstack/autonomy@0.21.0
  - @osstack/core@0.21.0
  - @osstack/graph@0.21.0
  - @osstack/config@0.21.0
  - @osstack/hermes-adapter@0.21.0
  - @osstack/skill-registry@0.21.0
  - @osstack/skills@0.21.0

## 0.20.0

### Minor Changes

- 071c1ff: Add versioned session continuation requests and durable waiting diagnostics.
  Parsing an agent-reported request does not authorize automatic continuation.
  Track resumed sessions during daemon drain and
  cancellation, and preserve uncertain delivery receipts in status output.

  Keep improvement proposal identities and reviewed history stable. Gate-only checks
  no longer claim that a candidate was applied. Migration 23 preserves legacy lesson
  counters and records explicit failure observations without claiming effectiveness.

- 912c82a: Allow explicitly selected, lockfile-bound dependency builds during once-authorized PR delivery, with separate candidate/replay stores and build receipts. Preserve script-free preparation by default. Fix complete-tree inspection of unchanged bracketed framework routes without widening authorized candidate paths.
- 1263519: Add trusted local `improve deliver`: one preview confirmation approves a draft proposal, builds and reviews a candidate, replays the saved patch in a clean checkout, verifies it again, and creates a draft GitHub PR. Persist delivery intents, exact commit bindings, cooperative stops and read-only reconciliation in schema 27. PR verification replaces ambient environment inheritance; existing verifier callers keep their defaults. Uncertain writes are never retried automatically. This does not enable daemon delegation, merge, release or hostile-worker isolation.
- 8dca470: Add opt-in `improve deliver --prepare-deps pnpm` for a bounded pnpm 11.4+ (11.x) public-registry environment. Bind committed dependency inputs and observed tool versions to the existing request confirmation, prepare fresh dependencies before the builder and clean PR verification, and expose stage receipts in `improve status`. Install with a frozen lockfile, scripts/hooks disabled and separate stores; failures retain occupancy without automatic retry. Existing commands remain unchanged without this option.
- 9011913: Complete the controlled internal executable Graph beta: preserve reconciliation-only repository locks across legacy acquisition, block upgrades while graph execution remains unresolved, and explicitly reject unsupported Node/Bun graph runtimes. Batch raw Git artifact capture and restoration with independent content and protocol limits so real repository delivery completes within its existing deadline.

  Add compatibility, fault, runtime and performance verification, plus a real internal provider pilot and operations guide. Unknown external effects retain their lock and budget reservation; ready produces a candidate artifact without merging or deploying it.

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

- f4c55ec: Align npm package repository metadata and Trusted Publisher tooling with the transferred osborn-studio/osstack repository. Existing mismatched trust mappings still require explicit operator review.
- 00e7014: Renew repository ownership during post-acquisition authorization, reject expired or cancelled admission, and provide guarded recovery for an exact stopped verification with a retained lock.
- 9f17623: Avoid false Graph worker heartbeat expiry after host event-loop stalls, preserve proven cleanup for rejected admission, and reconcile the exact legacy v4 preparation cancellation through independently checked worker-exit, workspace and lock-absence evidence. Preserve all original action outcomes and never replay effects or unlink replacement locks. Install the macOS daemon with the responsive process class used by the verified deployment.
- 5e56f89: Add read-only OsbornSkillHub publishing diagnostics and preserve companion delivery evidence. Reject unsupported publication surfaces, failed child exits, mismatched assets and unverified API delivery instead of reporting success.
- 4a2646c: Preserve completed Git identity-query output when the daemon event loop stalls, while keeping bounded output and termination of hung queries. Reuse the guarded queries for repository policy checks and add macOS canonical-path regression coverage before merge.
- Updated dependencies [071c1ff]
- Updated dependencies [f4c55ec]
- Updated dependencies [1263519]
- Updated dependencies [de4a3bb]
- Updated dependencies [8e1c810]
- Updated dependencies [c1f4619]
- Updated dependencies [9f17623]
- Updated dependencies [9011913]
- Updated dependencies [29a3a17]
- Updated dependencies [5a82b1c]
- Updated dependencies [f4de18d]
- Updated dependencies [4a2646c]
  - @osstack/protocol@0.20.0
  - @osstack/agents@0.20.0
  - @osstack/loop@0.20.0
  - @osstack/core@0.20.0
  - @osstack/autonomy@0.20.0
  - @osstack/compliance@0.20.0
  - @osstack/config@0.20.0
  - @osstack/contracts@0.20.0
  - @osstack/github@0.20.0
  - @osstack/governance@0.20.0
  - @osstack/graph@0.20.0
  - @osstack/hermes-adapter@0.20.0
  - @osstack/knowledge@0.20.0
  - @osstack/skill-registry@0.20.0
  - @osstack/skills@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [db9b69d]
  - @osstack/agents@0.19.0
  - @osstack/config@0.19.0
  - @osstack/loop@0.19.0

## 0.18.0

### Minor Changes

- 249554f: Add a fixed, bounded `deepseek-no-tools` semantic judge profile, route neat
  semantic and dependency judgments through a shared
  provider registry, and make semantic parity readiness provider-neutral.
  Provider responses now fail closed when the reported model identity differs
  from the requested model.
  Propagate sanitized, closed-registry provider failure codes through semantic
  coverage reports and live diagnostics without exposing provider response bodies
  or exception text. Classify output-token exhaustion, content filtering, and
  provider resource interruption separately while retaining a safe unknown
  finish-reason fallback.

### Patch Changes

- Updated dependencies [249554f]
  - @osstack/agents@0.18.0
  - @osstack/governance@0.18.0
  - @osstack/config@0.18.0
  - @osstack/loop@0.18.0

## 0.17.3

### Patch Changes

- 1331a4d: Fix four operational defects found auditing a live install where `osstack status` reported "daemon: not running" against a healthy daemon that had been refusing all work for 12 hours.

  - **CLI now addresses the deployed daemon.** A plain shell exports neither `OSSTACK_HOME` nor `OSSTACK_SOCKET`, so `paths.ts` resolved `~/.osstack/daemon.sock` while launchd served a different home — every daemon-touching command misreported, and `doctor` printed the wrong socket. Discovery (launchd plist → role file beside the running binary) now fills only what the caller left unset, so explicit dev/test homes still win. Kept subprocess-free to stay inside the 150ms startup budget. **Behaviour change:** this also points write paths at the deployed home — a bare shell running `loop run`, `daily`, `stack` or `checkpoint create` now uses the deployed `OSSTACK_HOME` instead of silently building a second state under `~/.osstack`. That split brain was the bug; export `OSSTACK_HOME` explicitly to opt out.
  - **`doctor` no longer reports ok while the daemon is draining.** A draining daemon refuses sessions and task submissions; doctor called it ok and recommended queue work that would be rejected. It is now an error finding with the disk remedy attached.
  - **A health-raised drain clears itself.** `drain_required` was a one-way latch: dipping below the 2 GiB autonomy floor set `draining` and nothing ever cleared it, so the daemon kept refusing work long after the disk recovered. Health-raised drains now lift when health recovers; operator/upgrade drains still never auto-clear, so `osstack upgrade` stays quiesced mid-swap.
  - **Shadow checkpoints stop filling the disk.** `checkpoint create` excluded only `.git`/`node_modules`/`.osstack`, so virtualenvs, build output and caches were copied wholesale — one checkpoint reached 14 GB and 109 unpruned checkpoints consumed 19 GB, which is what pushed the disk under the drain floor. Virtualenv and cache directories are now excluded at any depth, build-output names (`dist`/`build`/`out`/`target`) only at the workspace root so same-named source directories survive, and only the newest 20 checkpoints are kept.

## 0.17.2

### Patch Changes

- f6b6812: Lazy-dispatch the CLI command surface: every command module and heavy package (`@osstack/loop`, `agents`, `governance`, `github`, `supervisor`, `config`) now loads at its dispatch/use site instead of at startup. `osstack status`/`--help` drop from ~350ms (pre-plan) / ~150ms (post-wrapper) to **~75ms** end-to-end; the eagerly-parsed main chunk shrinks from 1.1MB to ~500KB. `@osstack/loop` values go through a memoized `loadLoop()` with types kept static; five internal helpers became async (all call sites awaited); the `@osstack/config` package's hidden dependency on `@osstack/agents` and the `@osstack/supervisor` chain that pulled loop/governance/agents/github back in (~177ms) are both cut. Import-failure paths surface as clean `osstack:` errors via the entry wrapper.

## 0.17.1

### Patch Changes

- 251d59e: `osstack upgrade` now provisions, backs up, and health-checks against the DEPLOYED daemon's OSSTACK_HOME instead of the caller's shell environment. Resolution priority: the launchd plist's env (how the daemon is actually started) → the role file next to the current global binary (captured before npm wipes it) → caller env/default. Previously, running the upgrade from a shell without the daemon's env re-provisioned the control-plane role file for the default `~/.osstack` while the daemon serves another home — the guard then refused every boot, the health check failed, and the rollback re-provisioned wrongly too, leaving the daemon down (incident 2026-08-12, 0.16.1 → 0.17.0). The same fix protects the unattended launchd auto-upgrade path.

## 0.17.0

### Patch Changes

- 2ab3a6e: Answer `osstack --version` in ~30ms (was ~350ms) via a lightweight entry wrapper.

  `dist/bin.js` is now a 1KB wrapper (`cli-entry.ts`) that serves `--version`/`-v`/`version` without loading the command surface, then lazily imports the full CLI (emitted as a split chunk) for every other command. The direct-execution guard moved into the wrapper and `bin.ts` no longer self-executes — under `bun build --compile` every bundled module reports the same `import.meta.url`, so a guard left in the chunk would have run `main()` twice. Importing `dist/bin.js` as a module remains side-effect free. A new `smoke:cli-startup` gate (`scripts/bench-cli-startup.mjs`) budgets `--version` at 150ms and `--help` at 500ms so the startup tax cannot silently return.

- a007f58: Lazy-load heavy optional dependencies to cut CLI startup module-load cost from ~324ms to ~190ms.

  - `@osstack/agents`: the claude-code adapter now imports `@anthropic-ai/claude-agent-sdk` (grpc/opentelemetry/protobufjs tree, ~150ms) on first `query()` call instead of at module load. Import failures surface through the existing event contracts (`session.terminal failed` / `adapter_threw`), abort is re-checked after the import window, and a failed load is not memoized so later calls can retry.
  - `@osstack/core`: **BREAKING** — `initOtel()` changed from `void` to `Promise<void>`. The OTel NodeSDK/OTLP exporter modules (~100ms) now load lazily inside `initOtel()`, so consumers that never enable tracing skip the cost. Callers must `await initOtel(...)`; un-awaited calls compile-error under `@typescript-eslint/no-floating-promises` and would otherwise start tracing asynchronously (early spans dropped).
  - `@osstack/cli`: daemon startup awaits `initOtel(...)`.

- 21752b5: `osstack stats` now reports per-method daemon RPC latency (p50/p95/max over a sliding ≤512-sample window, sorted by descending p95). The record path is O(1) and allocation-free after warm-up; percentile computation is deferred to the stats call. This gives bulk-API work (Performance Hints plan P2) measured offenders to target. AGENTS.md gains a Performance Budgets section documenting the CI-enforced startup budgets and the daemon RPC p95 < 10ms target.
- Updated dependencies [a007f58]
  - @osstack/core@0.17.0
  - @osstack/agents@0.17.0
  - @osstack/autonomy@0.17.0
  - @osstack/config@0.17.0
  - @osstack/hermes-adapter@0.17.0
  - @osstack/loop@0.17.0
  - @osstack/skill-registry@0.17.0
  - @osstack/skills@0.17.0

## 0.16.1

### Patch Changes

- 6e95ab8: Allow npm Trusted Publishing from private GitHub repositories by deferring provenance generation to npm instead of forcing the unsupported `--provenance` flag.

## 0.16.0

### Minor Changes

- ad57096: Add governed, durable Codex and Claude session relay support with resumable native session identity, optimistic concurrency, idempotent inbound messages, bounded recovery diagnostics, and repository-context preservation.

### Patch Changes

- ad57096: Extract agent registry and scorecard commands into a bounded module with explicit daemon and local-state dependencies.
- ad57096: Extract governance, contract, and compliance assurance commands from the CLI entrypoint.
- 5fc7dc1: Refresh registry update checks after the running CLI version changes, and stop
  reporting a cache from an older CLI release as up to date.
- ad57096: Extract Hermes bridge health, dashboard, cron recipe, and help routing into a bounded command module.
- ad57096: Extract product doctor, examples, and quickstart guide commands into a bounded product-entry module.
- 1103839: Publish workspace packages sequentially in dependency-first order, stop the release train on the first failure, and teach Release Doctor to verify the safe publisher contract.
- ad57096: Extract the governed session CLI into a bounded, independently tested command module without changing its public contract.
- ad57096: Extract external skill registry commands into a focused, testable CLI module.
- ad57096: Extract the Branch Steward command into a focused, testable CLI module.
- ad57096: Extract task submission, status, cancellation, and observation routing into an independently tested command module.
- Updated dependencies [9cc8a37]
- Updated dependencies [ad57096]
  - @osstack/governance@0.16.0
  - @osstack/agents@0.16.0
  - @osstack/core@0.16.0
  - @osstack/loop@0.16.0
  - @osstack/config@0.16.0
  - @osstack/autonomy@0.16.0
  - @osstack/hermes-adapter@0.16.0
  - @osstack/skill-registry@0.16.0
  - @osstack/skills@0.16.0

## 0.15.0

### Minor Changes

- be6cc63: Add an explicit, read-only Codex local generated-memory adapter for `osstack
neat`. The adapter inventories only an operator-selected directory, emits
  portable metadata and hashes without file content, rejects symlink traversal,
  and deliberately exposes no mutation or Claude-specific limit rules.
- 627e22d: Align npm release readiness, plans, and handoff artifacts with tokenless GitHub OIDC Trusted Publishing, and block actual publish when a public package has not been bootstrapped on npm.

### Patch Changes

- 0743a2a: Exclude compiled test and spec artifacts from npm tarballs, scan every packed workspace package for leaks, and verify release candidates against the real npm dependency graph.
- Updated dependencies [0743a2a]
- Updated dependencies [35141a8]
- Updated dependencies [be6cc63]
  - @osstack/agents@0.15.0
  - @osstack/autonomy@0.15.0
  - @osstack/compliance@0.15.0
  - @osstack/config@0.15.0
  - @osstack/contracts@0.15.0
  - @osstack/core@0.15.0
  - @osstack/github@0.15.0
  - @osstack/governance@0.15.0
  - @osstack/hermes-adapter@0.15.0
  - @osstack/knowledge@0.15.0
  - @osstack/loop@0.15.0
  - @osstack/protocol@0.15.0
  - @osstack/skill-registry@0.15.0
  - @osstack/skills@0.15.0

## 0.14.0

### Minor Changes

- 619cd53: Run Codex adapters in each task's repository worktree, keep truncated verifier
  summaries Unicode-safe for strict JSON readers, and add workspace, changed, and
  Git-baseline scopes to Loop governance.

### Patch Changes

- Updated dependencies [619cd53]
  - @osstack/agents@0.14.0
  - @osstack/loop@0.14.0
  - @osstack/config@0.14.0

## 0.13.1

### Patch Changes

- Updated dependencies [733c82a]
  - @osstack/governance@0.13.1
  - @osstack/agents@0.13.1
  - @osstack/loop@0.13.1
  - @osstack/config@0.13.1

## 0.13.0

### Minor Changes

- 4fb11c0: Add project-allowlisted deployment, automatic rollback and freeze, and Mac Mini guarded-autonomy operations.
- b99bbfb: Add durable R0-R4 guarded autonomy and automated R1/R2 GitHub delivery,
  including exact-base candidate pinning, diff-bound R3 approval, SHA-bound
  merged-PR recovery, and fail-closed dependency/security validation.
- 16ec914: Add a first-class Kimi Code adapter and fail-closed structured reviewer verification.

### Patch Changes

- 591405a: Boot out an existing daemon before bootstrapping a replacement LaunchAgent.
- f29b6e5: Retry the transient macOS launchd bootstrap race after replacing a loaded
  LaunchAgent, while preserving a bounded fail-closed installer error.
- Updated dependencies [4fb11c0]
- Updated dependencies [b99bbfb]
- Updated dependencies [16ec914]
  - @osstack/protocol@0.13.0
  - @osstack/core@0.13.0
  - @osstack/autonomy@0.13.0
  - @osstack/agents@0.13.0
  - @osstack/github@0.13.0
  - @osstack/loop@0.13.0
  - @osstack/config@0.13.0
  - @osstack/hermes-adapter@0.13.0
  - @osstack/skill-registry@0.13.0
  - @osstack/skills@0.13.0

## Unreleased

### Minor Changes

- Surface Kimi readiness and runtime identity in agent/config diagnostics,
  preserve checksummed structured review Markdown/JSON in proof packs, and add
  offline plus live seeded-defect evaluation commands.
- Add `deliver --autonomy guarded-git`, durable `autonomy` status/approval/
  resume controls, daemon recovery, two-stage proof composition, and offline
  R1-R4 fault-injection smoke coverage.
- Read guarded authority from committed base policy, reject dirty/stale
  candidate branches, persist the exact base SHA, and wait for boot recovery
  before closing daemon state.
- Add `guarded-deploy`, signed production freeze clear, deployment-aware health
  and scorecards, durable Owner notifications, restart recovery, Mac Mini host
  evidence/retention, controlled rollback drills, and deterministic seven-day
  soak validation.

### Patch Changes

- Reload an existing macOS LaunchAgent by booting out the live service before
  bootstrapping its replacement plist, preventing config/runtime drift during
  profile or power-policy changes.
- Retry the bounded macOS `launchd` teardown/bootstrap race before kickstarting
  a replacement service, and fail closed if registration never succeeds.

## 0.12.0

### Minor Changes

- 4a3dffd: Make knowledge-hygiene ReportV2 the default `neat check` contract, add honest
  coverage and assessment scope, evidence-bound semantic auditing, recoverable
  memory and narrative transactions, append-only V2 lifecycle history, and
  cross-repository dependency obligations with an isolated no-tools judge.
  Explicit `--schema-version 1` remains available for one minor release and now
  emits a deprecation warning.

### Patch Changes

- 8314e99: Make V1 human knowledge-hygiene reports state that semantic dimensions were not assessed instead of presenting zero mechanical findings as global health.
- Updated dependencies [4a3dffd]
  - @osstack/agents@0.12.0
  - @osstack/core@0.12.0
  - @osstack/governance@0.12.0
  - @osstack/loop@0.12.0
  - @osstack/config@0.12.0
  - @osstack/hermes-adapter@0.12.0
  - @osstack/skill-registry@0.12.0
  - @osstack/skills@0.12.0

## 0.11.1

### Patch Changes

- 671aa87: Document the required `--question <item-id>` guard in Probe CLI help.

## 0.11.0

### Minor Changes

- f041063: Add canonical portable probe ledgers, manifest-last repository rendering, artifact receipts, and destination attestations.
- 4a6c00b: Add generic fail-closed kanban transition guards and register the probe readiness adapter at the CLI composition root before execution moves.
- 83aac82: Expose read-only probe portfolio summaries and include current open-item aging and required-item completion in daily briefs when probe sessions exist.

  Push repository filters into the SQLite projection queries so scoped daily and supervisor reads do not scan unrelated probe history.

- a90f3a5: Add evidence-bound dynamic probe questions plus standalone and session-attached registration of skill-produced restatement findings.
- 73f89fd: Compile resolved probe decisions into reviewable Loop EvaluationSpec deltas through a closed registry of parameter-validated templates.
- 223a240: Emit replayable probe metric facts, derive all section 10 outcome rates from append-only events with explicit legacy coverage, and surface baseline-only aggregation in supervisor reports.
- 9f1aa1b: Carry strict verifier-reported implementation deviations through Loop events and idempotently register evidence-bound `mid_build` probe items for linked tasks.
- 61f05ba: Add the persistent `osstack probe` elicitation workflow with strict start, next, resume, status, and ledger command contracts.
- 92249dc: Add strict probe readiness policies and a `probe gate` command for live sessions and independently verifiable portable ledgers.

### Patch Changes

- Updated dependencies [48ad63d]
- Updated dependencies [f041063]
- Updated dependencies [a483f6e]
- Updated dependencies [4a6c00b]
- Updated dependencies [83aac82]
- Updated dependencies [a90f3a5]
- Updated dependencies [73f89fd]
- Updated dependencies [53db533]
- Updated dependencies [223a240]
- Updated dependencies [ac50008]
- Updated dependencies [9f1aa1b]
- Updated dependencies [92249dc]
  - @osstack/governance@0.11.0
  - @osstack/core@0.11.0
  - @osstack/agents@0.11.0
  - @osstack/skill-registry@0.11.0
  - @osstack/hermes-adapter@0.11.0
  - @osstack/loop@0.11.0
  - @osstack/config@0.11.0
  - @osstack/skills@0.11.0

## 0.10.0

### Minor Changes

- 0355f62: R1.4 — `osstack daily`, a read-only portfolio brief and the first Agent Command
  Protocol dogfood surface. Composes existing kernel capability over the repo
  registry: the supervisor maturity scan, a new GitHub read adapter, the stack
  kanban board summary, and a day-over-day delta.

  - `@osstack/github`: new `portfolio-status.ts` (`fetchPortfolioGithubStatus` /
    `fetchRepoGithubStatus` / `parseGithubSlug`) following stack.ts's injectable
    runner pattern. Per repo with a GitHub remote it reads open PRs, recent CI
    runs, and the latest release via `gh`. No `gh` / no remote / network failure
    degrades to a per-repo warning string — it never throws.
  - `@osstack/cli`: new `daily` command
    (`daily [--registry P] [--workspace P] [--json]`). Human Markdown by default;
    `--json` emits a strict protocol `AgentCommandResult` (`status: ok`, the brief
    in `result`, per-repo `evidence_refs`, and ≤3 owner decisions in
    `next_actions`). Persists each brief to
    `$OSSTACK_HOME/daily-briefs/<ISO-date>.json` and diffs against the previous
    one (new PRs, CI status flips, maturity changes). Read-only apart from that
    brief file.

- fcd8417: R2.3 — `osstack daily` scheduling via the daemon. The read-only portfolio brief
  can now run on an interval as a persisted daemon session, alongside (and
  modeled on) the existing loop-session pattern.

  - `daily-command.ts`: extracted the brief composition into an exported
    `runDailyBrief(deps)` core (registry read → maturity scan → GitHub status →
    stack board → delta → persist dated brief → strict `AgentCommandResult`).
    `handleDailyCommand` is now a thin wrapper (parse flags → `runDailyBrief` →
    render), so a scheduled brief is byte-compatible with a manual `osstack daily`
    run. Bare `osstack daily` is unchanged.
  - `daemon.ts`: new session kind `daily` with its own map, `daily-sessions.json`
    persistence (atomic tmp+rename), and restore-on-start — mirroring loop
    sessions. Each tick runs `runDailyBrief` in-process (no shelling out) and
    records the latest result (`lastResultStatus` / `lastBriefPath`). A tick
    failure never crashes the daemon or kills the session: it is counted, and the
    session auto-stops after 5 consecutive failures with a persisted stop reason.
    New RPC methods `daily.schedule` / `daily.list` / `daily.stop`.
  - Policy: `daily` is read-only and intentionally **not** observe-gated —
    observing is exactly what `mode: observe` permits (asserted in tests).
  - CLI: `osstack daily schedule --interval-ms N [--registry P] [--workspace P]
[--schedule EXPR]`, `osstack daily sessions [--json]`, and `osstack daily
unschedule <daily_session_id>` — requiring a running daemon (same refusal
    wording as other daemon-only commands). Interval parsing reuses the exact
    `--interval-ms` / `parseNonNegativeIntegerFlag` convention from `loop start`.

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

- 6981cb3: Add the read-only `osstack neat` / `osstack neat check` command with strict
  config and argument validation, deterministic human output, strict Agent
  Command Protocol JSON, configurable finding exit thresholds, portable and
  atomic `neat review` artifact authoring, a hermetic close-out smoke, and
  matching `--review-file` application whose exit policy considers unresolved
  findings only, plus local/CI/full-audit user documentation.
  Add preview-first `neat fix`; apply requires `--apply --yes`, a complete report,
  matching config hash, and execute/auto-apply/docs policy. Emit strict conflict
  and before/after hash evidence without replacing existing targets.
  Add explicit `--record` with an optional `--db` override; default checks remain
  stateless, while repeated identical reports converge without duplicate runs or
  occurrences.
- 25b3f4a: Add the versioned read-only knowledge-surface adapter contract and the first
  explicitly enabled Claude Code auto-memory adapter. Inventory one exact memory
  directory, publish portable adapter-tagged metrics, and report the documented
  Claude-specific `MEMORY.md` 200-line/25KB limit with official-source evidence.
  Expose `--adapter claude-code` and `--claude-memory-dir` without changing the
  default repository-only check.
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

- 620cc4f: R2.2 — kernel-level policy gate. Closes the R1.3 debt where observe-mode
  enforcement was CLI-layer only: direct daemon RPC clients and the daemon's own
  scheduler bypassed it.

  - `@osstack/loop`: `LoopRunOptions` gains an optional injectable
    `policyGate?: (ctx: { workspacePath }) => Promise<PolicyGateDecision>` (new
    loop-local `PolicyGateDecision`/`PolicyGate`/`LoopPolicyStatus` structural
    types — the loop never couples to the policy loader/schema, which lives in
    the CLI product layer). The engine consults it once at
    `runOnce()`/`runCycles()` entry (refuse before ANY discovery/execution) and
    once per scheduled cycle tick inside `runCycles` (a mid-flight flip stops the
    loop cleanly with a `policy_denied` outcome — like a budget stop, never an
    exception). A denial surfaces `result.policy = { denied: true, reason }` and a
    `policy_denied` `loop.stopped` event. No gate injected ⇒ byte-identical prior
    behavior. A gate that throws is fail-closed (counts as deny with the error
    message), same discipline as the `assetize` self-improvement hook.
  - `@osstack/cli`: new shared `makePolicyGate(workspacePath)` (`policy-gate.ts`)
    backed by core's `loadPolicyProfile` — absent file ⇒ allow, `mode: observe` ⇒
    deny with the established wording, invalid file ⇒ deny with the loader error
    (fail-closed). The R1.3 `enforceObservePolicyGate` in bin.ts now delegates to
    it (exit codes 2/1 and stderr unchanged). The gate is injected into every
    daemon `LoopEngine` via `withLoopAdapters` (the `loop.run` RPC — which now
    returns a `policy_denied` error under observe — and the persisted session
    scheduler — whose next tick stops with a persisted `policy_denied`
    stop_reason), and into the direct-CLI `deliver` / `loop run` engines for
    defense-in-depth. The gate re-reads policy on every consult (no caching), so a
    mid-session flip of `.osstack/policy.yaml` is honored on the next tick.

  The only intentionally ungated daemon path remains the read-only `daily`
  composition (observe mode permits observation); that lands in R2.3.

- b665208: Machine-scoped portfolio registry fallback (R1.6). `resolveRegistryPath` now
  resolves, in order: explicit `--registry`; explicit `--workspace` (pinned, no
  fallback); `cwd/.osstack/repos.json` when it exists; `$OSSTACK_HOME/repos.json`
  when it exists; the legacy cwd default otherwise. `osstack daily` / `supervise`
  now find the machine-scoped registry from any cwd without flags. No behavior
  change for repos that already have a workspace-local registry.

  Write-path note: `supervise register` writes to the resolved registry, so with
  a machine registry present and no local one it now appends there instead of
  creating a fresh local file — pass `--workspace .` to force a repo-local
  registry.

### Patch Changes

- 5051f5a: R2.4 — `daily` next_actions become dispatchable (fulfils the R1.4 CTO ruling).

  Each owner decision in the `daily` brief now carries a REAL runnable invocation
  alongside its (unchanged) advisory `command` category id, built with R1.5's
  audited `shQuote` helper (now exported from `start-control-command.ts` and
  reused, not re-implemented):

  - `repo.fix_ci` → `osstack start "fix failing CI on <repo_id>: latest run is
<status>" --repo-id <repo_id>`.
  - `repo.review_prs` → `gh pr list --repo <slug> --state open` when the repo has
    a resolved GitHub remote, else the local repo path (human review action).
  - `portfolio.raise_maturity` → `osstack supervise init-loop-doc --repo
<repo_id>` only for the single-repo-attributable missing-`docs/LOOP.md` gap
    that command actually remedies; every other free-text / unattributable
    recommendation stays portfolio-level `osstack supervise report`.

  Additive result shape only: the payload rides in `result` as
  `brief.owner_decisions[].run { command, argv }` (mirroring R1.5's
  `deliver_command`/`deliver_args`); the strict `NextAction` protocol envelope
  keeps its `{ command, reason }` shape and existing `CommandName` ids, so no
  consumer breaks. The human Markdown render shows the runnable line under each
  owner decision. All interpolated values (repo ids from the registry, CI status
  from `gh` output) are shell-quoted as untrusted input.

- dd61975: `daily`'s `portfolio.raise_maturity` owner decision now dispatches off the
  portfolio report's `structured_recommendations` instead of string-matching the
  free-text `LOOP_DOC_RECOMMENDATION` wording and parsing a `<name>: ` prefix. An
  `add_loop_doc` recommendation carrying a `repo_id` maps to
  `osstack supervise init-loop-doc --repo <repo_id>`; every other kind (or one
  without a `repo_id`) stays portfolio-level `osstack supervise report`.

  Behavior improvement: because dispatch keys on the registry-unique `repo_id`
  rather than the display name, duplicate-named repos are no longer ambiguous —
  the missing-`docs/LOOP.md` gap for a repo that shares its display name with
  another repo now dispatches to `init-loop-doc` (previously it fell back to
  `supervise report`). No output shape change; the strict `NextAction` envelope is
  untouched.

- 9a660ef: `serve --install`: fix the generated LaunchAgent crash-looping with exit 127
  (`env: node: No such file or directory`). launchd's default PATH lacks
  `/opt/homebrew/bin` (and nvm shims), so a JS bin's `#!/usr/bin/env node`
  shebang cannot resolve. The plist now, for JS bin paths (detected via
  realpath, so the extensionless npm-global symlink shim is covered too),
  extends PATH (current runtime's dir first, then the standard install dirs)
  and invokes `node` by name — no absolute node path is pinned, so a later
  brew/nvm node upgrade keeps working. Native single-binary installs are
  still executed directly.
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

- Updated dependencies [0355f62]
- Updated dependencies [1b48a7d]
- Updated dependencies [daeb3c4]
- Updated dependencies [276428b]
- Updated dependencies [25b3f4a]
- Updated dependencies [7396e6f]
- Updated dependencies [6a4a9d4]
- Updated dependencies [3223420]
- Updated dependencies [12b6796]
- Updated dependencies [392f8b0]
- Updated dependencies [620cc4f]
- Updated dependencies [99ca3b4]
  - @osstack/github@0.10.0
  - @osstack/core@0.10.0
  - @osstack/loop@0.10.0
  - @osstack/governance@0.10.0
  - @osstack/protocol@0.10.0
  - @osstack/agents@0.10.0
  - @osstack/config@0.10.0
  - @osstack/hermes-adapter@0.10.0
  - @osstack/skill-registry@0.10.0
  - @osstack/skills@0.10.0

## 0.9.0

### Minor Changes

- a6f2075: Loop Engineering upgrade (Increments A–E): first-class evaluation specs with
  per-spec verifier results (`--verify` and artifact gates become implicit
  specs), feedback-carrying iteration with no-progress escalation, discovery
  governance (`--discovery-policy`), budget/stop controls
  (`--max-runtime-ms`/`--max-tokens`/`--max-cost-usd`/`--no-progress-limit`,
  exit code 2 on budget), and SOP lesson drafts with an
  `osstack loop lessons list|show|promote|discard` review workflow. DeepSeek
  ds-review/ds-verify now judge evaluation specs per-spec via
  `OSSTACK_EVALUATION_SPECS_FILE`/`OSSTACK_EVALUATIONS`. All additive and
  opt-in; existing CLI behavior is unchanged.
- 17312b5: Loop self-improvement hook (opt-in, injected). `@osstack/loop` gains a
  `selfImprovement` option on `LoopRunOptions`: when enabled, each finalized
  `CompletedTask` is handed to an injected `assetize` callback that turns it into
  a run trace, feedback assets, and optional improvement proposals, folding the
  resulting ids/summary/self-improvement level back onto the `CompletedTask`
  (new optional fields `trace_id`, `feedback_asset_ids`, `proposal_ids`,
  `assetization_summary`, `self_improvement_level`). The loop stays free of any
  `@osstack/supervisor` or SQLite dependency — the callback owns assetization and
  persistence — and the hook never fails a task (errors are swallowed and emitted
  as `loop.self_improvement.failed`). The CLI wires this via
  `osstack loop run --self-improvement --repo-id <id> [--propose-improvements]`,
  which records assets/proposals into the local control-plane state DB. Local-only
  (cannot combine with `--daemon`); when disabled, loop behavior is unchanged.

### Patch Changes

- 23fb3e7: Post-completion hardening of the loop-engineering line (four documented minor
  deferrals, all fail-closed):

  - Verifier fails closed on unknown evaluation-id judgments instead of dropping
    them: a verifier-adapter judgment whose id matches no requested spec now
    surfaces an issue (rule `verify.unknown_evaluation_id`) — failing orphan =
    error, passing orphan = warning. A real failure reported under a mismatched id
    can no longer let a run pass silently.
  - `osstack loop lessons promote --to-skill` refuses any target that is not a
    `SKILL.md` (external skill paths still allowed; arbitrary files are rejected).
  - `DiscoveryPolicy` rejects unknown `source_authorization` keys at parse time
    (e.g. a typo'd `task_quee`) instead of silently falling through to the default.
  - Scorecard scale (100 base, 110 with a budget dimension) is documented as an
    additive rubric with the denominator always rendered — never a bare percentage.

- Updated dependencies [23fb3e7]
- Updated dependencies [a6f2075]
- Updated dependencies [17312b5]
  - @osstack/loop@0.9.0
  - @osstack/agents@0.9.0

## 0.8.1

### Patch Changes

- 1cc380a: Allow the Single Binary Release workflow to publish an explicitly labeled ad-hoc macOS archive when Apple notarization secrets are unavailable, while preserving the notarized release path.

## 0.8.0

### Patch Changes

- Updated dependencies [89ffb4b]
  - @osstack/knowledge@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [b611e6e]
  - @osstack/knowledge@0.7.0

## 0.6.0

### Minor Changes

- fd7a88c: Add deterministic `osstack cockpit tui --fullscreen --interactive` key-sequence automation for selecting actions and quitting from the fullscreen cockpit state model.

## 0.5.0

### Minor Changes

- 13f6035: Add `osstack cockpit tui --fullscreen`, a framed cockpit workbench renderer backed by tested keyboard navigation state.

## 0.4.0

### Patch Changes

- Updated dependencies [8cc4b41]
  - @osstack/knowledge@0.4.0

## 0.3.0

### Minor Changes

- 99b17ef: Add the initial contract-validation slice. `osstack contracts check --json` validates an `osstack.contracts.json` manifest against frontend `fetch()` calls and backend routes, and generated proof packs now include `contract-validation.json` evidence.

### Patch Changes

- Updated dependencies [99b17ef]
  - @osstack/contracts@0.3.0

## 0.2.0

### Minor Changes

- Ship the osstack upgrade evidence, governance, compliance, Knowledge Cloud, cockpit, and product companion surfaces.

  - Add official Knowledge Cloud packs, indexing, ingest, cloud service, Docker/Fly/Render deployment assets, and smoke tests.
  - Add governed delivery, proof/report/scorecard/compliance evidence, PR bodies, and product companion specs.
  - Expand loop evidence, knowledge traces, cockpit reporting, checkpointing, and npm install smoke coverage.

### Patch Changes

- Updated dependencies
  - @osstack/knowledge@0.2.0
  - @osstack/compliance@0.2.0
  - @osstack/governance@0.2.0
  - @osstack/loop@0.2.0
  - @osstack/core@0.2.0
  - @osstack/agents@0.2.0
  - @osstack/github@0.2.0
  - @osstack/config@0.2.0
  - @osstack/hermes-adapter@0.2.0
  - @osstack/skill-registry@0.2.0
  - @osstack/skills@0.2.0

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

### Patch Changes

- Updated dependencies [45b3b78]
  - @osstack/agents@0.1.0
  - @osstack/config@0.1.0
  - @osstack/core@0.1.0
  - @osstack/hermes-adapter@0.1.0
  - @osstack/skill-registry@0.1.0
  - @osstack/skills@0.1.0
  - @osstack/loop@0.1.0
