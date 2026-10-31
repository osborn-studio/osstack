---
"@osstack/agents": patch
"@osstack/github": patch
---

Request all untracked files explicitly when deciding whether an isolated loop worktree has work to commit and whether a GitHub delivery candidate is clean. Repository config such as `status.showUntrackedFiles=no` no longer makes untracked-only work look clean, so it is committed instead of being discarded with the worktree, and delivery refuses instead of publishing a PR that omits it.
