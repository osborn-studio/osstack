---
"@osstack/core": minor
"@osstack/cli": patch
---

Add the App E shadow-merger core for the Grok bridge (migration 52): a per-PR observation fence (`issued_seq`/`accepted_seq`, DB-issued numbers instead of wall-clock ordering, so a late stale observation is refused even after a deduplicated one), an append-only decision change sequence, outcome segments (`closed_unmerged` may go straight to `merged`; nothing is accepted after a merge), a cycle table, a `MergerShadowStore` whose writer surface is three methods, and the pure `evaluateMergeGates` (gates G0–G8 incl. G4b, every failing code returned, `unevaluated` for incomplete reads) with the two open owner decisions exposed as typed options defaulting to the strict choice. The CLI only raises its schema gates (`ATTENTION_READ_QUALIFIED_SCHEMA`, `UPGRADE_QUALIFIED_SCHEMA`) to 52 and requires the four new tables before an upgrade; nothing reads or writes them yet.
