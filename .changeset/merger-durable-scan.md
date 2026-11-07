---
"@osstack/core": minor
"@osstack/cli": patch
---

Close the two open Codex round-2 P2 findings of the shadow merger (App E M-C) with migration 55 (`engineering_merger_scans`), additive: one table (`engineering_merger_shadow_scans`), three nullable columns (`scan_id` on cycles and outcomes, `last_poll_at` on watermarks), a partial unique index and five triggers; no rebuild of migration 52's tables.

- Each scan now takes a database-issued scan id (`MergerShadowStore.beginScan`, committed before the scan's first observation). Its cycle row and every outcome it records carry that id, new cycle and outcome rows must name an existing scan (`merger_unknown_scan`), and one scan writes at most one cycle. The comparison report resolves "the detecting scan" by that id instead of the `cycle_after` stamp (the newest cycle when the scan began), so two overlapping processes can no longer attribute an outcome to the other's scan. `recordCycle` takes the scan id first and `MergerOutcomeInput` requires `scan_id`; outcomes written before 55 keep the `cycle_after` path.
- The per-PR poll marker `last_poll_at` is written in the same statement that issues the observation number and only moves forward (`merger_poll_regressed`). The reconciler computes the next hourly closed-PR poll from it (`MergerLedgerView.lastPollAt`), so a restart no longer postpones polling by up to an hour; a PR without a marker still waits one full gap.

The native-upgrade gate and the attention read gate are qualified for schema 55; the upgrade gate additionally requires the scan table, the index, the five triggers and the three columns at 55 and refuses a pre-55 home that already has any of them. Observation fence and ticket semantics are unchanged.
