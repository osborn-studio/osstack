**REVISE**

Concrete bugs only:

1. **refresh-ledger.py, wrong `observed_at` ordering (consistency).** The PR loop stamps each PR with its own `observed_at`, then `main_sha` is read via `git rev-parse` afterward and the top-level `observed_at` is set last. `now` is computed but never used. The ledger-level timestamp therefore post-dates the PR snapshots and the `main_sha` read. This is a minor skew, but the checkpoint claims a single observation moment. Compute `main_sha` first, or document that the timestamps are sequential.

2. **refresh-ledger.py, `git fetch` is not tied to the observed `main_sha`.** `main_sha` comes from `origin/main` after the PR loop. If main advances between the `gh pr view` calls and `git rev-parse`, the ledger records a main SHA newer than the PR base state it observed. The candidate assert (`candidate['base_sha']==v['main_sha']`) catches mismatches with the candidate, but not PR/main skew. Capture `main_sha` once, before the PR queries, and re-check it after.

3. **refresh-ledger.py, non-atomic effects on partial failure.** `ledger-after.json` is written to `out/` before the replace. That is acceptable. However, J01 handling does `continue` before any check that the 273 PR is the only slice needing update. If `part` for J01 has no PR 273, `next(...)` raises a bare `StopIteration` with no message. The same applies to the J11/J02 lookups. Use `next(..., None)` plus an explicit error.

4. **refresh-ledger.py, hardcoded J01/J02/J11 → PR 272/273/274/281 mapping.** `kind` is derived as `'recovery' if J11 else 'source'`, so any other ID in the list silently becomes `source` with PR 281. The list is currently fixed at three, so this is latent. Make it an explicit dict keyed by ID.

5. **refresh-ledger.py, `retarget_history` dedupe is exact-dict equality.** If `reason` text changes, a duplicate entry is appended on rerun. The validator accepts duplicates. Dedupe on `(base_pr, base_sha)`.

6. **validate-execution.py, `evidence()` is called with `ledger['handoff']['report']` for the sha check, then the hash is read from `ROOT / path` without resolving through `evidence()`'s return value.** The validated target and the hashed file are the same string, but the code re-derives the path. This is a TOCTOU-style inconsistency. Hash the `evidence()` return value instead.

7. **validate-execution.py, `evidence()` bounds to `ROOT/'evidence'`, but `ROOT / ledger['handoff']['report']` is also used by the test `test_design_file_is_not_evidence` (README.md).** This works because the bound check rejects it. Fine, but `import hashlib` inside the function is stylistic and should be at the top.

8. **validate-execution.py, `binding.get('code_sha', binding.get('code_commit'))`.** If `code_sha` is present but empty or null, the fallback is skipped and the comparison fails with a misleading message. It is also not verified that the binding's `verdict` is PASS in the validator. Only the refresh script asserts this. A hand-edited binding with `REVISE` would pass validation, since the ledger's `audit.verdict` is checked, not the binding's. Add `binding.get('verdict')=='PASS'`.

9. **validate-execution.py, validation fields not cross-checked.** `validation.failed==0` and `passed>0` are asserted only in refresh, not in the validator. A ledger with `status: passed_for_code_sha` and `failed: 3` validates. Add those checks to the Ready branch.

10. **validate-execution.py, `retarget_history` predecessor check uses `x.get('pr') == history['base_pr']`.** This is fine, but there is no check that the retargeted part is currently not `base_pr`-stacked. `test_bad_retarget_history` passes only because the SHA is absent from the predecessor history. Acceptable, though weak.

11. **test_validate_execution.py, `setUp` mutates the frozen fixture's slice index `[1]` positionally.** This is brittle if slice order changes. Select by `pr`.

12. **test_validate_execution.py, `stale_slice` shadows `p` (the module-level Path) inside a generator expression.** `next(p['headRefOid'] for p in ...)`. In Python 3 the generator has its own scope, so this does not break `p`. It is a readability hazard only.

13. **refresh-ledger.py hardcodes absolute paths** (`/Users/osborn/...`, `/Volumes/...`), so the script cannot be reused or reviewed elsewhere. Take them as arguments.

**Highest priority:** items 8 and 9 (the validator accepts a Ready slice with a failing audit binding or failing test counts), then 1 and 2 (timestamp and main-SHA skew).