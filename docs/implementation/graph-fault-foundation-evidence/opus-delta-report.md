## Verdict: PASS

Scope: source-only review of the final G25 diagnostic slice (`graph-process-journal.{ts,test.ts}`, `graph-worker-manager.test.ts` identity assertions, `graph-worker.ts` canonicalization surface) plus the cancellation contract update in `graph-chain.integration.test.ts` / `scripts/fixtures/graph-chain-host.ts` / `graph-review-findings.test.ts`. I did not run anything; every statement below is read from the source you supplied.

### Prior findings

**N1 — resolved.** `GraphProcessJournal.append()` now normalizes through `JSON.parse(JSON.stringify(event))` before `workerCanonical`, and `JSON.stringify` drops undefined-valued properties at every depth, so `{kind:'exit_unconfirmed', pid: undefined}` can no longer interpolate the literal `undefined` into stored JSON. The mechanism is confirmed in `workerCanonical`: for a non-object it returns `JSON.stringify(value)`, which yields the *value* `undefined` for `undefined`, which template-interpolates as `"undefined"`. The regression test round-trips through a second `GraphProcessJournal` instance, so it genuinely exercises `observe()`'s `JSON.parse(row.event_json)` — the failure point you describe.

**N2 — resolved.** Both `graph-process-journal.test.ts` ("retains launch and true exit…") and `graph-worker-manager.test.ts` ("records the authenticated child identity…") now assert `pgid === null || (Number.isSafeInteger(pgid) && pgid > 0)`, which matches the write-side contract in `launched()` (`launch.pgid !== null && (!Number.isSafeInteger(...) || < 1)`). No residual assumption that a pgid is always assigned.

**N3 — unchanged, informational.**

### Cancellation contract update — accepted

The contract change is source-justified, not merely convenient. In the broker excerpt, `cancellationGraceMs: execution.kind === "command" ? commandTerminationGraceMs + commandKillGraceMs + 500 : 50` (= 2500 for commands) makes the old "adapter gives up at 50 ms ⇒ guaranteed `unknown`" premise unreachable for the command path, so the prior assertion was testing a timing artifact. The replacement asserts the stronger, real properties: `stopped: true` + `termination: { scope: 'posix_process_group', stop_confirmed: true }` in the retained receipt, `pgid === ` the command's self-reported pid, ESRCH on that pid, `state: 'failed'` with `retrySafe: false`, one action only, no `freeze:` re-entry, and `lock === null`. `stopped: true` is directly traceable to the broker's `return { status: ..., stopped: true, candidate, ...(command ? { command } : {}) }`.

Two supporting fixture changes are load-bearing and correct:
- `exec node -e '…'` in `graph-chain-host.ts` (and `exec <execPath>` in `graph-review-findings.test.ts`) removes the intermediate shell, which is what makes `evidence.command.termination.pgid === Number(command.pid)` a true statement rather than an accident — without `exec`, the spawned shell's pid and node's self-reported pid diverge.
- SIGTERM handler + pid-file write both precede the `"started\n"` marker, so the test's `while (!state.external)` gate now strictly happens-after the pid file exists and after the process is TERM-resistant. That closes the ordering race the old fixture had.

### New findings (all informational; none blocking)

**N4 — the broker's post-execution stop timer is an uncoupled magic number.** `cancellationGraceMs` is derived (`commandTerminationGraceMs + commandKillGraceMs + 500`), but the confirmation race immediately below uses a hardcoded `setTimeout(() => resolve({ stopped: false }), 1000)` while `wrapper.confirmStopped` may `await commandPending`, whose worst case is TERM grace + KILL grace = 2000 ms. Today this is only a safety net — the executor already burned the 2500 ms grace before the race, so `command` is assigned and `confirmStopped` resolves synchronously — and if it ever did fire, the result is `throw new Error("external stop unconfirmed")`, i.e. lock retained, the safe direction and a loud failure. But the new test now depends on the confirmed path deterministically, so I'd derive that 1000 from the same two constants for the command branch to keep them from drifting apart.

**N5 — the ALREADY_LAUNCHED guard is read-then-insert; its atomicity is not visible in this packet.** `consume()` does `if (this.intent(binding)) throw` followed by a plain `INSERT INTO graph_worker_launches`. Two concurrent hosts at the same generation would both pass the check unless `(graph_run_id, generation)` carries a UNIQUE/PRIMARY KEY, and `intent()` uses `.get(...)`, so a duplicate row would go undetected afterwards. `migrations.ts` is modified on this branch but wasn't included, so I can't confirm the constraint. Cross-process same-generation launch is separately fenced by the lease/revision CAS, and the sequential guard is covered by the fresh-runtime retry test, so I'm recording this as a verification gap rather than a defect.

**N6 — `observe()` derives `leader` solely from the live identity probe, ignoring recorded `exited` evidence.** When a launch row exists, the ternary short-circuits to `observeGraphProcessIdentity(launch.processIdentity)` regardless of a journaled `exited` observation, so `leader` and `observations` can disagree and the consumer must reconcile them. Under pid reuse the probe could report the leader as live after a true exit — which is the conservative direction (hold, don't take over), and `recovery` is hardcoded `'held'` with `executors` hardcoded `'unknown'`, so nothing unsound is inferable. Flagging so the asymmetry is documented before anything downstream reads `leader`.

**N7 — the N1 regression asserts valid JSON but not key absence.** `expect(report.observations).toEqual([{ kind: 'exit_unconfirmed', error: '…' }])` passes under `toEqual` whether `pid` is absent or present-and-undefined; the real assertion is that `JSON.parse` in `observe()` no longer throws. `toStrictEqual` would additionally pin that the key was dropped, which is the property the fix actually establishes.

**N8 — optional, out of slice: `workerCanonical` still emits invalid JSON for `undefined`.** The fix is correctly scoped to the journal boundary, but the shared helper remains a trap for the next caller, and it's also used for `identity_json` storage and identity equality. Those paths are unreachable today because `GraphWorkerIdentity` is `.strict()` with all fields required, so equality stays sound. A one-line `undefined` guard in the helper would prevent recurrence; changing shared protocol code is reasonably deferred out of a bounded diagnostic slice.

**N9 — minor test nits.** `expect(stopped.worker.signal).toBe('SIGKILL')` in the stubborn test reads `.signal` off a union that may be `exit_unconfirmed` (no such field); the neighboring `cancel` test's `toMatchObject({ kind: 'exited', signal: 'SIGKILL' })` gives a better failure message. The `pgid === null || …` assertions collapse to `expect(false).toBe(true)` on failure, losing the actual value. `f.abortObserved` is exposed by the `graph-review-findings.test.ts` fixture and never read by either test in the file.

### Explicit non-admissions

- I did not run tests and am not asserting any test outcome; the 5 targeted passes and the pending full-suite rerun are your evidence, not mine.
- `retrySafe: false` is asserted by the test but the failure→`retrySafe` mapping is outside the broker lines 450–570 I was given, so I am accepting that from your retained DB rows, not verifying it from source.
- `observeGraphProcessIdentity` and `migrations.ts` were not in the packet; N5 and N6 are bounded by that.
- This PASS covers the diagnostic slice only. No admission of G25 as a whole, of recovery, or of production readiness. The `recovery: 'held'` / `executors: 'unknown'` posture in `GraphWorkerProcessReport` is what keeps this reviewable in isolation, and it should stay hardcoded until executor/descendant proof exists.
- The `child.pid` spawn-failure guard predates this work and is not credited here.
