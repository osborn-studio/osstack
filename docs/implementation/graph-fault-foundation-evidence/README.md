# G25 diagnostic foundation evidence

This is an implementation-stage record, not full G25, C8, recovery, or production admission. G25 remains in_progress; total completed tasks remain 25/30. Final accepted source and Loop results are listed in admission.json.

## Chronology and interpretation

1. `opus-design-response.json`: actual Claude Opus 5 design consultation; modelUsage retained.
2. `G25-process-actor-*`: actual OSStack Loop coding actor, executed one task. Its diff-check alone is not full acceptance. Intermediate actor notes describe an earlier detached-worker implementation; the final source removes that behavior.
3. `process-chain-full.txt`: nested coding sandbox prohibited Unix socket listeners (13 EPERM failures). These tests were later run by the parent without that environment restriction; none were skipped for acceptance.
4. `opus-code-response.json` plus `review-adjudication.md`: first source review and source/test-backed adjudication. The original child.pid guard refutes the reported no-child classification issue. Failed exit journaling was a real defect, fixed with a discriminating test.
5. `superseded-matrix-1/`: first seeded matrix exposed the command cancellation grace mismatch. `cancel-grace-red.txt` and `cancel-grace-green.txt` preserve the deterministic 150ms TERM-handler regression and fix.
6. `opus-final-response.json`: source-only PASS for the bounded slice, with non-blocking N1/N2/N3. It is not evidence of model-run tests. `journal-json-red.txt` and `post-review-green.txt` show the optional-PID JSON fix and nullable-PGID test update; targeted skipped tests are unselected cases, not an acceptance run.
7. `superseded-acceptance-1/`: 3265 full-suite passes and two old cancellation assertion failures; matching matrix failure preserved. The old guaranteed-unknown expectation depended on the previous 50ms timeout. Actual stopped receipts justified updating the chain tests to verify true process-group stop, non-retryable failure and released locks. Opaque adapter unknown/held coverage remains.
8. `opus-delta-response.json`: source-only review of the final JSON, PGID and chain-fixture changes. Final acceptance uses a new Loop task and frozen source hashes.

The top-level `process-*`, `parent-*`, and intermediate build/test files are development chronology and may refer to earlier source revisions. Only final admission references are accepted evidence. Absolute temp paths in raw logs identify actual runs; the retained copies here are the portable archive. The matrix's coverage map names associated regression files, not every F01–F12 subwindow.
