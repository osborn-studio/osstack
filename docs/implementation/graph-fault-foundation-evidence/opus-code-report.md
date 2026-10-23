## Verdict: REQUEST_CHANGES

Source-only review of the supplied diff/new files. **I ran nothing** — no tests, no build, no `/proc` probes. Findings below are derived from reading the changed code; where a conclusion depends on a symbol not included in the diff (e.g. `Connection.handle`, `canonical` vs `workerCanonical`, `graph_worker_launches` DDL) I say so explicitly rather than asserting.

Disclosed out-of-scope work (automatic crash recovery, executor/descendant quiescence proof, admin-lock recovery, macOS `ps` identity strength) is treated as deliberate scope and is **not** counted as a finding.

---

## P0 — `spawn_failed` is not proof of "no child", but is consumed as such

**`packages/cli/src/graph-worker-manager.ts` `spawnFailed` → `graph-process-journal.ts` `GraphProcessJournal.observe` → `packages/core/src/state/graph-recovery.ts` (`w.kind === "not_started"` block).**

`child.on('error', spawnFailed)` is not spawn-specific. Node emits `'error'` on a `ChildProcess` when the process could not be spawned **and also when the process could not be killed, and when sending a message fails**. `phase` is then inferred from `registered` (a registration-progress flag), not from whether a pid was ever assigned:

```ts
phase: registered ? 'spawn' as const : 'registration' as const
```

`observe()` concludes `leader: { state: 'absent', reason: 'authenticated_no_child' }` whenever there is no `launched` event and any `spawn_failed` event exists. `GraphRecoveryStore` then accepts a `not_started` proof for a consumed generation on exactly `events.length === 1 && events[0].kind === 'spawn_failed'`.

Reproduction (low probability, high severity):
1. `consume()` commits (`consumed = true`), broker/checkpoint registration succeeds.
2. Child spawns. The `'spawn'` handler runs `assertActive()` **first** (newly added in this diff) and throws because a concurrent `stop`/`cancel` deactivated the record — so `lifecycle.launched` never runs and **no `launched` row exists** for a process that is alive.
3. `cancel()` kills; the kill fails (ESRCH/EPERM/permission-changed child) → `'error'` → `spawnFailed` → `observe()` appends `spawn_failed` (`phase: 'spawn'`).
4. Journal now holds exactly one event: `spawn_failed`. `observeWorkerProcess` reports `leader.state === 'absent'`, and recovery admits a `not_started` takeover **while the worker is still running**.

The invariant "a `spawn_failed` row implies no child ever existed" is claimed by both the journal comment and the recovery comment but is enforced nowhere. Minimum fix: gate the no-child classification on `child?.pid === undefined` (or a `spawned` boolean set in the `'spawn'` handler *before* `assertActive()`), and record post-spawn `'error'` events under a distinct kind that recovery does not accept.

---

## P0 — Journal write failures at exit are silently discarded

**`packages/cli/src/graph-worker-manager.ts`, `observe()`.**

```ts
const observe = (evidence) => {
  try { persist(...) }
  catch (error) { ready.reject(...); result.reject(...); }
};
```

At every call site except `spawn_failed`-during-registration, `ready` and `result` are already settled (the `'exit'` handler rejects both on the lines immediately above; on a successful run `result` resolved earlier). Rejecting a settled deferred is a no-op, so a durability failure becomes **a silent swallow**, and `exit`/`finalExit` still resolve as though the observation were durable.

Two concrete consequences:
- Combined with P0 #1: if `spawn_failed` is recorded and the later `exited` append fails (closed DB, I/O error), the journal is left with exactly one `spawn_failed` — the shape recovery accepts as no-child authority.
- `UNIQUE(graph_run_id, generation, kind)` (migration 34) makes a second `exit_unconfirmed` append a constraint violation. If `stop()`/`cancel()` can install the timer chain twice, the duplicate is swallowed here rather than surfacing.

`observe()` must propagate to a channel someone actually reads (reject `finalExit`, or surface via the report so `recovery: 'held'` is provably based on a complete journal).

---

