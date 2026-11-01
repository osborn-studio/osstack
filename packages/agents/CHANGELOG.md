# @osstack/agents

## 0.23.0

### Minor Changes

- ca24452: Add `CodexProxyExecutor` for contained Missions. It runs Codex read-only with user config and rules ignored, in an isolated HOME and CODEX_HOME that hold only a copied login, and reads the proposed patch losslessly through `-o`. Codex runs in its own process group with stop evidence, and a host-run qualification probe checks that the sandbox denies writes and network for the probe and for a descendant that left its group.
- 3a5d523: Add host-side git hardening and safe file writes for the contained Mission path (M3). `runHardenedGit` runs git from an argv array with no shell, a minimal environment (PATH, HOME, LANG/LC*\*; every ambient `GIT*\*`stripped; system and global config disabled; replace objects off), a fixed`core.hooksPath`/`core.fsmonitor`/`core.attributesFile`override, bounded output, a timeout and an AbortSignal.`inspectRepoConfig`reads repository-scoped config with includes expanded, returns a canonical digest and stable rejection codes for keys that run programs or change transport;`assertRepoConfigUnchanged`re-checks the digest.`createNoCheckoutWorktree`adds a worktree with no checkout and materializes the start commit's blobs host-side (symlinks, submodules and unsafe paths rejected, exec bits kept, index refreshed so status is clean).`commitPlumbing`commits explicit paths with hash-object/update-index/write-tree/commit-tree and a compare-and-swap`update-ref`, never running filters or hooks. `safeWriteFile`/`safeRemoveFile`/`safeReadFile` refuse symlinked components, symlink and hard-link targets, and write via fsynced same-directory temp files verified by sha256. Existing Loop worktree helpers are unchanged.
- f740da8: **Behavior change — Loop no longer lands isolated-worktree work locally by default (D7), and never loses executor-made commits (D6).**

  - `osstack loop run --worktree` and `osstack deliver --worktree` used to fast-forward whatever branch the main checkout had checked out after a successful task. They now commit the verified tree on the kept `osstack/loop/...` task branch and report it (`loop.worktree.preserved`, reason `local_landing_disabled`; `worktree_commit` and `worktree_branch_preserved: true` in the completed task). Nothing in the main checkout changes, which keeps unattended/factory runs on controlled PR delivery (humans merge main).
  - Local landing is an explicit, attended opt-in: `--land-branch <B>` (requires `--worktree`; `deliver` only with `--autonomy legacy`) or `LoopRunOptions.localLanding = { targetBranch }`. It lands only the accepted commit and is refused unless the main checkout has `<B>` checked out. Daemon-managed loops (`loop start`, `loop run --daemon`) do not offer it. A `CandidatePolicy` implies its own `branch` as the target. To keep the old behavior, add `--land-branch <current branch>`.
  - `--govern` combined with `--worktree` now requires `--land-branch`, because legacy governance scans the main checkout and would otherwise pass without seeing the candidate.
  - `mergeWorktree(handle, { expectedCommit, targetBranch })` now requires both options and also refuses when the accepted commit is not the single commit on top of the worktree's recorded start.
  - `createWorktree` records `startCommit`. When the executor ran `git commit` itself, `commitWorktreeChanges` reports `executorCommitted` (with the branch tip as `commit` on a clean tree); the Loop preserves that branch (reason `executor_commits`) and refuses to land it, because review evidence was collected against the worktree HEAD. `cleanupWorktree` returns `{ branchRemoved }` and never deletes a branch whose tip is not the start commit or already contained in HEAD or another ref, including during orphan cleanup.
  - Reports and proof packs accept the new `preserved` worktree status (a commit is required).
  - `--goal` combined with `--worktree` (and `LoopRunOptions.goalCommand` with `useWorktree`) now requires local landing (`WORKTREE_GOAL_REQUIRES_LOCAL_LANDING`), because the goal command runs in the main checkout and would never observe work kept on the task branch. Daemon-managed `loop start --worktree --goal` sessions are refused for the same reason.

