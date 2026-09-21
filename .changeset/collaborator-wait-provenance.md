---
"@osstack/protocol": minor
"@osstack/agents": minor
"@osstack/loop": minor
"@osstack/cli": minor
"@osstack/core": patch
---

Add versioned session continuation requests and durable waiting diagnostics.
Parsing an agent-reported request does not authorize automatic continuation.
Track resumed sessions during daemon drain and
cancellation, and preserve uncertain delivery receipts in status output.

Keep improvement proposal identities and reviewed history stable. Gate-only checks
no longer claim that a candidate was applied. Migration 23 preserves legacy lesson
counters and records explicit failure observations without claiming effectiveness.
