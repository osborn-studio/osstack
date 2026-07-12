---
"@osstack/cli": patch
---

R2.4 — `daily` next_actions become dispatchable (fulfils the R1.4 CTO ruling).

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
