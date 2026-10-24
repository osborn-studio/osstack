# Q1: local mixed observation soak evidence

This bounded local synthetic slice passed. It is not full capacity qualification. Source: `14574347f6c52047550d46a0629bd87735c598a8`, clean source manifest; Node `v22.22.1`, darwin 27.0.0 arm64, Apple M4, local APFS. Shared host, no isolated baseline. Wall-clock timestamps: 2026-10-23T21:11:25.037Z to 2026-10-23T21:21:44.029Z.

## Workload actually exercised

- Real AF_UNIX framed daemon socket; daemon embedded in the same Vitest process as the fixture, client, and producer. Host health and Graph caller registration use explicit trusted test fixtures. No production home or real provider. Short socket symlink points into explicit scratch home and is removed after shutdown.
- 10 scopes / 100 admitted subjects: 30 session sources + 50 run sources + 20 on-disk Loop snapshots. Each session-bearing run counts once in each corresponding source type. All stayed admitted.
- 600.061 seconds active mixed traffic, 10091 newly appended run events plus 50 seed events; 10 ten-event bursts on one hot run. 589 session version updates and 295 atomic Loop snapshot replacements.
- 12001 readonly socket requests (target 20/s), cycling recovery, session status, run status, Graph status/result, and inbox. 0 RPC errors; 0 blocked fetch attempts. Triage disabled, adapters empty except explicitly registered synthetic Graph writer/reviewer, no publication provider.
- Two real artifact-only Graph deliveries completed during setup with synthetic workers and actual frozen candidate/reviewer/acceptance paths. Their stored status/result were queried continuously during measurement. Graph execution and cold worker startup were **not** under measured traffic. Source HEAD and tracked answer stayed unchanged.
- Facts were appended through the run repository helper, with synthetic direct session-version writes and atomic snapshot replacements. No dirty hint was injected after setup: the real 30-second timer had to discover changes. This intentionally measures the conservative polling fallback, not daemon event-ingestion latency.

## Latency

Whole-window socket round trip: p50 0.574 ms, p95 2.206 ms, p99 3.582 ms, max 17.706 ms. Includes socket creation/framing/client scheduling. Raw per-call samples are preserved.

| Method | Socket count | Round trip p95 / max ms | Internal recent p95 / lifetime max ms |
|---|---:|---:|---:|
| `attention.recovery` | 2001 | 3.412 / 8.057 | 1.194 / 3.966 |
| `session.status` | 2000 | 1.684 / 4.880 | 0.424 / 1.231 |
| `run.status` | 2000 | 1.182 / 4.846 | 0.215 / 0.760 |
| `graph.status` | 2000 | 2.169 / 9.597 | 0.604 / 1.781 |
| `graph.result` | 2000 | 2.148 / 17.706 | 0.628 / 1.845 |
| `attention.inbox` | 2000 | 2.320 / 7.066 | 0.711 / 2.005 |

The internal recorder reports p95 over its last 512 observations per method, while its max is lifetime (including setup). Those are not whole-window internal percentiles. `attention.watch`, `attention.loop`, and Graph start setup timings remain in the raw daemon stats and are excluded from the readonly sustained-load gate. No product timeouts or thresholds changed.

## Fairness and convergence

Every one of the 50 run sources reached its exact final emitted sequence; every one of 30 session sources reached its final source version; every one of 20 Loop sources matched its last snapshot. No run sequence gap was reported. Per-source produced/projected counts and delays are in summary.json, and final SQL cursors plus source watermarks are separately preserved.

Run-event observation delay p95 28.619 s / max 30.214 s; session-version observation delay p95 28.627 s / max 30.051 s. Sampling adds up to approximately 250 ms. After the producer stopped, final convergence took 18.942 s. Version supersession does not prove that every transient session state was retained; Loop snapshots are explicitly lossy and only their final state is asserted. All run completeness fields remain `complete:false` / `unverified_retention`.

## Resource evidence

Peak sampled RSS 238.84 MiB; combined fixture/client/daemon process CPU 19.976 s (3.33% of one core over the active interval). This is not isolated daemon CPU. Event-loop delay p95 12.231 ms / max 22.184 ms at 10-ms monitor resolution; that monitor is not a Loop-engine tick measurement. DB 3457024 bytes / WAL 4161232 bytes. Observer step timings: {"count": 212, "p50_ms": 2.6844169999822043, "p95_ms": 5.2529170000052545, "p99_ms": 5.581833000003826, "max_ms": 5.641334000043571}; includes discovery and SQLite and is not pure reduction cost per event.

## Remaining qualification gaps

No real provider/user workload, actual approval/clarification decision cycles, active concurrent Graph execution during sampling, Linux host, cross-process client contention, long retention proof, 1000-discovered/100-admitted overflow exercise, CI polling, notification-age measurement, or equivalent workload A/B Loop-engine overhead measurement. No `<1%` Loop tick claim and no pure reducer `<1 ms/event` claim. This one 100-subject point cannot establish maximum capacity. Existing deterministic tests and this soak support different claims. Full original R8/Q1 qualification remains partial.

## Reproduce and evidence

`soak.test.ts`, `vitest.config.mjs`, and `manifest.json` freeze the source/harness/environment. Use Node 22 and the recorded command, with a **fresh SOAK_TAG** to avoid reusing a previous synthetic home. Set SOAK_DURATION_MS=600000. `full.log` is the original test runner output; `full/rpc-samples.json`, `full/observer-steps.json`, `full/daemon-stats.json`, `full/summary.json`, `full/final-source-evidence.json`, and `verdict.json` preserve raw/derived evidence. `preflight` was a separate 2-second harness sanity run and is not counted in the ten-minute result. No source changes or feature commit were made.
