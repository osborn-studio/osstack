Original static audit text, unchanged in fence:

````text
# Verdict: PASS for F1–F5 closure (static, nothing executed)

I read the pasted diff and the four final files. I did not confirm that they match `309fb645…` or that the author's hashes match them. I traced the 49 tests by hand against the code; I did not run them, and I cannot confirm the author's test, real-projection or CI results.

## Closure by finding

| Finding | Status | Basis |
|---|---|---|
| F1 | Closed | `validatePacket` now requires non-passed rows to have cleanup `unknown` or `not_started` with `fixture_removed === null`. Passed rows must have `reported_product_exit === null`. `not_created` rows must have no reported cleanup, no consistency flag, no reported exit and null bindings. `cleanup()` rejects `not_started` with a removal claim. `buildProjection` ends in `validatePacket`, so the projector and `--check` share these rules. |
| F2 | Closed | `failed_receipt_conflict` is gone. A driver-pass / verifier-fail row stays `failed`, with `product_exit:null`, cleanup unknown, the reported exit and `reported_cleanup` kept as unverified claims. The case-manifest `verified:false` binding still holds. |
| F3 | Closed | `verifyPassed` now requires `run.json`. It checks the run id across the manifest, receipt and run, plus run status and selected case. It also checks unchanged run bindings equal to the receipt digests, `receipt.behavior` and `failure`, input identity, and command/detail agreement. The `detail` ⊇ `observed` check is stricter than the original. |
| F4 | Closed | `bounded()` sizes the buffer from `fstat` and returns a copy. `names()` uses `opendir` and rejects past the limit. The limits are 132 for the root (129 + 3 allowed directories), 129 for a case, 2 for `cases/` and 2 for the packet. |
| F5 | Closed | The CLI emits `error.message` only when it matches `^[a-z_]+$`. `original_evidence_modified` is replaced by `input_opened_read_only:true`, and the README no longer claims a measured immutability result. |

## Cross-case invariant (your important note)

This is correct. The equality check `equal(features[0].bindings, features[1].bindings)` sits inside `if (p.journey_status === 'passed')` only. A failed journey with `failure:'cross_case_bindings_changed'` and two passed rows with different digests still projects. This matches `runJourney`, where `features[index]` is already the passed object when `cross_case_bindings_changed` throws. The two tests `successful journey cannot hide differing cross-case binding digests` and `late cross-case binding failure retains both individual rows…` cover both directions.

## Observations (non-blocking, outside F1–F5)

1. **A legitimate sealed failed driver run with `cleanup.status:'not_required'` cannot be projected.**
   - The driver emits `not_required` in `smoke-skills-check.mjs` when no fixture was allocated. That can happen if `sourceBindings` or the core import throws after evidence is reserved. It then writes and seals the receipt, and the journey records `drive_execution_failed`.
   - `buildProjection` calls `cleanup(cleaned)` and `cleanup(receipt.cleanup)` before the verification branch, and `cleanup()` only accepts `passed/failed/unknown/not_started`.
   - Reproducer (inferred from reading, not run):
     1. Take the passed fixture.
     2. In `cases/healthy`, set both `cleanup.json` and `receipt.cleanup` to `{status:'not_required', fixture_removed:false, reason:'fixture_not_allocated', descendant_termination:'not_attested'}`.
     3. Set `receipt.status:'failed'` and `driver_exit:1`.
     4. Set the journey row to `verification:'failed'`, `driver_exit:1`, `product_exit:null`, `product_status:'unknown'` and cleanup `unknown`. Set the journey status to `failed`.
     5. Reseal the case and root, then call `projectJourney`.
     6. It rejects with `cleanup_status`.
   - This fails closed and was already true before this change. Decide whether to accept `not_required` for reported and actual cleanup on non-passed rows, or document it next to the `unsealed` limitation.

2. **Some retained-only checks from `verifyCaseEvidence` are still not ported.** These are binding anchors and entries, fixed source `ref` and `blessed_sha === current_sha`, `command_output_paths`, the `run.commands` / `git-*` records, and `environment.json`. A re-signed archive could change the ref or SHA fields and still project as passed. The README's "does not repeat the complete original verifier" and "re-signed" language covers this, and none of it was in the F3 list.

3. **A passed row's stdout fails closed if it carries an extra allowlisted line.** For example, a healthy stdout with an extra `1 source(s) failed to check.` line passes `evaluateCase` (which uses `includes`) but trips `passed_snippet_conflict`. This is unreachable with the real CLI.

4. **The README sentence that the author "compared all original file hashes before and after" is an author-run claim I cannot verify here.**

The remaining gates, root final checks and published CI, are still pending as you noted. Merge remains your decision.
````
