---
"@osstack/agents": patch
"@osstack/loop": patch
---

Pin isolated-worktree landing to the accepted commit. `mergeWorktree` accepts `{ expectedCommit }` (a full commit id), refuses when the task branch no longer points at it, and fast-forwards that exact object instead of the movable branch name. The loop passes the commit it made from the verified tree, so commits added to the task branch after acceptance cannot land.
