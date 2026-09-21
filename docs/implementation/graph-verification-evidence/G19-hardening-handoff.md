# G19 hardening handoff

## Scope

Only these repository files were edited:

- `packages/cli/src/graph-verification.ts`
- `packages/cli/src/graph-verification-store.ts`
- `packages/cli/src/graph-verification.test.ts`

No commits, full suite, delegation, or edits to parent-owned coordinator/core/compiler/broker. Commands and checks used `OSSTACK_HOME=/Volumes/AIMATE_WORK/tmp/gc6/home` and `TMPDIR=/Volumes/AIMATE_WORK/tmp/gc6`; no development CLI opened the default control-plane home.

## Implemented

### Candidate integrity after execution

Both restored workspaces are initially checked against the frozen artifact with strict inventory. The host captures original HEAD, HEAD tree, index tree, logical index entries/stages/flags digest, raw tracked file bytes and full modes digest, and independent repository identity digest. Review additionally captures full workspace inventory, including ignored/untracked entries. Tests may create untracked build outputs, including on later verification checks.

Persistence observes candidate identity again. Any mismatch or unreadable candidate observation produces `INTERNAL_ERROR`, `retrySafe:false`, and no confirmed result, even when the registered command exits successfully. Evidence persists `candidateIdentity.before`, `candidateIdentity.after` (identity or bounded observation error), and `workspaceLeaseRef`. Raw tracked paths originate from the frozen Git tree rather than a possibly manipulated index; assume-unchanged does not hide byte or mode changes. Index flags themselves are also checked. Candidate observation and ledger identity are rechecked across publication awaits; a further change refuses publication/confirmation and falls back to the broker's conservative uncertainty path.

### Actual reviewer invocation receipts

Inspected the real `AgentTask` definition, `packages/loop/src/candidate-execution.ts`, G04 executor task construction, and the broker invocation path. This checkout calls `executeCandidateImplementation`; no symbol named `executeRegisteredCandidateOnce` was found in those sources. The G04 executor defaults `session_id` to `sess_${plan.plan_id}`, so preparation-only plan freshness does not isolate explicit retry.

The host adapter wrapper now allocates a new UUID v4 `session_id` per actual invocation. It rebuilds `AgentTask` from captured trusted values, preserves the actual G04 run/task identity, supplies the registered capability and fixed review prompt, and passes exactly `{ repo_path: registeredReviewWorkspace }` as context. Incoming history and native resume hints are not forwarded. The wrapper uses one-shot `invoke`, not a resume API.

Durable `reviewerInvocation` records run/task/session/adapter/capability identity, actual prompt SHA-256, exact context SHA-256, `historyPassed:false`, and the actual running effect key. Persistence refuses absent or wrong-attempt invocation receipts. Direct review fixtures now execute the real G04 path before persistence; production does not synthesize receipts for uninvoked review evidence. The independently supplied `verifyReviewer` callback remains mandatory, including invocation-time checks. Constructor callback/data capture before the first await remains intact.

### Evidence validation and size

Loading validates the new required identity/lease fields and reviewer receipt fields, cross-checks run/task/adapter/effect identity and context digest, requires UUID v4 sessions, and refuses candidate mismatches unless classified non-retryable internal failures. Review prompt digests are recorded from the actual forwarded prompt and validated as SHA-256 values on load. Old G19 envelopes without these new fields fail closed; no compatibility migration is provided.

The publisher explicitly checks the serialized UTF-8 envelope is at most 65,536 bytes before any evidence directory/file publication. The reader also checks actual bytes after reading, in addition to the prior stat size check. The oversized multibyte test verifies no evidence file is published. Truth: the existing generic bounded Graph JSON validator already rejected the oversized fixture before these changes; this was not reproduced as a previously accepted oversized file. The explicit publisher guard is additional enforcement of the storage contract.

## Validation

Final focused test result: **27/27 passed**, one file, 77.44 seconds total. Command: `pnpm --filter @osstack/cli test src/graph-verification.test.ts`. The stop-unconfirmed lease-retention log is expected from the explicit unknown-stop test.

- `pnpm --filter @osstack/cli typecheck`: passed.
- `pnpm exec biome check packages/cli/src/graph-verification.ts packages/cli/src/graph-verification-store.ts packages/cli/src/graph-verification.test.ts`: passed, 3 files, no fixes.
- Initial failing run: five actual successful command mutations became confirmed passes; explicit broker retry reused its session. An additional size assertion initially expected a different error message despite pre-existing rejection; that assertion was corrected to accept bounded-JSON rejection.
- The intermediate implementation run passed 22/23 cases; its only remaining failure was that size error-message expectation. One test helper type error (optional workspace) was corrected before the passing final typecheck.

Logs:

- `/Volumes/AIMATE_WORK/tmp/gc6/G19-hardening-red.log`
- `/Volumes/AIMATE_WORK/tmp/gc6/G19-hardening-green.log` (intermediate run)
- `/Volumes/AIMATE_WORK/tmp/gc6/G19-hardening-focused-final.log`
- `/Volumes/AIMATE_WORK/tmp/gc6/G19-hardening-typecheck-final.log`
- `/Volumes/AIMATE_WORK/tmp/gc6/G19-hardening-biome-final.log`

## Exact limits

- Same UID remains a non-sandbox boundary. The host checks final observed state and confirms executor stop via existing broker contracts. It cannot detect mutations restored before observation or prevent arbitrary external same-UID processes from racing/replacing files, forging host storage, or accessing other workspaces.
- Candidate index identity is logical contents/stages/flags and tree, not byte-for-byte index cache metadata; ordinary Git cache refreshes are allowed.
- Fresh sessions and stripped context are demonstrated at the actual adapter API boundary. No live provider invocation was made; adapter-internal/provider-native history isolation still depends on the trusted adapter and independent identity verifier.
- Receipts are durable with completed verification evidence; stopped-but-unconfirmed executions remain unknown and do not get a fabricated completed receipt.
- Repeated raw inventory and Git checks add work during verification/publication. No production performance benchmark was run.
- Only the focused owned CLI verification test file, CLI typecheck, and owned-file Biome were run. This does not establish parent join/coordinator integration or G21 readiness.
