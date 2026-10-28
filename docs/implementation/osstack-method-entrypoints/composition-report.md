# PR291 + new main composition verification

Observed 2026-10-28. Composition commit `c85de1a96109c0efccdf9e1e1d5fc52a2a927e92`, parents `f92914e0a98bd3e5f82765fddc5a275a93637f30` and `7228af775ea13f2c0d8ebb2790c669dc07cfb89c`; tree `3e2f587932ee9ab47fd2613587b3a738ed1fb6cf` matches both the expected tree and actual `git merge-tree --write-tree` result.

## Executed scope

- Initially clean dedicated worktree, no node_modules; fresh `pnpm install --frozen-lockfile` and `pnpm build`, exit 0, Node v22.22.1.
- `pnpm smoke:skills-check`: 25/25 node tests, then actual compiled CLI all five cases. Actual case exits healthy=0, missing-ref=1, drift=2, mixed=1, empty=0; each verification passed, inputs unchanged, driver 0, owned fixture removed. Bad source remains a source failure; this is expected verifier success.
- `pnpm smoke:engineering-decision`: final 27/27 node tests, then actual workflow `action_receipt=applied`, `completion_level=observed_turn`; owned process exit confirmed and fixture removed.
- Python unittest discovery for both joint design validators: 241/241 passed.
- Both actual receipts bind the exact composition head and unchanged source/build digests. All preserved smoke manifest members were checked against actual bytes and lengths before lossless copying into this evidence directory. No formal/runtime/provider/principal qualification is issued.

## Preserved harness failures and correction

The first orchestrator incorrectly read skills run.json.fixture_root, a field specific to engineering. Skills had already exited 0 and produced complete evidence. The harness failed with KeyError and restored its tracked generated knowledge dist in finally. This failure is preserved in result.json; the successful skills command was not rerun.

The subsequent normal `pnpm build` used incremental TypeScript metadata and did not reemit the restored knowledge index. Engineering then failed 3 of 27 tests because the restored index lacked assembleExecutionContext; the package command's actual smoke stage was not reached. This is an observed verification-environment mistake, not an established product/combination defect. Original engineering.stdout/stderr and final-result.json remain unchanged.

Corrective `pnpm exec tsc --build packages/knowledge --force` reemitted every tracked knowledge dist file to exactly the first fresh-build SHA-256s. Only then was the engineering command rerun; it passed with complete actual evidence. Corrected outputs are separately named engineering-rebuilt.*, and repaired-result.json reports final outcome. This is not a blind same-environment retry or a claim the first invocation passed.

## Cleanup and bounds

Only four tracked knowledge index build outputs were restored to prebuild bytes, and only after matching this verifier's postbuild hashes. No unknown changes were overwritten. Final git status is clean. The branch/combination commit remains for root-managed worktree cleanup.

Minimal Node22 PATH, explicit external OSSTACK_HOME and OSSTACK_SCRATCH_ROOT, OSSTACK_SOCKET unset. No management/default home, paid model, product edits, PR or ledger writes. This is fresh composition-specific smoke/document validation, **not a combined full-repository test run**. All commands, raw logs, source/build inventories and copied actual evidence are retained. Provider qualification remains false.
