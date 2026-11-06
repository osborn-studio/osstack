---
"@osstack/core": minor
---

Add the W13-A host child-process ledger: `engineering_host_processes` DDL (not yet registered as a migration; it takes the next free id after the App E and phase 5 migrations land) with partial unique indexes (one open record per Mission and per remote branch), insert-shape and insert-gate triggers, and triggers that refuse workspace-claim release, `cancelled`, `pr_opened` and clearing `stop_obligation` while any record is not proven stopped. `HostProcessStore` exports the `launching`/`registered`/`release`/`stopped` journal the gated launcher writes through (durable top-level transactions, `host_process_nested_transaction` otherwise), recovery queries, and `settleStopped`, which clears the stop obligation and leaves `stop_unknown` in one owner transaction.
