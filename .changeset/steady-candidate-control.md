---
"@osstack/core": minor
"@osstack/cli": minor
---

Bind new candidate executions to worker identities and fence controlled writes after a durable stop request. Add `improve stop` and a complete `improve baseline` export. Indeterminate execution outcomes retain active occupancy instead of allowing an unsafe retry.

Core clients must pass the worker returned by `claim` to `recordWorktree` and `complete` for new executions. Pre-migration unowned records remain readable. Schema 26 requires a backed-up, coordinated upgrade; stopping is cooperative and does not attest to OS process termination or enable recovery.
