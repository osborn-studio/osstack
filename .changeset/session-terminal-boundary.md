---
"@osstack/cli": patch
---

Reject Session start streams that end without a successful terminal event. Session send already rejected such streams; it now requires existing adapter stop confirmation before releasing their writer lease. Both paths retain admission when stop is unconfirmed. Normal completed streams still release without stop confirmation.

Replaying the original request does not invoke the adapter again. A failed Session send replays as delivery_uncertain. For Session start replay, RPC ok means that the stored snapshot was read successfully; clients must check state, which can still be failed or starting.

Tests use real local RPC and SQLite with a deterministic adapter, including daemon restart in the same process. This change does not qualify live provider stop behavior or add a recovery API. Cross-process retained-hold visibility and recovery remain pending in DEBT02.
