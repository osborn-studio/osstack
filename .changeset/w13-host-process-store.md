---
"@osstack/core": minor
"@osstack/cli": patch
---

Add the W13-A host child-process ledger as migration 54 (`engineering_host_processes`): partial unique indexes (one open record per Mission and per remote branch), insert-shape and insert-gate triggers, and triggers that refuse workspace-claim release, `cancelled`, `pr_opened` and clearing `stop_obligation` while any record is not proven stopped. `HostProcessStore` exports the `launching`/`registered`/`release`/`stopped` journal the gated launcher writes through (durable top-level transactions, `host_process_nested_transaction` otherwise), recovery queries, and `settleStopped`, which clears the stop obligation and leaves `stop_unknown` in one owner transaction. `containedUpgradeHolds` now also counts every open record directly. The attention read gate is qualified for schema 54; the native-upgrade gate is too, and additionally requires the table and all fourteen triggers at schema 54 (a pre-54 home that already has them is refused).
