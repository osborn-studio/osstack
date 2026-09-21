---
"@osstack/protocol": minor
"@osstack/autonomy": minor
"@osstack/core": minor
"@osstack/agents": minor
"@osstack/cli": minor
---

Add signed, finite phase continuation for the controlled no-tools planning/review
session runtime. Bind frozen output checks and instructions to the exact session,
runtime policy, owner key, initial turn/version, deadlines and cumulative budgets.

Migration 24 persists grants and attempts alongside existing session receipts.
Revoke stops subsequent actions; crash recovery never automatically resends an
uncertain accepted delivery. Add collaborator inspect/draft/sign/install/status/revoke
commands. This does not grant code execution, GitHub approval, merge or deployment
powers to unrestricted agent sessions.
