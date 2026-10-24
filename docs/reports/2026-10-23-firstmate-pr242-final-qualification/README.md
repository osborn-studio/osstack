# PR #242 final local qualification

Production/test source `317c2070ee9c5b1b8b1ec5dbaa90ad9008a5894c`. All eight local stages passed; **5204 tests passed / 3 existing skipped across 22 packages**. Native OSStack task `firstmate-wave5-raw-final-qualification` and Loop verifier passed with zero issues. Full command records, final output and prior attempts remain here.

Earlier source snapshots passed 5,183 and 5,192 tests respectively. The final raw-blob gate adds a stat-cache regression and raw-byte cases. Those earlier results are not final-source qualification. Initial remote CI40022366557 failed inventory freshness; 7e5e7f10 committed the missing generated export entry.

Root Haiku rounds1–4 are preserved. Confirmed issues were repaired: unknown host outcome exits2, envelope binding and hidden index flags, and raw-byte/mode scope checking before candidate persistence. The fourth narrow challenge reported zero confirmed P0/P1. Original failed assertions and all review findings remain preserved. Scope is bounded local Graph implement/local_verified/artifact_only, one registered check. Raw scans intentionally remain at every pre-freeze boundary; multiple whole-tree reads are a performance limitation, not memoized via unsafe stat caches.

SSH real-machine qualification, live providers, active Graph mixed capacity and Loop tick budget remain separate. CLI requested claude-haiku-5-5; modelUsage agrees but stderr unrecognized_model prevents independent provider-weights attestation. Static reviews did not execute tests.

The final documentation commit has no production changes. Exact-head remote CI must pass before this PR is marked ready. No merge/deployment was performed.
