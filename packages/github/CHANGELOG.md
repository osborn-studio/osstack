# @osstack/github

## 0.23.0

### Minor Changes

- 9d54cfd: Add a bounded read-only pull request candidate snapshot API with head/base checks, paginated check and review observations, and explicit incomplete-state reporting. The snapshot never authorizes or performs a merge.
- 540cd7a: Add a bounded one-time report for one to three explicitly ordered PR candidates. Retain each candidate's observations, unknowns and raw evidence; only pass a stable observed merged prefix when selecting the unresolved frontier. Branch relations are observations rather than ancestry proof, and reports never authorize merge.

### Patch Changes

- d5eea3e: Prevent PR stack ingestion from treating anomalous CheckRun outcomes as successful. Classify ACTION_REQUIRED, STALE and STARTUP_FAILURE as failures, and require explicit COMPLETED status with SUCCESS, NEUTRAL or SKIPPED to report success. Missing, unknown and waiting states are reported as pending; preserve existing StatusContext handling and failure precedence.
- bda3942: Preserve legacy GitHub StatusContext success and failure outcomes during PR stack ingestion instead of reporting them as pending. Keep existing CheckRun aggregation and conservative handling of missing or unknown context states.

## 0.22.0

### Minor Changes

- 0a61d27: Add scoped read-only attention snapshots and opt-in persistent decision observation, guarded manual answers, delivery receipts, explicit foreground handoff, and local notification artifacts. Add bounded Loop/CI observation and offline planning helpers. The observer makes no model calls and confers no execution or approval authority.

  Daemon ownership now uses a fixed-file native exclusive lock before startup side effects. Interrupted Loop/daily sessions require explicit recovery; startup and loop cycles preserve unknown worktrees. Ambiguous or failed session instructions are no longer automatically replayed; an explicit, recorded owner disposition is available without claiming their effects succeeded. SQLite migrations 40–41 add the independent attention records.

- c129a31: Bind explicitly requested V2 delivery to frozen scope, host verification receipts, and requested completion boundaries. Add pinned local prompt context with byte budgets and adapter-boundary receipts, evidence-backed investigation drafts, and explicit read-only local deployment identity inventory. Legacy execution remains available; these additions do not imply remote, publication or deployment qualification.

## 0.21.0

### Minor Changes

- 27c2148: Add opt-in bounded candidate validation stages with private persistent records and GitHub delivery evidence reuse that rechecks current remote commits, protection and mandatory checks. Default execution and delivery behavior remain unchanged.
- e3c0989: Add a constructor-only trusted candidate context handoff to the existing guarded GitHub delivery path. Observe current branch, remote, protection, PR and unique successful required checks without writes, then re-sample context and live policy before handing the hint to the original fully rechecking delivery consumer. Absence remains the original route. No default tool identity producer, runtime activation or additional merge authority is introduced.

## 0.20.0

### Patch Changes

- f4c55ec: Align npm package repository metadata and Trusted Publisher tooling with the transferred osborn-studio/osstack repository. Existing mismatched trust mappings still require explicit operator review.

## 0.15.0

### Patch Changes

- 0743a2a: Exclude compiled test and spec artifacts from npm tarballs, scan every packed workspace package for leaks, and verify release candidates against the real npm dependency graph.

## 0.13.0

### Minor Changes

- b99bbfb: Add durable R0-R4 guarded autonomy and automated R1/R2 GitHub delivery,
  including exact-base candidate pinning, diff-bound R3 approval, SHA-bound
  merged-PR recovery, and fail-closed dependency/security validation.

## Unreleased

### Minor Changes

- Add guarded GitHub delivery with safe argv execution, exact-head push, pull
  request reuse, required-check waiting, match-head merge protection, and
  structured Git delivery evidence.
- Recover an already merged exact-head pull request by revalidating protected
  base checks and merge evidence without repeating push, PR creation, or merge.

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

## 0.2.0

### Minor Changes

- Ship the osstack upgrade evidence, governance, compliance, Knowledge Cloud, cockpit, and product companion surfaces.

  - Add official Knowledge Cloud packs, indexing, ingest, cloud service, Docker/Fly/Render deployment assets, and smoke tests.
  - Add governed delivery, proof/report/scorecard/compliance evidence, PR bodies, and product companion specs.
  - Expand loop evidence, knowledge traces, cockpit reporting, checkpointing, and npm install smoke coverage.
