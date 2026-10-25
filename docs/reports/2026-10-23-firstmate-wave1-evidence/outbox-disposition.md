# Bounded local outbox audit disposition

The first static challenge identified caller cancellation consuming the five-failure budget (P1). The final code restores that attempt, records `delivery_cancelled_indeterminate`, and reports cancelled separately. Six repeated cancellations and owner change have executable regressions. The second audit confirms no P0/P1. Fifteen focused tests passed.

The final loop termination reason is no longer overwritten solely because time elapsed during accounting. Completion uses owner and receipt CAS; ownership change returns stale for that receipt. Historical delivered means the sender acknowledged that version; it does not assert the item is still current. Quiet posture intentionally pauses the whole local-owner scope; there is no per-recipient transport.

Remaining limits: process death consumes the interrupted attempt, whereas graceful cancellation preserves it; startup recovers `sending` after claiming the new owner. A later claim can reject after an owner change, so callers catch and retain persisted state. Async abort cannot unsend an artifact or cancel synchronous code; retries require the same local idempotent delivery ID. This is not public-message delivery qualification. `remainingDue` excludes in-flight rows and includes projections that may be superseded at claim. `oldestDueAt` is the oldest currently overdue eligible row.

The daemon integration aborts its batch on stop, then awaits delivery and scan promises before closing SQLite; integration tests exercise ordering. The initial broader core invocation loaded a draft test with a missing owner-instance argument; its failure is preserved in scratch, and the corrected focused test passed. This is not reported as an initially green full suite.
