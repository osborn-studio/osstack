**Verdict: REVISE**

Concrete bugs only; no tools run.

1. **Validator: stale-slice checks run only when `base_pr` is present, so a retargeted slice keeps no memory of its predecessor.** `retarget_history` written by the refresh script is never validated. The validator doesn't check that it exists, that its `base_sha` matches a predecessor `candidate_history` entry, or that it's historical. Dropping it passes silently. Add a check: if a slice has `base_branch=='main'`, no `base_pr`, and a prior-retarget marker, require well-formed historical history. No test covers it.

2. **Validator: `ready` guard only runs inside `if 'pr' in part`, and the base checks depend on `base_branch`/`base_sha` being present.** A ready slice with `pr` but no `base_branch` and no `base_pr` skips every base-drift check (both the `main` check and the `base_pr` check). Require that a ready slice has exactly one of `base_branch=='main'` with `base_sha==main_sha`, or a valid `base_pr`.

3. **Validator: ready check doesn't bind evidence to the code.** `evidence_status` is only compared against `'historical'`, and `audit.status` is never checked in the ready path. Only `audit.verdict=='PASS'` and `validation.status` are. A ready slice with `audit.status=='historical'` passes. Require `evidence_status=='current_for_code_sha'` and `audit.status=='current_for_code_sha'`. The same applies to a `code_sha` mismatch: nothing checks that `validation`/`audit_binding` reference `part['code_sha']`. The test `test_ready_missing_audit` only flips the verdict.

4. **Validator: `done` check indexes `prs[s['pr']]` after `'pr' in s`, with no check that the PR is known.** A slice referencing an unknown PR in a done node raises `KeyError` instead of `ValueError`. Minor, but tests expecting `ValueError` would error out instead.

5. **Validator: `history` uses `h['sha']` directly.** A malformed `candidate_history` entry raises `KeyError` rather than a validation failure. Use `h.get('sha')`.

6. **Validator: `datetime.fromisoformat` can raise a raw `ValueError` on bad input (fine) but also accepts naive strings, which are caught by the tz check.** It doesn't validate the top-level `ledger['observed_at']`, which refresh writes, or that each PR `observed_at` is not earlier than something expected. Add a top-level `observed_at` check, since `main_sha` is only meaningful with an observation time.

7. **Validator: `import hashlib` mid-function, and the handoff hash read uses `ROOT / path` without the `evidence()` resolved target.** The path was validated just above, so this is safe but redundant. Use the resolved path returned by `evidence()`.

8. **Validator: `evidence()` checks `is_relative_to(ROOT)` on the resolved path, but ROOT is the whole design directory, not the checkpoint root the task describes.** Evidence may therefore point at any file in the design dir, such as `execution-ledger.json` or `work-packages.json`, and the hash/evidence checks pass. Restrict to `ROOT/'evidence'`, or the checkpoint subtree.

9. **Refresh: the snapshot is overwritten before verification.** `pr.clear(); pr.update(fresh)` replaces the PR record and drops any extra ledger fields. Refresh also runs `git rev-parse origin/main` with no `git fetch`, so `main_sha` may be stale relative to the `gh` observations taken at `now`. That produces a mismatched main/PR snapshot. Fetch first, or read main via `gh api`.

10. **Refresh: not idempotent and no pre-write validation.** The J01 branch is rerunnable, but `retarget_history` is overwritten by a hardcoded `fad0dd45…` rather than derived from the slice's existing `base_sha`. A rerun after the keys were popped would silently rewrite history with the constant. Derive it from the existing `base_sha`, and append rather than replace. The script also never calls the validator before writing `execution-ledger.json`, so a bad write leaves the ledger inconsistent. The write is also non-atomic and happens before `ledger-after.json`. Validate first, then write to a temp file and rename.

11. **Refresh: PRs 273/274/281 are processed unconditionally.** There is no check that #273 has `state=='MERGED'` before J01 is set to `merged`. Only 274/281 get asserts. `part['state']='merged'` for #273 should assert `state=='MERGED'` and a non-null `mergeCommit`.

12. **Refresh: `milestones` mutation uses `next(...)` without defaults.** A missing slice raises `StopIteration` after PR records were already replaced in memory. Nothing is written, so this is harmless, but the error is unclear.

13. **Refresh: `candidate['code_sha']` and the test summary aren't checked.** Nothing verifies that the summary's `code_sha` equals the candidate's, that tests passed, or that the report/binding files exist under the evidence root. The validator doesn't check them either (see 3). `{**report, ...}` can also let a summary key overwrite nothing important but injects untrusted fields into the ledger. Whitelist the fields.

14. **Refresh: hardcoded absolute paths** (`/Users/osborn/...`, `/Volumes/...`). Acceptable for a one-off, but accept arguments if reused.

**Test gaps:** no tests for `retarget_history`, `audit.status`, `code_sha` binding, a ready slice with no base fields, or evidence-root restriction (items 1–3, 8).