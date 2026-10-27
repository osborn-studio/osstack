---
"@osstack/cli": patch
---

Reject Session start and send streams that end without a successful terminal event. Require existing adapter stop confirmation before releasing their writer lease; retain admission when stop is unconfirmed. Keep the failed receipt and replay it without invoking the adapter again.

Tests use real local RPC and SQLite with a deterministic adapter, including daemon restart in the same process. This change does not qualify live provider stop behavior or add a recovery API. Cross-process retained-hold visibility and recovery remain pending in DEBT02.
