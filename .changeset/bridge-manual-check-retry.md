---
"@osstack/cli": patch
---

Route manual revision check retries through the revision publication port. Closed chains skip delivery and settle pending check intents; successful retries settle their intent and reuse the confirmed result. Refuse revision retries when the publication port is unavailable.

Settle uncertain check intents as failed when their chain is closed, without sending another check or changing the closed chain.
