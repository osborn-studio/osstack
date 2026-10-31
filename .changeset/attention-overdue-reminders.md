---
"@osstack/core": minor
"@osstack/cli": minor
---

Add opt-in reminders for overdue open Attention decisions (migration 48). With `OSSTACK_ATTENTION_REMINDERS=1`, supervision queues at most one reminder per pass for the oldest decision left open past `OSSTACK_ATTENTION_REMINDER_OVERDUE_SECS` (default 1800), repeating with doubling intervals capped at `OSSTACK_ATTENTION_REMINDER_BACKOFF_MAX_SECS` (default 14400). Schedules survive restarts, quiet scopes neither schedule nor reset, and resolving a decision stops its reminders. Reminders reuse the local notification drain under their own delivery IDs and grant no authority. Invalid enabled settings refuse daemon startup. Managed upgrade and the read-only Attention status view now qualify schema 48.
