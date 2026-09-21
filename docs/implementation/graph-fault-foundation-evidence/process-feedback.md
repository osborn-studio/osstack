Claude Opus 5 actual design review follows. Incorporate applicable safe-observation constraints into your bounded slice; do not pretend unsupported opaque executors have stop proof. Parent owns concurrency tests, graph-test-fixture.ts and artifact stale-lock real SIGKILL test. G25 may remain in progress if full recovery evidence is not available.

## Scope note

There is no `packages/cli/src/graph-worker-supervisor.ts`; the supervisor is `packages/cli/src/graph-worker-manager.ts` (`GraphWorkerManager`). Everything below cites what exists.

---

## 1. Primitives to reuse (do not re-invent)

| Need | Existing symbol |
|---|---|
| POSIX group control + descendant probe | `runShellCommand` in `packages/loop/src/executor.ts:548` — `detached:true`, `pgid=child.pid`, `signalGroup` → `process.kill(-pgid, sig)` (`:589`), `inspect()` → `kill(-pgid,0)`/ESRCH (`:646`), `termination.stop_confirmed`, `failure_code:'process_exit_unconfirmed'` (`:626`) |
| Owner-file lock w/ atomic publish + admin release | `packages/autonomy/src/repo-lock.ts`: `withMutationGuard:161`, `publishOwner:184`, `sameOwner:201`, **`releaseReconciledRepoWriteLock:358`** — the exact "fail-closed administrative unlock behind a verifier" shape G25 needs |
| Durable generation consumption | `graph_worker_launches` (migration 29, `migrations.ts:1522`), written pre-spawn in `GraphRuntime.start`'s `register` (`graph-runtime.ts:127-135`) |
| Immutable stop evidence in recovery | `GraphRecoveryProof.worker` union `stopped|not_started|preworker` (`graph-recovery.ts:14-20`), validated at `:138-152`; `graph_worker_leases.stopped_worker_json` |
| Administrative recovery driver | `GraphReconciler.reconcile` (`graph-reconciler.ts:111`), `verifyWorker`/`verifyQuiescence` ports (`:14-17`), takeover journal gate in `GraphRuntime.start:84-89` |
| Real-process host fixture | `scripts/fixtures/graph-chain-host.ts` |
| Mapping rebuild after replay | `GraphDelivery.restoreWorkspaceMappings` (`graph-delivery.ts:146`) — content-addressed receipts, not worker RETURNs |
| Durable fsync'd file writes | `durableFile`/`syncDirectory` in `packages/core/src/graph/artifact-store.ts:63,55` |

---

## 2. Unsafe assumptions to refuse

1. **`kill(pid,0)` / `kill(-pgid,0)` ESRCH is not stop proof across a daemon crash.** PID and PGID are reused. `repo-lock.ts:369,373` currently relies on bare `defaultIsProcessAlive(pid)` — that is a live PID-reuse hole and must be fixed under G25, not just documented.
2. **`spawn_failed{phase:'registration'}` (`graph-worker-manager.ts:215-218`) is in-memory only.** After a crash the launch row exists with no durable no-child receipt.
3. **`not_started` is currently inferred** from "no rows in `graph_actions`/`graph_checkpoint_requests` for that generation" (`graph-recovery.ts:143-144`). A worker that started and did nothing is indistinguishable. Insufficient once G25 claims consumed-launch coverage.
4. **Lease expiry / 5-min waiting lease / drain timeouts are never takeover authority.** `GraphRuntime.stop`'s `actionsSettled` is Promise drainage only (`graph-runtime.ts:33,167`).
5. **`GraphDeliveryInterrupt` + old `stopped:true` receipts are historical, not present-tense.** `graph-rpc.ts:164` correctly returns `ACTION_OUTCOME_UNKNOWN` without a live driver — keep that.
6. **Leader exit ≠ tree exit.** `executor.ts:665` explicitly models `leader_exit` with surviving descendants. Any process that `setsid()`s out of the group is unreachable by pgid probing — this must fail closed, not be assumed dead.
7. **`mkdir` EEXIST on the artifact lock is not "someone is alive"** and is not safely removable by age.

---

## 3. Durable process identity (required safety)

New core module `packages/core/src/graph/process-identity.ts`; new append-only migration 34.

**Identity tuple** (`graph_worker_identities(graph_run_id, generation, pid, pgid, start_identity, host_identity, presence_path, recorded_at)`, no-update/no-delete triggers like `migrations.ts:1533`):

