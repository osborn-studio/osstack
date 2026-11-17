---
"@osstack/core": minor
"@osstack/cli": patch
---

Add immutable Mission lineage as migration 56 and a single transactional registration entry for derived Missions. Roots record depth zero; derived Missions inherit their origin and increment parent depth; superseding preserves lineage. Registration supports idempotent recovery and waits when historical lineage is missing or contradictory. Route CI repair and review revision children through this entry without changing repair limits. Qualify the attention and native-upgrade readers for schema 56, including checks for the lineage table, indexes and triggers.
