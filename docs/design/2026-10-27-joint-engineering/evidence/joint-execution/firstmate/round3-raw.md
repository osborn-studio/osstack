# Adversarial review: DEBT03 applied receipt retention and Session start cleanup

**Verdict: PASS_WITH_CONCERNS.** I found no P0 or P1 in the diff. The core invariants hold by source trace:

- **Applied is preserved.** `daemon.ts:1091-1108` and `716-729` catch cleanup errors without replacing the result chosen earlier.
- **No second adapter call.** Replay (`787-828`) is DB-driven and never reaches `executeReservedSessionTurn`.
- **Unknown is not reset.** `accepted` and `failed` replay as `delivery_uncertain`, and nothing in the diff calls `retryFailedMessage`.
- **No new authority surface.** The diff contains no signed payload, digest, version-binding, rollback or staleness logic. The engineering permit gate (`944-949`) and permit consumption are untouched, and the new catch blocks sit after the permit is consumed. I found no bypass introduced by the diff.

The findings below are mostly claim-accuracy, observability and untested-path issues.

## Proven findings (from the supplied source)

**1. P2 — Retained-admission visibility is in-memory only, so it vanishes across a real restart.**
- **Where:** `daemon.ts:1411-1421` (drain). `execution_lease_holds` is `writeSemaphore.in_use + readSemaphore.in_use`, plus DB-derived graph and attention holds. Nothing consults the on-disk writer lock.
- **Reproducer:**
  1. Run the test-1 flow so the release fails and `execution_lease_holds` is 1.
  2. Kill the daemon process, which is what the test does not do, and start a fresh one.
  3. Call `daemon.drain`: it reports `drained: true`, `execution_lease_holds: 0`.
- **Impact:** `osstack upgrade` (ADR-16) trusts drain, which now says "clean" while a possibly-live writer lock exists. Admission refusal after restart depends on `repo-lock.ts` honoring `recovery_policy: reconcile`, and that file was not supplied. The same-process restart test (comment at test lines 168-169) cannot show this.
- **Fix:**
  - Preferred: have drain and health count writer-lock files with reconcile policy under the known repo scopes, with no migration needed.
  - Minimum: state in the changeset that retained-hold visibility does not survive process restart.

**2. P3 — The success response and the diagnostic hide cleanup state.**
- **Where:** `1111-1115`, `716-729`.
- **Impact:**
  - The RPC result for a retained-lease turn is byte-identical to a clean one. Collaborator, engineering and attention callers treat it as clean.
  - The only trace is `{event, session_id, run_id}` on stderr. It has no phase (release versus retain) and no `retained` flag, so a swallowed non-cleanup exception looks the same as a release failure.
- **Fix:**
  - Add bounded allow-listed fields such as `phase: "release"|"retain"` and `retained: true`, still without any raw error text.
  - Consider an optional `cleanup: "retained"` result field when the contract allows it.
  - Until then, don't describe the diagnostic as an operator signal.

**3. P3 — Changeset wording and test placement are looser than the evidence.**
- **Where:** `.changeset/session-send-receipt.md` says "including after daemon restart".
- **Reproducer:** the test only covers a same-process `close()` and `boot()`. Its comment says so, but the changeset does not.
- **Impact:** replay is DB-only, so the claim is logically supported. It is not tested across process death.
- **Fix:** say "after a daemon restart in the same process" or "DB-driven replay", and keep "process death" and OS reboot unclaimed.
- **Related:** the Session start test lives in `session-send-receipt.test.ts`. That's a naming issue only.

**4. P3 — Coverage gaps for changed branches.**
- **Not covered by tests:**
  - `handleSessionStart` failure plus cleanup failure.
  - The start path when the stop verifier fails or throws (the `retain` branch).
  - `retain()` throwing.
  - A diagnostic write that throws.
  - The `attention.answer`, collaborator and engineering callers under cleanup failure. The thread report discloses this one.
- **Test hygiene:** `releaseFixture` stores only the last acquired lock, so a test with two successful acquisitions would leak the first.
- **Fix:** add the start and stop-verifier case at minimum. The rest can stay disclosed.

## Hypotheses (need context not in the candidate)

**5. P2 (hypothesis) — The committed result waits on an unbounded release.**
- **Where:** `1095-1097`, `720-722`.
- **Reproducer:** make `lock.release()` hang instead of throwing, for example a stuck filesystem guard. The applied turn is committed, but the RPC never answers. The client's own timeout then sees a failure for a committed turn. Replay would recover, but markers and the lease stay held.
- **Fix:** bound the caller's wait with a race against a timer, and keep the release promise tracked so the markers clear on settlement. Do not abandon the release.

**6. P2 (hypothesis, pre-existing, not changed by the diff) — Stop evidence is keyed to the session `run_id`.**
- **Where:** `1095` calls `confirmAdapterStopped(adapter, session.run_id)`. That ID is shared by every turn of the session, whereas ADR-07 requires a per-invocation binding.
- **Related:** when `settled === true`, the path skips stop confirmation even if the receipt was just marked `failed` (stream ended without terminal, `1040-1045`). `adapter-lifecycle.ts:3` itself says iterator closure is not stop proof.
- **Impact:** a lock could be released while the worker's exit is unproven. Whether this is reachable depends on adapter `confirmStopped` semantics, which I couldn't see.
- **Fix:** bind confirmation to message_id or turn (an invocation identity), and treat "settled without terminal" as retain-unless-proven.

**7. P3 (hypothesis) — `write guard in progress` rejection.**
- **Where:** `governed-execution.ts:231`.
- **Impact:** `release()` rejects there without setting `retained`. The new catch would swallow it and clear the markers while the lease keeps renewing, neither released nor quarantined. Session turns don't appear to use `withWriteGuard`, so this is likely unreachable here.
- **Fix:** don't rely on the governed lifecycle alone; assert unreachability in a test.

## Pre-existing observations (outside this diff; not blockers)

- **Start replay (`552-567`).** It returns `ok: true` for sessions in `starting` or `failed` state, with a snapshot that has no turn. A caller could read that as success.
- **Canonical JSON key sort (`sessions.ts:86`).** It uses `localeCompare`, which is locale-dependent. This is harmless for the two fixed payload keys today but is fragile if the payload shape grows.
- **No `assertActive()` before `completeInboundTurn`.** A turn can be recorded applied after a mid-turn lease renewal failure. Under the new behavior it now returns clean success.

## Explicit limitations

- **Not provided, so unverified:** `acquireSessionAdmission` (including whether admission is always `write` kind), `reserveSessionInstruction`, `isEngineeringCancelledBeforeDispatch`, `repo-lock.ts` (the thread's claim about `recovery_policy: reconcile` at line 346 is unchecked), and the engineering, collaborator and attention callers.
- **Test results taken on trust:** the logs (77 passed, red/green runs) are in the host evidence, not in the candidate. I did not run anything. Whether `vi.spyOn(autonomy, ...)` intercepts the namespace import is accepted because the report says the tests pass.
- **No qualification claimed or demanded:** no OS reboot, process death, power loss, live provider or cross-host fault validation. Retained locks are released only by test teardown, which is not a recovery path (DEBT02).
- **Signed payloads, evidence digests, rollback/staleness and environment binding:** none are introduced or altered by this diff. The qualification schema in the spec is shape-only and I treated it as non-authoritative.

AUDIT_COMPLETE
