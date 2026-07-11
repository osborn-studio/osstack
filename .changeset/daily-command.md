---
"@osstack/github": minor
"@osstack/cli": minor
---

R1.4 — `osstack daily`, a read-only portfolio brief and the first Agent Command
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
