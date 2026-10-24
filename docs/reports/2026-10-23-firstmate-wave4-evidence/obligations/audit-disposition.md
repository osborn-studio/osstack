# O1 Haiku round 1 dispositions

F1: state and version are existing DB CHECK-protected, but updated_at can still be malformed. Confirmed reachable via negative updated_at; RED test added. currentSource maps source validation failure to missing (not DB failure), preserving list/draft/waive; new create still rejects invalid source. Identity/scope mismatches remain missing. No fallback to foreign source.
F2: drafted events now persist the entire bounded draft object, including exact text, raw UTF-8 SHA256, source snapshot, unsent flag. Re-draft history test proves both old/new text retained. Independently changed draft content digest from JSON string hash to exact text-byte hash with RED test.
F3: operator fields now require at least one non-White_Space/non-Control/non-Format character. Existing explicit byte caps retained; control-heavy meaningful data still safely escaped.
F4: valid write clocks clamp to prior timestamp; create clamps to last write in same repo. Backward clocks do not strand manual waiver. Cursor is non-snapshot and ties/new insertions can still require fresh listing, documented.
F5: terminal responses omit pending draft text (archived in immutable event and retained DB row), preventing duplicate body expansion. Create computes conservative maximal terminal response including largest allowed source/time/revision/actor/reason encodings and rolls back if it cannot fit. Full original promise remains. Test exercises maximal control-heavy draft then waiver and retention. No response cap bypass.
F6: accepted trust boundary; local DB owner is authoritative and could forge storage. Documented append-only as API/trigger retention, not cryptographic tamper-proof ledger. No model/public-message write path.
F7: removed misleading Released adjective; actual migration44 is registered after43. Added checksum test for exact immutable SQL lineage. Audit invented gitStatus visibility despite no tools; independently checked source and real git status ourselves rather than treating its process claim as evidence.

withWrite uses SQLite deferred transactions. Successful mutations are atomic with rollback, and CAS/UNIQUE prevent overwrite. Contended callers can receive a bounded database error and should retry the same key/revision after inspecting state; no promise that concurrent retries all return duplicate in one attempt. Actual43→44, readonly failure, two-connection stale CAS, escaped output/cursor scope tests passed.

## Final delta result

Haiku round2 explicitly returned no confirmed P0/P1. Residual P2 dispositions:
- P2-1 repo-wide overdue_count is intentional and already documented (independent of page state filter).
- P2-2 monotonic write timestamps are logical ordering, not certified wall time. Forward jumps remain visible rather than rewriting sealed history; caveat explicit.
- P2-3 draft may fail its bounded response; safe rollback is intentional. Unlike the fixed stranded-terminal issue, create reserves terminal capacity and waiver remains reachable.
- P2-4 manual means waiver-only. A caller assertion is not trusted condition evidence; explicitly documented.
- P2-5 owner-modified invalid stored data can produce generic database_unavailable; service and CLI do not autoretry. Input-valid sources/rows are schema checked before creation. Direct DB owner tampering is outside authenticated API guarantees.
- Migration registration/hash was outside supplied delta source; actual 43→44 tests and exact SQL checksum test independently pass.

No runtime changes after final delta review. Documentation clarified retained limits. CLI emitted unrecognized_model warning, with result modelUsage claude-haiku-5-5; this records invocation metadata, not independent backend identity verification.
