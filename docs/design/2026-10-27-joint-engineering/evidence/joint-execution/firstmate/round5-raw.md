# Adversarial review: Session receipt cleanup and terminal-completion fence

**Verdict: PASS_WITH_CONCERNS**

I found no P0 or P1 in this diff. I traced the source only and ran nothing.

## Invariants traced against the source

| Invariant | Result | Where |
|---|---|---|
| Completed results survive cleanup failure | Holds | Start: `finally` at 720-733 swallows cleanup errors, so the `return singleOk` at 703 stands. Send: 1095-1111 does the same for 1084. Duplicate-while-waiting: the release wrapper at 911-915 swallows and still clears markers. |
| Incomplete start cannot manufacture success | Holds | `terminalCompleted` (623, 665) is checked at 669 before `settled = true` at 670. A no-terminal stream throws, so `settled` stays false and the `finally` aborts and runs the stop branch. |
| Incomplete send never silently releases | Holds | `settled = true` moved from before the check to after it (1043-1049). Early `return failReservedMessage(...)` paths in the loop leave `settled` false. |
| Unconfirmed stop retains | Holds | `confirmAdapterStopped` returns false if the verifier is absent, throws or times out (adapter-lifecycle.ts:43-52), so `retain()` runs. `retain()` sets `retained`, clears the timer and quarantines before it writes stderr (governed-execution.ts:227), so a throwing stderr cannot undo retention. |
| Replay does not resend | Holds | The start replay at 552-567 and the send replay at 791-831 return before any adapter call. `accepted` and `failed` receipts return `delivery_uncertain`, and nothing calls `retryFailedMessage`. |
| No new authority surface | Holds | The diff adds no signed payload, digest, version, rollback or environment binding. The engineering permit gate (948-953) is untouched, and the new catch blocks run after the gate. I found no bypass. |

## Round-3 findings: disposition

| R3 | Status |
|---|---|
| 1. Retained-hold visibility is in-memory only | Reclassified as a documented limitation. The changesets now disclaim it. Admission after restart is still refused by `recovery_policy: reconcile` (repo-lock.ts:346). |
| 2. Diagnostic hides cleanup state | Still open (finding 4). |
| 3. Changeset says "restart" without scope | Fixed ("same process"). One smaller wording issue remains (finding 5). |
| 4. Coverage gaps | Mostly closed: start failure plus release failure, stop-throw, retain-log-throw and diagnostic-throw are now tested. A new gap is finding 1. |
| 5. Unbounded release | Not introduced here. Per the scratch probe, the metadata guard is bounded at about 2 s (repo-lock.ts:175-190). Arbitrary OS I/O stalls remain unqualified. |
| 6. Settled without terminal skips stop confirmation | **Fixed by this candidate** (670, 1049). Stop keyed to the session-wide `run_id` is a future limitation. |
| 7. `write guard in progress` swallowed | Unreachable in the Session call graph, per the source trace. |

## Proven findings (introduced by or pinned in this candidate)

**1. P2, test gap: the successful path is never shown to release without stop confirmation.**
- **Where:** session-send-receipt.test.ts:36-41, 150-185 and 263-295.
- **Evidence:**
  - The fixture's default `confirmStopped` returns `stopped: true`.
  - Every `failCleanup: true` test would behave the same if a successful turn wrongly took the stop-then-release branch.
  - The only `failCleanup: false` tests use `omitTerminal` (lines 344, 379, 407).
  - The happy-path tests never assert `adapter.stopChecks` or `cleanupAttempts`.
- **Reproducer:** change the `finally` condition at 722 or 1097 to always confirm. All added tests still pass.
- **Impact:**
  - No shipped Session adapter implements `confirmStopped`, so such a regression would retain the lease on every successful start and send.
  - That is the complement of the fence this change adds, and it is unpinned.
- **Fix:** add start and send tests with `failCleanup: false` and a terminal-completing adapter. Assert `stopChecks` is empty, `cleanupAttempts` is 1, and drain returns `drained: true` with 0 holds. Add a variant whose adapter has no `confirmStopped` method, which is the shape every shipped adapter has.

