---
"@osstack/core": minor
"@osstack/cli": patch
---

Add migration 50 with an additive contained-Mission ledger: Missions, append-only events and workspace claims, behind a `ContainedMissionStore` that enforces the W11 state machine, candidate binding, repair-cycle limits and stop evidence. Managed upgrade and the attention read model qualify schema 50, and in-flight contained work counts as an upgrade hold.
