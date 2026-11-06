---
"@osstack/core": minor
"@osstack/cli": patch
---

Add the revision-chain ledger for the Grok bridge (migration 51): chains, per-head reservations, publication intents, an append-only chain event trail and shadow decisions, with database-level guards (one reservation per head, one in-flight reservation per chain, per-mode grant checks, shadow chains refused any reservation or intent) plus a pure `decideChainStep` state machine and a `RevisionChainStore` whose shadow surface (`shadowChainWriter`) cannot reach the live reservation APIs. The CLI only raises its schema gates (`ATTENTION_READ_QUALIFIED_SCHEMA`, `UPGRADE_QUALIFIED_SCHEMA`) to 51 and counts in-flight reservations and unsettled intents as upgrade holds; nothing reads or writes the new tables yet.
