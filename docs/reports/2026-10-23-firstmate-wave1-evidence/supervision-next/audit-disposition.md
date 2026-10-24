# Haiku round 1 disposition

Requested CLI model: claude-haiku-5-5. Returned modelUsage uses that name; stderr reports unrecognized_model. This records request/response identity only, not independent provider certification. Review was tool-less with disabled hooks/MCP and no persistence.

- F1 P2 overflow IO: confirmed. Non-admitted sources now return read_capacity_exceeded before physical invocation; capacity release permits a later admitted read. Regression first failed, then passed.
- F2 P2 read_pending race: consequence of allowing F1's non-admitted physical slot. Gating IO prevents that legitimate 0-to-1 race. Release tombstone and captured admission guard remain intact; the suggested broad removal of the guard was not applied.
- F3 P2 metadata repair failure: confirmed. Scan now joins allSettled source tasks, allowing healthy peers and notification enqueue after one failed repair. Real SQLite trigger fault regression first failed, then passed.
- F4 P3 malformed stored JSON RPC: confirmed. Bounded nullable object parser returns invalid_payload without physical IO and commit refuses malformed current metadata. Regression first failed, then passed.

Not changed: raw OS IO may not physically cancel; persistent hung reads intentionally consume capacity. Existing source max size remains 1 MiB. Platform/soak and parent daemon stop-before-close integration are separate validation.

Commits e0af02f5 + 6db57e28; final targeted tests 55 passed, CLI build/typecheck/Biome passed. Round 2 completed: F1-F4 all closed; no new confirmed P0/P1. It labeled one P2: an admitted subject can remain read_capacity_exceeded while released subjects still retain the physical-reader slots, and retries on a later RPC/30-second sweep. This is explicitly required by the frozen lifecycle contract (all unfinished physical readers, including released ones, count toward the 100 cap; the reason must be read_capacity_exceeded). It is accepted/documented behavior, not an outstanding defect. No automatic immediate retry is promised, and inventing read_pending would conceal the physical capacity exhaustion.

Audit scope is commits through 6db57e28. The parent later changed notification drainBatch wiring; this audit is not approval of that newer integrated source.
