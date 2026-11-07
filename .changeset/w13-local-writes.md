---
"@osstack/cli": minor
"@osstack/agents": minor
"@osstack/core": patch
---

Contained Mission local git writes (`update-ref`, `worktree add`, real-index `read-tree` and `update-index --refresh`) now run through the gated host-process launcher and its ledger: registered before they can write, released only after the Mission fence passes, and proven stopped afterwards. Restart recovery proves each open record stopped by observation only (it never signals a process); a record it cannot prove puts the Mission in `stop_unknown` and keeps the workspace claim, cancel and obligation clear closed. An interrupted workspace creation ends in `awaiting_decision` (`workspace_recovered`), and the new `resume_workspace` decision verifies and re-materializes it. Stale `index.lock` files left by a killed writer are removed after the proof. The periodic re-check is available as an opt-in host option and is off by default.
