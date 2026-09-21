# Bounded G25 process slice report

Baseline: 9d02679 on codex/graph-runtime-foundation. Worktree: /Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation. No commits, merges, pushes, original-checkout writes, or documentation edits by this actor. Parent's concurrent changes are left intact. No subagents spawned.

Interface decisions were written to process-interface.md before broad implementation. Read AGENTS.md, G25/F01–F12, graph-public-next-context, and process-feedback.md. Incorporated parent-adjudicated core not_started gate and late-finalExit DB barrier. Final feedback checked before finishing.

## Implemented

- New graph-process-identity.ts: Linux /proc start ticks + boot ID + PGID identity, read-only comparison/observation, no signaling. macOS ps lstart is explicitly coarse/unverifiable; errors/permissions/mismatch remain unknown. execFileSync argv only, no injected shell probe.
- GraphWorkerManager snapshots trusted synchronous lifecycle callbacks. Runtime durable launch intent is committed before registration/spawn. PID, assigned isolated PGID, OS identity result and capture time are committed before init. Failure of launch persistence prevents init. Detached workers have their own POSIX process groups. Live stop continues to signal only its authenticated direct ChildProcess, never a recovered numeric PID/group.
- Migration 34 adds immutable, append-only graph_worker_process_events with per-generation event kinds. Runtime persists actual no-child registration/spawn failures only for the attempt that consumed that generation. A duplicate launch rejection cannot append a false no-child receipt over the original launch. True exit and bounded exit_unconfirmed are separate rows.
- Host-only GraphRuntime.observeWorkerProcess(binding) is wired to the journal and independent OS observation. Checks exact scope/run/generation/owner/program identity; returns launch and historical observations, leader observation, executors unknown and recovery held. Never signals, resumes, releases, or changes a generation. Historical stopped:true or lease expiry never supplies executor proof.
- Runtime DB drainage now includes finalExit as well as action/checkpoint promises, so late event journaling cannot cross the SQLite lifetime barrier.
- Per parent feedback, core G15 not_started now requires exact durable spawn_failed evidence when the generation has a consumed launch: owner, program identity, run, generation, evidenceRef, confirmedAt, phase, and absence of contradictory events. Existing trusted synthetic scenarios without consumed launches remain unchanged. No core -> CLI import. G15 is still the only recovery authority.
- New real host SIGKILL test uses actual runtime, SQLite, graph worker, same-group descendant and detached descendant. A fresh independent host observes the original launch before any observed worker exit. Duplicate launch cannot overwrite observations. Both descendants continue writing after leader kill; executor outcome remains unknown/held. Dedicated fixtures only; no public recovery surface.
- Tests also cover durable registration failure/reopen, actual executable ENOENT, changed program identity, fake PID/start/boot/group mismatch, actual platform probe, pre-spawn crash window, timeout followed by true exit, DB barrier, and pre-init persistence failure. Existing manager stale-generation connection tests remain passing.

Owned source files:
- packages/cli/src/graph-process-identity.ts + .test.ts
- packages/cli/src/graph-process-journal.ts + .test.ts
- packages/cli/src/graph-worker-manager.ts + .test.ts
- packages/cli/src/graph-runtime.ts
- packages/cli/src/graph-faults.integration.test.ts
- packages/cli/src/graph-process-fixture.ts
- scripts/fixtures/graph-process-host.ts
- packages/core/src/state/migrations.ts
- packages/core/src/state/graph-recovery.ts + .test.ts (additional ownership explicitly authorized in process-feedback.md)

## Validation commands and results

Every shell invocation used:

    export OSSTACK_HOME=/Volumes/AIMATE_WORK/tmp/g25/actor-home TMPDIR=/Volumes/AIMATE_WORK/tmp/g25

Final commands:

1. pnpm --filter @osstack/cli exec vitest run src/graph-process-identity.test.ts src/graph-process-journal.test.ts src/graph-worker-manager.test.ts src/graph-faults.integration.test.ts
   PASS: 4 files / 41 tests. Log: process-targeted-final.log.
2. pnpm --filter @osstack/core exec vitest run src/state/db.test.ts src/state/graph-recovery.test.ts
   PASS: 2 files / 52 tests. Log: process-core-final.log.
3. pnpm --filter @osstack/core build
   PASS (repeated after migration and G15 edits). Log: process-core-build.log.
4. pnpm --filter @osstack/cli exec tsc --noEmit
   PASS. Log: process-typecheck.log (empty on success).
5. pnpm --filter @osstack/cli exec vitest run src/graph-chain.integration.test.ts -t 'assembly:|module:|^uses real|^rejects asynchronous|^keeps a database'
   PASS: 17 selected tests, 13 daemon cases excluded. Log: process-chain.log.
6. pnpm --filter @osstack/cli exec vitest run src/graph-chain.integration.test.ts
   17 passed / 13 failed, all 13 failures are daemon socket listen EPERM in this sandbox, before daemon workflow execution. NOT a full graph-chain pass. Log: process-chain-full.log. Parent must rerun these in its permitted runner.
7. git diff --check
   PASS. No commits performed.

Incremental checks:
- Identity test first failed because module did not exist, then 3 passed.
- New manager -t 'records the authenticated|never sends init|records consumed': first 3 failed, then 3 passed; final complete manager file: 30 passed.
- Core consumed-launch receipt cases: six negative cases initially failed (incorrectly accepted), now complete recovery file 30 passed.
- Journal first pass had two test-fixture errors (invalid lease timestamp violated existing DB constraint; cancellation before program loop actually began). Corrected tests use virtual clock and observed program marker; final journal file 7 passed. No timeout inflation.
- Initial fixture exported inferred return type caused TS4058; explicit interface fixed it. Final CLI typecheck clean.

Command-routing incident: the initial `pnpm --filter @osstack/cli test -- src/graph-process-identity.test.ts` unexpectedly ran the CLI package suite because the extra `--` did not filter Vitest. Interrupted with SIGINT as soon as observed; this was not a completed global/monorepo suite. Subsequent invocations all used explicit `pnpm --filter ... exec vitest run <files>`. That accidental run also showed daemon socket EPERM. No results from that run are claimed as acceptance.

## Truthful boundaries / remaining parent work

This is a safe diagnostics slice, NOT full G25 acceptance or general crash recovery.

- Opaque adapter/external effects and escaped descendants cannot be independently proven stopped from worker/group observations. The new observer always returns executor unknown + recovery held, even after leader absence or historical exit/no-child receipts. It provides no recovery attestation and never calls G15 automatically.
- macOS lstart seconds cannot prove PID continuity. Current sandbox additionally denies /bin/ps. Actual macOS child lifecycle was exercised, but independent OS identity is explicitly unavailable/unverifiable. No same-PID safety claim is made. Linux exact /proc path and the real Linux-only identity assertions were not exercised on this macOS host; fake identity mismatch comparisons did run.
- Crash after intent but before launch identity remains unknown. No inference from empty ledgers or expired leases.
- Live-process/daemon SIGKILL durability is tested against SQLite WAL. Host reboot/power-loss durability is not claimed; existing DB synchronous=NORMAL was not changed.
- Stop barrier may wait indefinitely for actual worker finalExit, just as it must wait for unresolved host DB users. Bounded timeout cannot authorize DB close or effect release.
- Source policy code is untouched; action/checkpoint drainage regression passed. Parent owns broader source-policy, artifact, concurrency, matrix and full acceptance checks.
- Full daemon graph-chain regression requires a runner allowed to bind local sockets. All sandbox failures are explicitly recorded, not masked or skipped in the full attempt.
