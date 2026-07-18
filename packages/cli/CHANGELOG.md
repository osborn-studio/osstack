# @osstack/cli

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
