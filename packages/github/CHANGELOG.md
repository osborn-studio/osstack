# @osstack/github

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
