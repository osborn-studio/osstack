# Closure audit: PR279 evidence-refresh script and owner prose

Scope: the supplied script, `project-operations.md`, `execution.md` and the dispositions. I ran nothing and did not review product code. Nothing here assumes PASS for the pending full run. The validator source was not supplied, so claims about its behavior are marked unconfirmed.

## Blocking (confirmed)

**B1. P1-5 is not fully closed: `execution.md` still says "#279 已合入这个 main".**
- Location: `execution.md`, section "#282 合并后的 #279 重验", first sentence of the second paragraph.
- Problem: this reads as "#279 has been merged into main". The script itself asserts `prmap[279]['state']=='OPEN'`, so the sentence is false. It is the same early-completion defect P1-5 raised, and the disposition says the prose was reworded.
- Fix: say "#279 已改基于/同步到该 main，正在重验" ("rebased onto / synced to this main, revalidation in progress"). This is a prose-only change. Re-check just that sentence.

## Non-blocking (should fix or confirm before executing)

1. **The `validate_published` result is not asserted.** The script does `print(v.validate_published(ledger))` and then writes the ledger regardless. This is safe only if the function raises on failure. I cannot confirm that without the validator. If it returns a status or error list, add an assert. This is a one-line change and the staged ledger tests would catch it later anyway.
2. **`sys.path.insert(0, '/…/session-debt-20261026')` is still there.** The `exec(compile(raw…))` fix resolves the pyc concern from P2-1. The insert is now unneeded, but it still lets that scratch directory shadow stdlib or validator imports. Delete the line.
3. **The retained failed full-suite run can abort the script.** The script requires every `verification['commands']` entry to have `exit_code==0` and exactly one `pnpm test` entry with `code_sha==code`. If the earlier environmental-failure run is recorded in `verification.commands`, the script aborts. That is fail-closed, not unsafe. Keep the retained failed log in the manifest but outside `commands`, or record it in a separate field, before running. If the deterministic12test fix sits in a commit after `cb76`, `diff_proof` will also reject it as a non-docs diff.
4. **The raw-audit membership check is a substring heuristic.** It looks for `input`, `response` or `raw` in manifest names. It is not tied to files named in the binding. This is acceptable as a residual of P1-2, but it is weaker than the disposition wording suggests.
5. **The receipt lower bound is hardcoded** (`2026-10-27T13:46:58+00:00`). Comparing against `prmap[282]['mergedAt']` would bind it to the observed merge.
6. **The validator is loaded from a file path.** The bytes are pinned to main, so this is low risk. `exec` on `validator_bytes`, as is done for the helper, would remove any pyc ambiguity.
7. **README content is not checked against `test-summary.json`.** The README is hash-bound but not read for consistency with the final counts. Check this manually when the full run lands.
8. **A rerun after partial failure fails at `src.mkdir(exist_ok=False)`.** This is a liveness issue only, and the partial evidence is deliberately retained. The `execution-ledger.json.next` temp file can also be left untracked; exclude it from `git add`.

## Dispositions accepted

- **P1-1:** reading from `git ls-tree`/`git show` at the observed head, plus the code-ancestor and docs-only diff, closes the contamination risk. The remaining check is the manual post-push head and diff re-read.
- **P1-2:** the exact file set, raw hashes, path confinement, log binding and destination re-check are all present and correct.
- **P1-3:** base, time and board-status checks are implemented. The scope is labelled owner-attested.
- **P1-4:** the byte compare, `os.replace` and single-writer statement are adequate.
- **P2-2, 6, 7, 9, 10:** verified in the code.
- **P2-3, 4, 5, 8, 12, 13:** the deferrals are reasonable given the validator is unchanged and publication re-checks CI.
- **P2-11:** the worker table and #282 row are consistent with the last section.

VERDICT: REVISE
END_AUDIT