### Patch Changes

- 1e6eeb9: Let the Codex CLI adapter accept explicit `writableRoots` (at most eight existing, non-root, absolute directories, canonicalized) and pass each as `--add-dir` on exec and resume, allowed only with the `workspace-write` sandbox. No environment defaults are added; invalid or out-of-sandbox roots are rejected at construction.
- 6a3e760: Contained Missions now fence the host commit itself: `commitPlumbing` accepts a `fence` callback that runs before every worktree write and before the ref update, and the Mission runner's fence refuses once the daemon no longer owns the ledger or the Mission has moved on. Restart drills cover a takeover during an executor turn, a verification, a commit, and each remote mutation.
- e6d316e: Request all untracked files explicitly when deciding whether an isolated loop worktree has work to commit and whether a GitHub delivery candidate is clean. Repository config such as `status.showUntrackedFiles=no` no longer makes untracked-only work look clean, so it is committed instead of being discarded with the worktree, and delivery refuses instead of publishing a PR that omits it.
- 41a1b0a: Pin isolated-worktree landing to the accepted commit. `mergeWorktree` accepts `{ expectedCommit }` (a full commit id), refuses when the task branch no longer points at it, and fast-forwards that exact object instead of the movable branch name. The loop passes the commit it made from the verified tree, so commits added to the task branch after acceptance cannot land.
- Updated dependencies [95534c7]
- Updated dependencies [12de1f7]
- Updated dependencies [1372ecd]
- Updated dependencies [85e19da]
- Updated dependencies [eb35fbb]
- Updated dependencies [5b3400e]
- Updated dependencies [0d9dca7]
- Updated dependencies [b103f62]
- Updated dependencies [936aced]
- Updated dependencies [d26c920]
- Updated dependencies [2f9d33a]
- Updated dependencies [13bfb45]
- Updated dependencies [b5f2f93]
- Updated dependencies [7939a10]
  - @osstack/core@0.23.0
  - @osstack/protocol@0.23.0
  - @osstack/governance@0.23.0
  - @osstack/hermes-adapter@0.23.0

## 0.22.0

### Minor Changes

- c8dc83f: Complete Firstmate adoption entry points for bounded scout promotion, evidence-backed lesson drafts, multi-check Graph contracts, source generation/event ledgers and explicitly approved context, paired model evaluation, private worker observers, independently authorized remote Graph cancellation, GitHub follow-up delivery, and managed multi-home upgrade recovery. Keep external provider, terminal backend, SSH and service-manager qualification explicit and disabled without host authority.
- 63064cd: Add explicitly enabled advisory triage with persistent budgets and unresolved-stop quarantine, and a scoped local follow-up ledger with immutable evidence, unsent drafts and source-condition resolution. Connect actual CLI and daemon entrypoints without granting external delivery or source execution authority.

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
  - @osstack/hermes-adapter@0.22.0

## 0.21.0

### Minor Changes

- 1fa74af: Add experimental bounded changeset proposal, durable invocation/apply evidence, guarded multifile application, and apply-bound artifact freezing. Preserve historical Graph v4 compiler resolution and include complete cumulative and incremental review inputs. Add canonical writer guard capabilities with retained admission on uncertainty. Production changeset executor registration remains disabled pending lifecycle and reviewer integration.

### Patch Changes

- Updated dependencies [1fa74af]
  - @osstack/core@0.21.0
  - @osstack/hermes-adapter@0.21.0

## 0.20.0

### Minor Changes

- 071c1ff: Add versioned session continuation requests and durable waiting diagnostics.
  Parsing an agent-reported request does not authorize automatic continuation.
  Track resumed sessions during daemon drain and
  cancellation, and preserve uncertain delivery receipts in status output.

  Keep improvement proposal identities and reviewed history stable. Gate-only checks
  no longer claim that a candidate was applied. Migration 23 preserves legacy lesson
  counters and records explicit failure observations without claiming effectiveness.

