# G17 actor handoff — experimental C5 assembly

Implementation left for parent review/acceptance. No task statuses, AGENTS, user docs, migrations, package exports, G14/G15/G16 sources, broker, checkpoint service, governed execution or autonomy edits by this actor. No nested agent/Loop, commit/push/merge/deploy. Parent owns integration and final acceptance; this handoff does not mark G17/C5 complete or production ready.

## Owned source and API

- `packages/cli/src/daemon.ts`: narrow type-only/lazy graph runtime wiring, shares existing daemon DB/broker/checkpoint service, closes graph runtime before DB close. Existing checkpoint bindings preserved. Explicit `handles.graphRuntime(configuration)` is single-use; repeated configuration rejects, preventing multiple supervisors in one daemon. No graph CLI/RPC or default user write admission.
- `packages/cli/src/graph-runtime.ts`: `GraphRuntime({db,broker,checkpoints,programs,workerOptions?,drainTimeoutMs?})`; `prepare(request,version)`, generation-zero-only `claim(run,owner,leaseExpiresAt)`, `start({request,run,programId,registration,authorize,resume?,leaseDurationMs?})`, concrete `reconciler`, `stop(connection,reason?)`, `observedExit(connection)`, `close()`.
- `packages/cli/src/graph-chain.integration.test.ts`: currently 29 tests; real process/SQLite/command/retained worktree/freeze integration and module lifecycle regressions.
- `scripts/fixtures/graph-chain-host.ts`: narrowly dedicated trusted test host, bundled from real source by esbuild. Daemon mode invokes actual startDaemon; assembly mode uses actual same DB/broker/checkpoint/runtime modules without socket, distinctly named and reported.

Exact contract and amendments: `G17-interface.md`. Source SHA256 and final fixture root list: `G17-source-manifest.json`.

Runtime start fixes full scope/program/generation/owner; every manager authorization invokes both synchronous host/registration revocation checks and reloads durable state. Rejects cancellation/terminal/waiting states and expired original deadline. Optional renewal synchronously reads+renews the actual lease, never resets budget or deadline. No whole-run writer permit. Parent migration29 launch consumption is recorded atomically inside the manager register callback after program/input validation; duplicates fail before child spawn, even after new DB connection/new manager. Recovery generations must appear in the concrete G15 takeover journal.

Stop retires broker/checkpoint ports, aborts the worker signal passed to real broker calls, and boundedly waits for manager OS evidence plus actual per-connection broker promises. `actionsSettled` is only drainage, never independent executor-stop proof. Pending broker calls/unknown effects retain real canonical locks. `finalExit` subscription captures a later actual OS exit in `observedExit`; earlier bounded exit/stop results remain unconfirmed. Runtime never converts worker flags into stop proof. Authenticated no-child phase='spawn' evidence is exposed but automatic no-child recovery is not implemented here; phase='registration' duplicate failure is never absence proof.

## Real chain and recovery evidence

Static trusted selfcontained registered program uses Functional context.task('implement') then context.task('freeze') with bounded context.action IPC. G14 hashes/snapshots exact source. Actual broker runs G04 registered command, externally appends once and modifies a retained G16 worktree. Host saves exact G04 candidate/command evidence; freeze verifies command process-group receipt, ledger executionRef suffix matching actual G04 execution.run_id, exact workspace, confirmed implementation, and actual lease. G16 verifies/restores selfcontained bundle into a fresh repository.

The fixture has no MemorySaver, fake checkpoint backend, alternate node scheduler, fake broker/counter execution, or public fault knobs. External command append log and task-function reentry log are separate. Tests assert two durable actionStarts, confirmed outcomes, one command append, and exact function reentry counts.

Deterministic windows:
1. Actual broker confirms effect in SQLite; trusted fixture withholds action response before worker RETURN. Snapshot asserts zero implementation RETURN rows; recovered worker re-enters implement but ledger replays result, append remains one.
2. Implementation task RETURN committed, final checkpoint held before real service COMMIT. Snapshot asserts implementation RETURN exists and no final candidate checkpoint; recovered tasks reuse saved RETURN.
3. Final checkpoint actually COMMITted, ACK withheld. Snapshot asserts final candidate checkpoint exists; fresh worker/saver uses persisted result.
4. Restore and repeat SIGKILL before RETURN a second time: three implement function entries, one command append, two total ledger actions.
5. Old-generation opaque broker connection rejects after retirement/takeover.
6. Cancel stops real command process group; abort/SIGTERM-ignoring graph worker is SIGKILLed; no freeze node. Stubborn command produces actual unproven G04 cancellation, unknown ledger and retained lock even after broker drainage and later independently observed command OS death.
7. Actual broker persist Promise deliberately held: stop returns actionsSettled=false, recovery refuses until original call drains; snapshot is then refreshed before G15 proof.
8. Original immutable deadline expires during real command, supervisor heartbeat aborts it.

