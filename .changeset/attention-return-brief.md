---
"@osstack/core": minor
"@osstack/cli": minor
---

Add the Attention return brief (migration 49). Postures now record when they were entered; re-asserting the current posture keeps its start. Leaving `away` for `attended` (`attention.posture` / `osstack attention posture`) returns a bounded, read-only brief for the away interval: every decision still waiting on you (oldest first, with age and reminder count, always with total and omitted counts), decisions opened and resolved while away, and first notices or reminders that dead-lettered in the interval (plus undated pre-49 dead letters). `osstack attention return-brief --scope ID --actor NAME [--since MS] [--limit N]` previews it without changing posture. Decision settlements and dead letters are recorded with their time in two new local ledgers. The brief is information only and grants no authority. Managed upgrade and the read-only Attention status view now qualify schema 49.
