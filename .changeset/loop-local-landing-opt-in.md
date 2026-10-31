---
"@osstack/agents": minor
"@osstack/loop": minor
"@osstack/cli": minor
---

**Behavior change — Loop no longer lands isolated-worktree work locally by default (D7), and never loses executor-made commits (D6).**

- `osstack loop run --worktree` and `osstack deliver --worktree` used to fast-forward whatever branch the main checkout had checked out after a successful task. They now commit the verified tree on the kept `osstack/loop/...` task branch and report it (`loop.worktree.preserved`, reason `local_landing_disabled`; `worktree_commit` and `worktree_branch_preserved: true` in the completed task). Nothing in the main checkout changes, which keeps unattended/factory runs on controlled PR delivery (humans merge main).
- Local landing is an explicit, attended opt-in: `--land-branch <B>` (requires `--worktree`; `deliver` only with `--autonomy legacy`) or `LoopRunOptions.localLanding = { targetBranch }`. It lands only the accepted commit and is refused unless the main checkout has `<B>` checked out. Daemon-managed loops (`loop start`, `loop run --daemon`) do not offer it. A `CandidatePolicy` implies its own `branch` as the target. To keep the old behavior, add `--land-branch <current branch>`.
- `--govern` combined with `--worktree` now requires `--land-branch`, because legacy governance scans the main checkout and would otherwise pass without seeing the candidate.
- `mergeWorktree(handle, { expectedCommit, targetBranch })` now requires both options and also refuses when the accepted commit is not the single commit on top of the worktree's recorded start.
- `createWorktree` records `startCommit`. When the executor ran `git commit` itself, `commitWorktreeChanges` reports `executorCommitted` (with the branch tip as `commit` on a clean tree); the Loop preserves that branch (reason `executor_commits`) and refuses to land it, because review evidence was collected against the worktree HEAD. `cleanupWorktree` returns `{ branchRemoved }` and never deletes a branch whose tip is not the start commit or already contained in HEAD or another ref, including during orphan cleanup.
- Reports and proof packs accept the new `preserved` worktree status (a commit is required).