- de4a3bb: Require valid adapter terminal events, propagate bounded cancellation with explicit stop evidence, and confirm owned command process-group exits. Add an authorized single-implementation entry point for future executable graph orchestration while retaining legacy Loop delivery behavior and preventing retries of unconfirmed executions.
- 5a82b1c: Add signed, finite phase continuation for the controlled no-tools planning/review
  session runtime. Bind frozen output checks and instructions to the exact session,
  runtime policy, owner key, initial turn/version, deadlines and cumulative budgets.

  Migration 24 persists grants and attempts alongside existing session receipts.
  Revoke stops subsequent actions; crash recovery never automatically resends an
  uncertain accepted delivery. Add collaborator inspect/draft/sign/install/status/revoke
  commands. This does not grant code execution, GitHub approval, merge or deployment
  powers to unrestricted agent sessions.

### Patch Changes

- f4c55ec: Align npm package repository metadata and Trusted Publisher tooling with the transferred osborn-studio/osstack repository. Existing mismatched trust mappings still require explicit operator review.
- 29a3a17: Execute digest-approved low-risk improvement proposals in a retained candidate worktree with independent structured review, exact file boundaries, replay-safe execution records, and hashed evidence. Candidate verification does not mark a proposal applied or prove effectiveness. Add strict Codex completion and per-run execution environment support.
- Updated dependencies [071c1ff]
- Updated dependencies [f4c55ec]
- Updated dependencies [1263519]
- Updated dependencies [c1f4619]
- Updated dependencies [9f17623]
- Updated dependencies [9011913]
- Updated dependencies [29a3a17]
- Updated dependencies [5a82b1c]
- Updated dependencies [f4de18d]
- Updated dependencies [4a2646c]
  - @osstack/protocol@0.20.0
  - @osstack/core@0.20.0
  - @osstack/governance@0.20.0
  - @osstack/hermes-adapter@0.20.0

## 0.19.0

### Minor Changes

- db9b69d: Add a Z-Code CLI adapter for running coding tasks with GLM through the locally authenticated Z-Code desktop CLI.

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
  - @osstack/governance@0.18.0

## 0.17.0

### Patch Changes

- a007f58: Lazy-load heavy optional dependencies to cut CLI startup module-load cost from ~324ms to ~190ms.

  - `@osstack/agents`: the claude-code adapter now imports `@anthropic-ai/claude-agent-sdk` (grpc/opentelemetry/protobufjs tree, ~150ms) on first `query()` call instead of at module load. Import failures surface through the existing event contracts (`session.terminal failed` / `adapter_threw`), abort is re-checked after the import window, and a failed load is not memoized so later calls can retry.
  - `@osstack/core`: **BREAKING** — `initOtel()` changed from `void` to `Promise<void>`. The OTel NodeSDK/OTLP exporter modules (~100ms) now load lazily inside `initOtel()`, so consumers that never enable tracing skip the cost. Callers must `await initOtel(...)`; un-awaited calls compile-error under `@typescript-eslint/no-floating-promises` and would otherwise start tracing asynchronously (early spans dropped).
  - `@osstack/cli`: daemon startup awaits `initOtel(...)`.

- Updated dependencies [a007f58]
  - @osstack/core@0.17.0
  - @osstack/hermes-adapter@0.17.0

## 0.16.0

### Minor Changes

- ad57096: Add governed, durable Codex and Claude session relay support with resumable native session identity, optimistic concurrency, idempotent inbound messages, bounded recovery diagnostics, and repository-context preservation.

### Patch Changes

- Updated dependencies [9cc8a37]
- Updated dependencies [ad57096]
  - @osstack/governance@0.16.0
  - @osstack/core@0.16.0
  - @osstack/hermes-adapter@0.16.0

## 0.15.0

### Patch Changes

