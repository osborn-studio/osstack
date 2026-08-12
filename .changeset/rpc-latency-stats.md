---
"@osstack/cli": patch
---

`osstack stats` now reports per-method daemon RPC latency (p50/p95/max over a sliding ≤512-sample window, sorted by descending p95). The record path is O(1) and allocation-free after warm-up; percentile computation is deferred to the stats call. This gives bulk-API work (Performance Hints plan P2) measured offenders to target. AGENTS.md gains a Performance Budgets section documenting the CI-enforced startup budgets and the daemon RPC p95 < 10ms target.
