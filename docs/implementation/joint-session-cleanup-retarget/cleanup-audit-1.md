## Verdict: REVISE

The diff contains only the #278 Session start cleanup change: `daemon.ts`, `session-send-receipt.test.ts`, and one changeset. No #276 R02 evaluator, Behavior*/Joint* separation, J01/J11 or J02a files are in the supplied diff, so I could not review them. The #278 slice is mostly sound. The only defects I found are P2.

### Present defects

**P1: scope and claim mismatch**
- **Location:** PR description vs. diff.
- **Problem:** A PR described as #276 ships none of #276's code. I cannot certify anything about the evaluator's synchronous, offline behavior, the frozen R01 digest format, or the absence of implicit Behavior→Joint conversion.
- **Fix:** Either supply the #276 diff or retitle the PR as #278-only. Do not merge claims I could not check.

**P2: `requestSupervisionScan` can replace the preserved response**
- **Location:** `daemon.ts`, inner `finally` of `handleSessionStart`, and the same pattern in the send path.
- **Counterexample:** `ctx.supervision.requestScan` throws synchronously. Only the returned promise has `.catch`. The exception propagates out of the `finally` and replaces the already-built `singleOk` or `singleErr`, which defeats this PR's purpose of preserving the response.
- **Fix:** Wrap the call in `try { void ctx.supervision.requestScan(reason).catch(() => {}); } catch {}`. Add a test where `requestScan` throws synchronously.

**P2: the `activeRuns.get(runId) === controller` guard is untested**
- **Location:** `daemon.ts`, inner `finally` of `handleSessionStart`.
- **Problem:** No test fails if the guard is removed. Run IDs are derived from `request_id`, and a duplicate request returns early before `activeRuns.set`, so the guard looks unreachable for start.
- **Fix:** Add a test that exercises the guard, or drop it.

**P2: the test fixes an ambiguous replay contract**
- **Location:** the `failed` replay assertion in the `it.each` test.
- **Problem:** `session.start` replay of a failed start returns `ok: true` with `state: "failed"`. A client retrying after an `agent_failed` error sees success.
- **Fix:** Confirm this is intended, or return an error for failed replays. Note it in the changeset either way.

**P2: `confirmAdapterStopped` behavior is not visible**
- **Location:** the `stop_throw` case and `confirmAdapterStopped` (not in the supplied source).
- **Problem:** The test expects `execution_lease_holds: 1` when the verifier throws. That holds only if `confirmAdapterStopped` swallows the throw and returns false. If it rethrows, the new `catch` swallows the error and the lease is neither released nor retained.
- **Fix:** Verify that function, or move retention into the `catch`. The `stop_throw` case should then assert retention directly.

### Minor
- The cleanup block is now duplicated between start and send. Consider extracting a shared helper.

### Deferred (not defects here)
- **#279 terminal-producer fence:** the success path (`settled` and not aborted) releases without `confirmAdapterStopped`. A producer that outlives its terminal event is therefore not fenced. The test adapter says "no external producer", and neither the code nor the changeset claims otherwise. Keep it listed as pending #279.
- **DEBT02 / J11:** retained holds across process restart and lock recovery are unverified. The changeset states this honestly, and the tests' "same-process restart" comments are accurate. No recovery claim is made.

### Claim check
The changeset's three claims are supported by the tests:
- completed responses are preserved;
- the active marker is cleared;
- replay does not start another Session.

The diagnostics carry only IDs, and no prompt or native session ID is leaked.

END_AUDIT