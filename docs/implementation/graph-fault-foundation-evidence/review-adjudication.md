# Opus 5 review adjudication

The user explicitly authorized Claude Opus 5. Both design and code calls use the real CLI model, with JSON modelUsage retained. The coding actor ran through OSStack Loop; its single diff-check verifier is not full acceptance.

## First code review

- **No-child post-spawn error claim: rejected after checking complete source.** `spawnFailed` already checks `child?.pid` before creating no-child evidence. A new real-process kill-error test, with launch persistence intentionally failing, produces only exited evidence and passes before the journal fix. This is a test-backed disagreement, not silently ignoring a P0.
- **Swallowed exit-journal write failure: fixed.** The original success result may already be settled, so rejecting it again is ineffective. Exit/finalExit receipts now carry journalError while retaining actual physical observations. The regression failed before the fix and passed afterward.
- **Detached process-group behavior: narrowed.** Removed the new detached launch flag; journal records the actual OS PGID. Existing direct-child signal behavior is preserved. This does not claim descendant quiescence.
- **Canonicalization concern: tested across the real boundary.** Runtime consumes a launch, broker registration fails, journal records no-child, and the actual core G15 gate accepts that exact receipt for takeover. The serializers agree on real production data.
- **Evidence source vs dist: fixed.** The matrix runner rebuilds and records both source and workspace dist hashes, validates each requested file has assertions, rejects non-passing tests and detects mutations. Logs stream to files for inspection during runs.
- **Unbounded DB drainage: retained intentionally.** Timeout cannot authorize closing a DB with active producers. The runtime retains connection records, and finalExit settles after the observation callback. This limitation is documented.
- **Test helpers allegedly shipped: disproved for this CLI.** tsup builds only cli-entry.ts and reachable dependencies; helper symbols are absent from output JS. tsc here is type checking, not the publish pipeline.
- **Low-priority corrupt PID handling: improved.** Read-only observation returns unknown for invalid saved PID; capture still rejects invalid caller input.

## Matrix-discovered cancellation regression

The first real matrix ran 112 Loop tests, 65 core tests, and 195 CLI tests. One CLI cancellation case failed: an actual command received cancellation but its outer adapter had only 50ms grace while the inner executor owns 1s TERM and 1s KILL windows. A command that handles TERM and exits after150ms reproduced unknown instead of confirmed non-retryable failure. The command path now gives the outer adapter both inner windows plus500ms probe/drain/handoff allowance, still requiring actual stop evidence. Unknown adapter proofs are unchanged. The full seven-case findings suite passed after the fix. This changes a production grace contract; it does not loosen a test timeout or fake stopped evidence.

The first matrix and nested sandbox EPERM failures remain archived. No superseded run is counted as final acceptance. Final source-only model review and frozen-source Loop results are recorded separately.

## Final source review and follow-up

The complete-file review returned PASS for the bounded diagnostic slice. Its wording that the child.pid guard is “now” present is historical imprecision: the guard was already present and the added regression refuted the initial concern.

N1 was confirmed from workerCanonical: undefined keys form invalid JSON when interpolated. The journal now JSON-normalizes optional host fields before canonicalization; a real persisted round-trip test failed before the change and passed afterward. N2's two PGID tests now accept documented null degradation or a positive safe integer. N3 remains informational: all admitted evidence runs rebuild and bind dist hashes.

The first full Loop acceptance had 3265 passed / 2 failed; its matrix had 112 + 65 + (197 passed / 2 failed). Both failures were old chain assertions relying on the former 50ms cancellation window to force unknown. Retained actual command receipts prove process-group disappearance and non-retryable failed settlement. Updated assertions wait for bounded drainage, inspect genuine termination proof, match PGID to the execed command PID, independently check OS death, and require lock release. The fixture installs its TERM handler and writes PID before the started marker. The opaque adapter cancellation regression continues to require unknown and retained admission. These updates were submitted separately for source-only Opus review and a fresh full Loop acceptance; no failed prior run is counted as accepted.

## Delta review: PASS, informational items adjudicated

Actual Claude Opus 5 returned PASS for the final delta; N1/N2 are resolved. Its remaining observations do not require changing the frozen implementation:

- N4: the post-candidate 1s confirmation timer is a separate fail-closed guard. For commands, completion/confirmed cancellation has already settled commandPending, as verified in the prior complete-file review; an unconfirmed candidate throws before this timer. No broader timeout change is made.
- N5: migration 29 declares PRIMARY KEY(graph_run_id,generation) for graph_worker_launches, and GraphRuntime wraps consume plus authority checking in transaction().immediate(). Duplicate durable rows are impossible; the delta packet omitted those previously reviewed files.
- N6: leader is explicitly a fresh OS observation and observations is immutable historical evidence. The report and handoff document this distinction. Linux PID reuse yields identity_mismatch/unknown; macOS remains unknown. Neither field grants executor quiescence or recovery.
- N7: the regression's load-bearing property is successful JSON.parse of the persisted event. Normalization drops undefined properties; extra key-absence style assertions are not needed to reproduce the original failure.
- N8: shared workerCanonical's JSON-value precondition is unchanged. Current typed identity inputs have required strict fields; expanding the shared protocol helper is outside this fix.
- N9: assertion-message and unused-fixture-accessor nits do not affect semantics. The cancellation test independently requires a genuine stop receipt, matching group identity and observed OS disappearance before checking lock release.

Model reviews are source-only; the parent-run frozen-source OSStack Loop supplies test evidence.
