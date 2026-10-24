# Active Graph + supervision qualification

This is an opt-in executable local qualification (`scripts/bench-supervision-active.mjs`), not a finished-Graph read-only soak. It starts actual Graph engine processes and actual Node adapter children, holds a child live during supervision/Loop/socket load, then observes actual completion and separate actual cancellation/process-group stop. A fresh Graph service re-reads durable cancelled state without starting another child. Supervision stop/restart rejects old owner access and discards an actual-file read that finishes after its owner stops. Sixty retained session fixtures create mixed observer load; they are explicitly synthetic, not live providers. No model/provider/network message is sent.

## First stress measurement — budget FAIL, functional assertions PASS

At20ms dirty interval (50Hz), on the shared development machine concurrently running root QA and this agent's Graph regressions:

-790 real socket samples; p95=21.847ms, max=722.072ms. Target<10ms was **not met**.
-6 Loop cycles,5,000ms scheduled idle,5,321.614ms measured wall; overhead6.0435%. Target<1% was **not met**.
-Observer step p95=5.848ms, max19.517ms. The5ms slice is soft and was exceeded.
-Actual Graph completed; second actual child cancelled and stopped; released admissions=0held; supervisor generations1→2; stale owner/read rejected.

The earlier RED run's adapter fixture returned unconfirmed before its own pending child-stop proof had settled. Its `confirmStopped` now awaits its real pending shell result, matching the adapter contract. Production cancellation thresholds were **not changed**.

The harness defaults to100ms dirty cadence for the next normal-cadence measurement and accepts `OSSTACK_SUPERVISION_DIRTY_INTERVAL_MS=20` to reproduce saturation. No threshold is relaxed. Raw requestScan durations include coalesced requests waiting for quiescence; they are not per-pass CPU duration. Additional per-tick timing distinguishes work from scheduler delay without replacing the original wall-overhead gate. Final isolated measurement is pending the root full-QA window.

Run with an explicit scratch OSSTACK_HOME and OSSTACK_SCRATCH_ROOT; use a short scratch TMPDIR for Unix sockets. Output reports retain samples and independent function/budget conclusions. Live model/Docker/remote-provider behavior and cross-platform qualification remain unmeasured. Final external audit is blocked on the root's CLI authentication; this report does not claim an audit pass.


## Normal cadence diagnosis and production correction

All four runs use the unchanged 100ms dirty cadence, 60 explicitly synthetic retained sessions, actual Graph adapter processes, and the original RPC p95 <10ms / Loop wall overhead <1% gates. Root CLI QA was concurrently using the same development machine; these are **shared-host measurements**, not isolated performance certification. Round 2 also overlapped the scout typecheck. Failed samples are retained.

| Run | Code | RPC p95 ms | Loop overhead | Result |
| --- | --- | ---: | ---: | --- |
| 1 | Original per-subject commit, 5ms scheduling slice | 17.950 | 1.257% | fail |
| 2 | One transaction per bounded slice, 5ms scheduling slice | 11.902 | 0.735% | fail: RPC |
| 3 | Bounded transaction, stricter 2ms scheduling slice | 7.385 | 1.264% | fail: Loop |
| 4 | Same code as 3, repeat | 7.054 | 0.829% | pass |

The production observer now amortizes disk-space preflight and commit over a bounded slice. It still checks time before every subject; per-subject savepoints retain poison-source isolation, and owner, scope, revision and explicit release checks remain. A failed outer transaction rewinds its in-memory subject cursor so a retry does not skip uncommitted evidence. The new real SQLite trigger regression fails the second subject after the first was sampled, verifies rollback, removes the fault, and verifies both sources are projected on retry. It was observed RED before the change, then GREEN with the existing attention tests (48 total).

The daemon schedules a stricter 2ms slice because one socket round trip crosses multiple event-loop turns. The observer's public soft ceiling remains 5ms; the RPC and Loop acceptance budgets are unchanged. No cancellation deadline or authority boundary was relaxed. The shared-host repeat demonstrates improvement but does not establish three consecutive isolated passes. Those measurements remain pending the root full-test window. Raw per-tick timing shows actual Loop work plus I/O waits separately from scheduler excess; it never replaces the original wall-overhead gate.


Independent read-only review by the completion-upgrade agent found no new reproducible P0/P1 in this correction. It checked nested savepoint isolation, rollback cursor restoration, owner fences and SQLite writer exclusion. It correctly noted that 2ms is a soft check before starting each subject, not an absolute limit on discovery, one subject, or commit. This independent code review is not a Claude audit. The reviewer did not claim to rerun the tests. Service lifecycle tests passed 24/24; strict CLI typecheck and four-file Biome check also passed (raw logs included).
