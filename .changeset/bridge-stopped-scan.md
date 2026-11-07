---
'@osstack/core': patch
---

Add a bounded stopped live chain scan that records changed PR facts and closes chains when their PR is merged or closed. Observations include `head_repository` and `head_ref`. A scan close voids active reservations in the same transaction and reports the current child Mission and voided heads; the 5-E caller must request child cancellation for each closed entry. A stopped-chain cursor index is deferred because it needs a database migration.