**2. P3, test gap: a completed terminal followed by a fault is not exercised.**
- **Where:** 663-670 and 1008-1049.
- **Evidence:** the code is correct because `settled` is only set after the loop. No test emits `session.terminal: completed` and then throws or emits a failed terminal.
- **Fix:** add one case per route asserting stop confirmation and retention.

**3. P3, contract now pinned by tests: replay of a failed start returns `ok: true`.**
- **Where:** 552-567. Tests at 326, 370 and 373 assert `ok: true, state: "failed"`.
- **Issue:** the first call returns `agent_failed`, but a retry with the same `request_id` returns `ok: true`. The same happens for `starting`. This is pre-existing, but the new tests and the changeset phrase "replay it" now lock it in.
- **Fix:** either document that clients must read `state`, or return a distinct error or flag for `failed` and `starting`. Do not rely on `ok`.

**4. P3, carried from R3-2: the cleanup diagnostic is not an operator signal.**
- **Where:** 1115-1119 and the catches at 727-728, 912-913 and 1102-1106.
- **Issue:**
  - The catch is catch-all, so `{event, session_id, run_id}` is identical for a release failure and for any other unexpected exception.
  - It carries no `phase` or `retained` field.
  - The `retain_log_throw` test (297-329) asserts only semaphore occupancy, which would also be 1 if `retain` had not set its flag.
- **Fix:** add allow-listed fields (`phase: "release" | "retain"`). Assert quarantine, for example that a second admission in the same repo is denied.

**5. P3, changeset accuracy.**
- **Where:** session-terminal-boundary.md.
- **Issue:** "Reject … send streams that end without a successful terminal" overstates the change. Send already rejected them (1043). The change is the stop confirmation and retention. "Replay it" for start is ambiguous (see finding 3).

## Hypotheses needing missing context

**6. P3: a synchronous throw from `requestSupervisionScan` can still replace a committed result.**
- **Where:** 731 and 1110 (inside `finally`), 1121-1126.
- **Issue:** `ctx.supervision.requestScan` was not supplied. If it throws before returning a promise, the throw escapes `.catch` and replaces the return value. This is the same masking class the change fixes.
- **Fix:** wrap the call in `try/catch`.

**7. P3: other fixtures may end `startSession` without a terminal.**
- Any existing test or registered adapter that does so now fails the start and retains the lease. The diff does not show the rest of the suite.
- This is intended, but confirm with a full run.

## Pre-existing observations (not blockers)

- **Native id lost on failed start.** After a failed or no-terminal start the native session id is never recorded (676-702). If stop is confirmed and the lease released, the provider session is orphaned.
- **Stop keyed to the session `run_id`.** `confirmAdapterStopped(adapter, session.run_id)` at 1099, and the tests pin `["run"]` (386, 403, 431). A future adapter with cached positive proof needs a per-invocation key.
- **Unconditional marker delete.** Line 1108 deletes `activeSessionSends` unconditionally, unlike the conditional delete in the admission wrapper (906).
- **No post-admission recheck in start.** Start does not recheck `draining` or `aborted` after admission, unlike send (857).
- **No `assertActive` before commit.** Neither route calls it before the DB commit.
- **Run deadline.** The `boundedAdapterEvents` timer arms only after abort (adapter-lifecycle.ts:10-15), so a post-terminal hang has no bound.

## Explicit limitations

- **Self-reported terminal.** `terminalCompleted` is an adapter-asserted event. It is the accepted baseline, not stop evidence. Claude's SDK-EOF synthesized `completed` (claude-code.ts:419-429) is pre-existing.
- **Dependent behaviours not verified.** Not visible to me: `reserveSessionInstruction`, `isEngineeringCancelledBeforeDispatch`, `requestScan`, and the collaborator, engineering and attention callers under cleanup failure. I also did not verify that `vi.spyOn(autonomy, …)` intercepts the live import binding; I took the reported passing logs on trust.
- **Not claimed or demanded.**
  - No operator recovery.
  - No cross-process drain visibility.
  - No per-invocation stop API.
  - No process death, reboot, live provider or filesystem-hang qualification.
- **Out of scope for this diff.** Signed payloads, digests, rollback and staleness, environment binding and the qualification schema are untouched. I treated the schema as shape-only.
- **Recommended before merge.** Finding 1, and optionally finding 6. Findings 2-5 can be tracked.

AUDIT_COMPLETE