## P1 — `detached: true` leaks live workers; recorded `pgid` is never used to stop anything

**`packages/cli/src/graph-worker-manager.ts`, `spawn(...)` options.**

The child is now a session/process-group leader on POSIX. That removes the previous behaviour where a terminal `SIGINT`/`SIGHUP` delivered to the supervisor's foreground group also reached the worker. Termination still goes through `child.kill(...)`, which signals **only the direct child** — nothing in this diff signals `-pgid`. Net effect on the live path: Ctrl-C of the CLI now leaves the worker running (the fault fixture's worker body is `while(true){}`), plus its descendants, where previously the group signal reaped it.

This is a behaviour change in the production launch path, not a diagnostic addition. It appears to exist only to satisfy `GraphProcessJournal.launched`'s `launch.pgid === launch.pid` validation (without `detached`, `/proc/<pid>/stat` reports the parent's pgrp and that assertion fails). Either signal the group on stop/cancel, or relax the pgid assertion and drop `detached`.

---

## P1 — Recovery/journal canonicalization contract is unverified and, if divergent, deadlocks recovery

**`graph-recovery.ts`: `launch.identity_json !== canonical(run.identity)` vs `graph-process-journal.ts` `consume()`: `workerCanonical(binding.identity)`.**

Production writes the row with the protocol canonicalizer and recovery validates it with the core one. The new test (`graph-recovery.test.ts`, "requires an exact durable no-child receipt…") fabricates both the `graph_worker_launches` row and the `graph_worker_process_events` row with raw `INSERT`s using `proofKey(...)` — it never goes through `GraphProcessJournal`. So the test passes by construction regardless of whether the two serializers agree.

If they differ by so much as key ordering or number formatting, **every consumed generation's `not_started` proof is rejected forever** (`WORKER_PROOF_MISMATCH`), i.e. a recovery deadlock, and this suite stays green. At minimum, drive the fixture rows through `GraphProcessJournal.consume`/`observed`, or assert `canonical(x) === workerCanonical(x)` once.

---

## P1 — Evidence runner attests source it does not execute

**`scripts/verify-graph-runtime.mjs`.**

`sourceHashes`/`sourceUnchanged` come from `git ls-files --cached --others --exclude-standard -- packages scripts`, which excludes ignored build output. But two of the fault fixtures execute compiled artifacts:

- `scripts/fixtures/graph-artifact-crash.mjs` imports `packages/core/dist/graph/artifact-store.js` while the test-side consumer (`new GraphArtifactStore(...)`) is the `src` module — the F07/F12 crash test compares stale `dist` against current `src`.
- `scripts/fixtures/graph-process-host.ts` uses `resolve('packages/graph/dist/worker-entry.js')`.

The runner never builds. On a clean checkout these fail with a module-resolution error; with a stale build the report is green and hash-attested but does not describe the reviewed source. Add an explicit build step and hash the executed artifacts (or make the fixtures import `src`).

Secondary gap in the same file: `passed` requires `tests.length > 0` **per run**, not per file. A listed file that contributes zero assertions (e.g. an accidental suite-level skip) still satisfies `observedFiles.has(...)` and passes on the other files' results.

---

## P2 — `drainDatabaseUsers()` can block forever with no timeout or diagnostic

**`packages/cli/src/graph-runtime.ts`.**

`finalExit` is `Exclude<…, 'exit_unconfirmed'>` and is deliberately left unresolved on the bounded-stop timeout path until a real OS exit arrives. Adding it to the drain set is correct for DB lifetime, but the await is unbounded: a worker that outlives the bounded stop (the exact case the new `graph-process-journal.test.ts` timeout test constructs, resolved there only by a manual `process.kill`) hangs shutdown indefinitely after `close()` already resolved. `drainTimeoutMs` (validated 1..60000) is not applied here. Preferred shape: bounded wait, and on expiry **refuse to close** with an explicit "database still has live producers: pid N" error rather than hanging silently.

Unverifiable from the diff: whether `retire()` removes the record from `this.connections`. If it does, cancelled/stopped handles are excluded from the drain set and a late `observed()` write can land after `db.close()` — please confirm. The `Connection` type's `handle` field is likewise not in the diff.