- 0743a2a: Exclude compiled test and spec artifacts from npm tarballs, scan every packed workspace package for leaks, and verify release candidates against the real npm dependency graph.
- Updated dependencies [0743a2a]
- Updated dependencies [35141a8]
- Updated dependencies [be6cc63]
  - @osstack/core@0.15.0
  - @osstack/governance@0.15.0
  - @osstack/hermes-adapter@0.15.0

## 0.14.0

### Patch Changes

- 619cd53: Run Codex adapters in each task's repository worktree, keep truncated verifier
  summaries Unicode-safe for strict JSON readers, and add workspace, changed, and
  Git-baseline scopes to Loop governance.

## 0.13.1

### Patch Changes

- Updated dependencies [733c82a]
  - @osstack/governance@0.13.1

## 0.13.0

### Minor Changes

- b99bbfb: Add durable R0-R4 guarded autonomy and automated R1/R2 GitHub delivery,
  including exact-base candidate pinning, diff-bound R3 approval, SHA-bound
  merged-PR recovery, and fail-closed dependency/security validation.
- 16ec914: Add a first-class Kimi Code adapter and fail-closed structured reviewer verification.

### Patch Changes

- Updated dependencies [4fb11c0]
- Updated dependencies [b99bbfb]
  - @osstack/core@0.13.0
  - @osstack/hermes-adapter@0.13.0

## Unreleased

### Minor Changes

- Add a first-class, no-tool Kimi Code reviewer/release verifier with strict
  structured output, authenticated three-state readiness diagnostics, bounded
  execution, minimal child environments, and runtime identity evidence.
- Mark Kimi provider/model identity as reported only when the authenticated
  provider probe reports the exact invocation provider and default model.

## 0.12.0

### Minor Changes

- 4a3dffd: Make knowledge-hygiene ReportV2 the default `neat check` contract, add honest
  coverage and assessment scope, evidence-bound semantic auditing, recoverable
  memory and narrative transactions, append-only V2 lifecycle history, and
  cross-repository dependency obligations with an isolated no-tools judge.
  Explicit `--schema-version 1` remains available for one minor release and now
  emits a deprecation warning.

### Patch Changes

- Updated dependencies [4a3dffd]
  - @osstack/core@0.12.0
  - @osstack/governance@0.12.0
  - @osstack/hermes-adapter@0.12.0

## 0.11.0

### Minor Changes

- 9f1aa1b: Carry strict verifier-reported implementation deviations through Loop events and idempotently register evidence-bound `mid_build` probe items for linked tasks.

### Patch Changes

- ac50008: Align the Claude agent adapter with its Zod 4 peer contract and update the skill registry YAML parser to a patched release.
- Updated dependencies [f041063]
- Updated dependencies [a483f6e]
- Updated dependencies [4a6c00b]
- Updated dependencies [83aac82]
- Updated dependencies [223a240]
- Updated dependencies [9f1aa1b]
  - @osstack/core@0.11.0
  - @osstack/hermes-adapter@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [1b48a7d]
- Updated dependencies [daeb3c4]
- Updated dependencies [7396e6f]
- Updated dependencies [6a4a9d4]
- Updated dependencies [3223420]
- Updated dependencies [392f8b0]
- Updated dependencies [99ca3b4]
  - @osstack/core@0.10.0
  - @osstack/hermes-adapter@0.10.0

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

## 0.2.0

### Minor Changes

- Ship the osstack upgrade evidence, governance, compliance, Knowledge Cloud, cockpit, and product companion surfaces.

  - Add official Knowledge Cloud packs, indexing, ingest, cloud service, Docker/Fly/Render deployment assets, and smoke tests.
  - Add governed delivery, proof/report/scorecard/compliance evidence, PR bodies, and product companion specs.
  - Expand loop evidence, knowledge traces, cockpit reporting, checkpointing, and npm install smoke coverage.

### Patch Changes

- Updated dependencies
  - @osstack/core@0.2.0
  - @osstack/hermes-adapter@0.2.0

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
  - @osstack/core@0.1.0
  - @osstack/hermes-adapter@0.1.0