- **Linux:** `pgid` = field 5 and `starttime` = field 22 of `/proc/<pid>/stat` (ticks since boot); `host_identity` = `/proc/sys/kernel/random/boot_id`. Descendant enumeration = scan `/proc/*/stat` field 5 == pgid.
- **macOS:** no `/proc`. Use `ps -p <pid> -o pid=,pgid=,lstart=` (second granularity) plus `sysctl -n kern.boottime` as `host_identity`. Descendants = `ps -Ao pid=,pgid=` filtered by pgid. **Second-granularity `lstart` is weak**: treat it as corroborating only.
- **Primary, platform-uniform presence proof — a FIFO, not a PID.** Before spawn, `mkfifo <root>/proc/<runId>/<gen>.fifo` (0600) and commit `presence_path` in the *same* transaction as the `graph_worker_launches` insert (`graph-runtime.ts:128-135`). Pass the write end as an inherited extra stdio fd (the `stdio` array at `graph-worker-manager.ts:227` already carries fd 3; add fd 4), and require `runShellCommand`'s detached children to inherit it too. Any later process — including a brand-new daemon — opens the FIFO `O_RDONLY|O_NONBLOCK`: **EOF/no-writer is independent of PID and PGID reuse, and covers descendants that inherited the fd.**

**Honest limit:** a descendant may `close()` the inherited fd or `setsid()` away. So no-writer is *necessary, not sufficient*. Stop proof must be **conjunctive**: (no FIFO writer) ∧ (pgid probe ESRCH *or* every pgid member's start-identity post-dates the recorded tuple) ∧ (`host_identity` matches, else fail closed) ∧ adapter `confirmStopped` where available (`adapter-lifecycle.ts:43`). Any leg unknown ⇒ `reconciliation_required`, never `stopped`.

**Wiring:** record the identity row inside `child.once('spawn')` (`graph-worker-manager.ts:244`) *before* the `init` frame; surface it on `GraphWorkerExitEvidence` and persist each observation into an append-only `graph_worker_stop_observations` table carrying prover, method, and raw probe text. Then extend `GraphRecoveryProof.worker.stopped` (`graph-recovery.ts:14`) with the identity digest and require `proof()` (`:141`) to match it.

---

## 4. Independent post-daemon-crash stop proof (required safety)

A **new host process** must be able to produce `stopped` without ever having held the supervisor. Implement `GraphProcessProber` consuming only `graph_worker_identities` + the FIFO, and plug it into the existing ports:

- `verifyWorker` (`graph-reconciler.ts:14`) → conjunctive prober result, not `stopped.worker` from an in-memory handle (contrast `graph-delivery.ts:280`, which is live-only by design — leave that path intact).
- `verifyQuiescence` (`:16`) → must additionally re-probe every `graph_action_admissions` row with `released_at IS NULL` and every executor pgid recorded for that run.
- Takeover then flows through the existing `commit` path (`graph-recovery.ts:232-240`), which already writes `stopped_worker_json` and satisfies `GraphRuntime.start:84-89`'s journal gate.

**Administrative, fail-closed, no replay of unknown effects.** New CLI verb (e.g. `osstack graph reconcile --run ID --scope FILE`) that: rebuilds mappings via `restoreWorkspaceMappings` (`graph-delivery.ts:146`) without launching a worker, prints the probe evidence, and refuses to proceed unless every leg is proven. Unknown effects stay `unknown`/held.

---

## 5. Consumed launch registration failure (required safety)

Today: the launch row commits (`graph-runtime.ts:128-135`), then `broker.register`/`checkpoints.register` (`:136-137`) may throw; `manager.start`'s catch (`graph-worker-manager.ts:259`) emits an in-memory `spawn_failed`. Fix:

1. Append-only `graph_worker_launch_outcomes(graph_run_id, generation, outcome ∈ {'no_child','identity_recorded'}, evidence_ref, recorded_at)`.
2. Write `'no_child'` **synchronously, before any await**, in `spawnFailed` when `child?.pid === undefined` (`graph-worker-manager.ts:212`) — via a host-supplied sync callback, keeping the manager DB-free (`:81-82`).
3. Tighten `graph-recovery.ts:143-144`: `kind:'not_started'` requires the `'no_child'` row **in addition to** the existing no-actions/no-checkpoints check, plus absence of an identity row and no FIFO writer ever observed.
4. Crash strictly between the launch commit and either outcome row ⇒ **no `not_started` claim is available**; the run is adjudicated by the prober or stays `reconciliation_required`. State this explicitly; do not paper over it.

---

## 6. Stale artifact locks (required safety)

`artifact-store.ts:98-99` creates `locks/<id>` and removes it at `:146`. A crash leaves an opaque permanent EEXIST.

- Write `locks/<id>/owner.json` via `durableFile` (`:63`) containing `{graphRunId, generation, owner, effectKey, pid, pgid, startIdentity, hostIdentity, presencePath, acquiredAt}`, then `syncDirectory`.
- Before `rm(lock,...)` at `:146`, re-read and `sameOwner`-check so the happy path cannot delete an administrator-replaced lock.
- Add `releaseReconciledArtifactLock` **modeled directly on `releaseReconciledRepoWriteLock` (`repo-lock.ts:358-376`)**: exact owner match, prober-proven non-liveness (not bare `kill(pid,0)`), a committed `graph_recovery_decisions` row, and the verifier re-checked after the async gap. Never age-based, never automatic.
- Lift `withMutationGuard`/`publishOwner`/`sameOwner` into the shared core module and fix `repo-lock.ts:369,373` to use start identity.

---

## 7. Deterministic real-process F01–F12 (required evidence)

New `graph-faults.integration.test.ts` / `graph-concurrency.integration.test.ts` + `scripts/verify-graph-runtime.mjs`.

- **Real host process**, not in-process fakes: extend the `scripts/fixtures/graph-chain-host.ts` pattern so the daemon-side host is a spawned child with its own `OSSTACK_HOME`/`TMPDIR`, real SQLite, real `GraphWorkerManager` children, real `runShellCommand` acceptance commands.
- **Barriers, not sleeps.** The host emits a named-window line and blocks on a control fd; the test `SIGKILL`s at the window. Windows to cover: post-`graph_public_delivery` insert / pre-`setImmediate` driver construction (`graph-rpc.ts:185-192`); post-launch-row / pre-spawn; post-spawn / pre-identity-row; effect confirmed / checkpoint unwritten (F04); parallel writes with barrier unwritten (F05); mid-`capture` holding the artifact lock.
- **Old-generation rejection (F06/F07):** fixture worker ignores SIGTERM and keeps writing `writer-<epoch>`; assert `assertActive()` (`graph-worker-manager.ts:164`) rejects action/put/putWrites and the next epoch's `artifactDigest` is unchanged.
- **F11:** TERM-ignoring child drives `cancel()`'s escalation (`:148-163`) to `exit_unconfirmed` (`:159`); assert `finalExit` still resolves later, DB stays `cancel_pending`, admissions stay held.
- **F09:** same key concurrent, same key different input, resume-with-new-attempt against `graph_requests` + `replay()` (`graph-rpc.ts:124`).
- **Three separate counters** per the plan (`upgrade.md:37,685`): worker function re-entries (worker-side), confirmed effects (`graph_actions` with `outcome.state='confirmed'`), logical joins (`graph_verification_joins` rows). Never collapse them.
- Fixed seed only for concurrent-submission ordering; emit JSON evidence including platform, `host_identity`, and every probe transcript.

---

## 8. Required safety vs optional liveness

**Required (blocks G25):** durable identity tuple + FIFO presence; conjunctive stop proof reproducible by a fresh process; durable `no_child` receipt and tightened `not_started`; artifact-lock owner metadata + verifier-gated release; PID-reuse fix in `repo-lock.ts`; F01–F12 on real processes with the three counters.

**Optional (liveness, do not gate on it):** automatic takeover after crash; background stale-lock sweeper; probe caching; retry of `release_pending` (`graph-reconciler.ts:154`); parallel probe fan-out.

---

## 9. What would make a "G25 complete" claim false

Claim only if: (a) both Linux **and** macOS probing land — `runShellCommand` already hard-fails on win32 (`executor.ts:557`), so Windows is out of scope, but a Linux-only landing is not G25; (b) proof is produced by a process that never held the supervisor; (c) the pre-spawn/pre-identity crash gap is disclosed as fail-closed rather than resolved by inference; (d) mappings/receipts/checkpoints/registry rebuild goes through `GraphReconciler`/G15, not a CLI resume branch (`context.md:39`). Anything short of that is partial G25 and must be reported as such.
Parent adjudication: FIFO is not mandatory spec and does not prove stopped descendants that closed it. Do NOT add FIFO as sufficient proof or broad auto recovery. Durable exact observations + explicit executor unknown is valid safety slice but not full G25. Please add tests/implementation gate for G15 `not_started`: if durable consumed launch exists, require authenticated durable no-child journal rather than only no actions. You may additionally own packages/core/src/state/graph-recovery.ts + its tests for that gate, or report exact API and parent will integrate. Existing purely synthetic core tests with no durable launch can remain trusted verifier scenarios. Avoid core->cli imports: core can read append-only schema record. Confirm no-child proof also exact binding matches journal. Parent will not change these files during actor.

Critical lifetime check: adding lifecycle.observed DB writes on late finalExit means GraphRuntime.drainDatabaseUsers must also wait for manager finalExit, not only action/checkpoint promises. Bounded exit_unconfirmed is not lifetime completion; test it. Parent removed unused helper import; do not touch graph-test-fixture or concurrency files.

Typecheck currently flags processFixture TS4058 exported inferred BetterSqlite3.Database cannot be named. Explicit return interface is robust fix (parent fixed own graphRpcFixture with interface; merely db annotation did not suffice).

Parent's first-pass review sees correct conservative split and core gate. Once focused regression/typecheck are green, finalize your bounded slice and process-report.md without extra features; parent will freeze all source, send full diff+new files to actual Claude Opus 5 for adversarial review, then run matrix/full acceptance through Loop. Be explicit that durable diagnostics are not independent opaque-executor stop proof; full G25 remains open. Parent script verify-graph-runtime covers relevant regression suites once plus two seeded concurrency runs. Parent owns all docs and that script.

Parent inspected process-chain-full.log: 13 daemon cases fail exclusively listen EPERM under nested Codex workspace-write sandbox. Do not alter product/tests to bypass; parent shell (already unrestricted per current environment) will run real socket matrix and full acceptance. Keep log and identify limitation in report, then finish. Actual Claude Opus 5 code review dispatched on current 20 source files; avoid further changes except required fixes and note any change.