---

## P2 — Test-only helpers placed in shipped `src/`

`packages/cli/src/graph-process-fixture.ts` and `packages/cli/src/graph-test-fixture.ts` are not `*.test.ts`. Unless `tsconfig` excludes them explicitly, they compile into the published CLI, dragging `execFileSync('git', …)`, `openDb`, temp-DB construction and hard-coded fixtures (`'a'.repeat(40)`) into the shipped surface. Move under a test-only directory or exclude from the build.

---

## P3 — Smaller items

- **macOS launch-path stall.** `captureGraphProcessIdentity` runs `execFileSync('/bin/ps', …, { timeout: 1000 })` synchronously inside the `'spawn'` handler, before `init`. This blocks the event loop (heartbeats, other workers' I/O) for a fork/exec on every launch — up to 1s if `ps` stalls — to obtain data the module itself labels `unverifiable`/diagnostic. darwin is the stated platform. Capture asynchronously after `init`, or gate it.
- **Migration 34 FK.** `FOREIGN KEY(graph_run_id,generation) REFERENCES graph_worker_launches(graph_run_id,generation)` requires a PK/UNIQUE on exactly those parent columns and `PRAGMA foreign_keys=ON`. I can't see the parent DDL or `openDb`'s pragmas: if the index is missing this surfaces as a runtime "foreign key mismatch" on the first event insert; if the pragma is off the FK is decorative and `GRAPH_PROCESS_INTENT_REQUIRED` is the only guard. Worth an assertion test.
- **`/proc` parsing is correct.** `stat.lastIndexOf(')') + 2` then index 2 = `pgrp` (field 5) and index 19 = `starttime` (field 22) are right, and the `pid` cross-check plus `^\d+$` guard are sound. No bug here.
- **`observeGraphProcessIdentity` throws instead of degrading.** `validPid(saved.pid)` throws `GRAPH_PROCESS_PID` on a corrupt/truncated journal row, which propagates out of `GraphProcessJournal.observe` and fails the whole report. A corrupt row should yield `{ state: 'unknown' }`.
- **Intent written from one object, validated against another.** `consume(fixed)` in `graph-runtime.ts` vs `launched(binding, …)` / `observed(binding, …)`. Any future divergence between `fixed` and `binding` (generation/owner normalization) turns into a `GRAPH_PROCESS_BINDING` throw at append time. Use one object or assert equality.
- **`artifact-store.test.ts`** pins a raw errno as API: `rejects.toMatchObject({ code: 'EEXIST' })`. Callers cannot distinguish "stale lock held" from other `EEXIST`. Consider a domain error carrying the lock path.
- **`graph-faults.integration.test.ts`** `symlinkSync(resolve(repo,'packages/cli/node_modules'), …)` fails on a hoisted install layout; combined with in-band `esbuild` and 5s message barriers this suite is timing/layout sensitive on cold CI.

---

## Reviewed and found clean

- Duplicate-launch path: second `start()` → `consume` throws `GRAPH_GENERATION_ALREADY_LAUNCHED` → `spawnFailed(registered=false)` → runtime's `observed` short-circuits on the fresh per-call `consumed=false`, so the prior generation's journal is not appended to. Correct, and matches the assertions in `graph-process-journal.test.ts` and `graph-process-host.ts`.
- `persist()`'s sync-only enforcement (swallowing a returned promise before throwing) and the shallow `{...value.lifecycle}` copy.
- `launched_at > confirmedAt` ordering check and the `not_started` + `graph_actions`/`graph_checkpoint_requests` pre-existing guards.
- Ordering: `observe()` precedes `exit.resolve`/`finalExit.resolve` at all three call sites, so the DB write happens before any drain barrier can release.
- `shuffle` (xorshift32, `seed || 1`) never degenerates; the `graph-submit-race.mjs` ready/`go` barrier has no listener-attachment race.
- `graph-rpc.test.ts` fixture extraction is a faithful move with no behavioural delta.