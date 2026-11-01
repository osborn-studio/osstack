---
"@osstack/agents": patch
"@osstack/cli": patch
---

Contained Missions now fence the host commit itself: `commitPlumbing` accepts a `fence` callback that runs before every worktree write and before the ref update, and the Mission runner's fence refuses once the daemon no longer owns the ledger or the Mission has moved on. Restart drills cover a takeover during an executor turn, a verification, a commit, and each remote mutation.