Real G15 reconciler tests use observed G14 exit and independent exact G04 receipts plus G16 quarantine. Unknown never automatically resends. Applied/not_applied are independently checked against actual deterministic command output/unchanged workspace. Applied release failure leaves durable confirmed decision and real lock, then same receipt replay re-verifies and releases without rerunning. No broker false-return implies unlocked: fixture checks persisted canonical lock and, only for exact matching dead prior-daemon owner, invokes parent releaseReconciledRepoWriteLock with G15 reverify inside guard.

True daemon process restart cases **stop and drain the graph worker first**, persist actual supervisor evidence, then the test parent observes SIGKILL exit of the separate daemon host process. New daemon process opens the same SQLite/retained worktree/artifact/canonical lock paths, verifies old daemon PID dead and receipt full scope/program identity, uses concrete G15 takeover, launches new worker. Second restart case begins with unknown retained lock, commits applied decision, injects release failure, then retries exact guarded dead-daemon lock release before takeover/freeze. These are not crashes with an unobserved live old worker or arbitrary escaped executor; that broader claim is not made.

## Actual validation and logs

Every actor verification command set `OSSTACK_HOME=/Volumes/AIMATE_WORK/tmp/gc5/home TMPDIR=/Volumes/AIMATE_WORK/tmp/gc5`; portable-source launcher override `G17_TEST_HOME=/Volumes/AIMATE_WORK/tmp/gc5/home` restores that exact OSSTACK_HOME after Vitest's hermetic setup. Default source uses unique temporary roots/home/build paths, with no machine-specific paths committed. Raw fixture roots/logs stay under gc5 for inspection.

- Initial missing module TDD red: `G17-red-module.log`; initial real child+SQLite green: `G17-green-module.log` (2 tests).
- Durable same-generation relaunch red → green: `G17-red-launch-consumption.log`, `G17-green-launch-and-chain.log`.
- Original deadline red: `G17-red-deadline.log`; green covered by final focused run including actual in-flight deadline.
- Late actual-exit subscription red: `G17-red-late-exit-2.log` (correct reproduction, previous observation stayed unconfirmed after OS SIGKILL); first attempt `G17-red-late-exit.log` exposed fixture abort before handler setup and is retained honestly. Final green below.
- `G17-chain-first-full.log`: earlier 6 pass / 3 fail; two are actual Unix socket EPERM here, one was double-crash transport hook placement. Fixed hook is now broker response after confirmed effect, because holding a RETURN write alone does not prevent Functional subsequent task action dispatch. Never relabeled this log as passing.
- `G17-window-evidence.log`: 12 selected passing module/assembly tests with explicit persisted-window assertions; socket tests filtered.
- `G17-drain-deadline-cancel.log`: 3 selected real assembly cases pass (undrained broker, active original deadline, stop-unproven quarantine).
- **Actor final** `G17-final-focused.log`: **16 passed, 13 filtered** out of current29; no disabled/skipped test declarations. Command `pnpm --filter @osstack/cli exec vitest run src/graph-chain.integration.test.ts -t 'assembly:|module:|uses real worker|rejects asynchronous'`, 17.32s total, exit0.
- **Parent host evidence, read/verified by actor:** `parent-chain-first.txt`: **all28 then-existing tests passed**, actual daemon windows/cancel/deadline/undrained/restart/retained-lock included, 38.87s. Parent explicitly reported host authorization in parent-coordination.md. This predates only the final late-OS-exit subscription regression, which actor tested green in final focused16; parent final integration should include current29.
- **Actor final** `G17-final-typecheck.log`: `pnpm --filter @osstack/cli typecheck`, exit0.
- **Actor final** `G17-final-fixture-typecheck.log`: strict dedicated fixture+transitive source tsc, exit0, config `G17-fixture-tsconfig.json`. Initial custom config in `G17-fixture-typecheck-1.log` had artificial global Zod path-resolution errors and a request literal mismatch; resolved config/types pass in `G17-fixture-typecheck-2.log` and final log.
- **Actor final** `G17-final-build.log`: `pnpm --filter @osstack/cli build`, exit0, successful real tsup build (lazy graph-runtime split chunk).
- `G17-diff-check.log`: all owned files including new untracked files have no trailing whitespace; tracked daemon diff check passed.

## Remaining scope and limits

Parent owns final full monorepo acceptance/review/docs/commit and rerun of current29 on host. Actor cannot run Unix sockets here; parent all28 host result is separately attributed, not actor execution. Heavy graph SDK remains only in independently spawned worker; no new top-level graph SDK import was added. No public graph CLI/RPC, generic compiler, production write admission, automated unknown retry, auto no-child recovery, escaped-process containment, power-loss durability, production readiness, or G18-G29 claim. No task status changes made.
