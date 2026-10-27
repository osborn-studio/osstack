**Verdict: REVISE.** The refresh and test structure is sound. It fails closed, keeps `runtime_enabled=false`, keeps milestones incomplete, and the path-escape and hash checks work. I found a few concrete validator gaps and one refresh timing bug.

## Bugs

1. **Ready PR state is not checked** (`validate-execution.py`, ready block). The validator requires `not pr['isDraft']` but never requires `pr['state'] == 'OPEN'`. A `ready` slice whose PR is `MERGED` or `CLOSED` passes. The refresh script asserts `OPEN`, but the validator is the shared guard and should enforce it too.
   - Fix: add `require(pr['state'] == 'OPEN', 'ready PR not open')`.

2. **`merged` slice state is not tied to the PR** (same file). Only `done` nodes check `prs[...]['state'] == 'MERGED'`. A slice marked `merged` whose PR is `OPEN` validates fine. The refresh asserts this only for #273 before setting `merged`.
   - Fix: when `part['state'] == 'merged'`, require the PR state is `MERGED` and `mergeCommit` is set.

3. **A stacked slice on a merged base is not rejected.** The non-stale branch only requires `base_sha == observed_base`. After #273 merges, any other slice still carrying `base_pr: 273` (not just #274 and #281, which the refresh retargets) passes as long as its pinned SHA equals #273's final head. Nothing forces retargeting or revalidation. The same applies to a base PR that is `CLOSED`.
   - Fix: if `prs[base_pr]['state'] != 'OPEN'`, require stale or blocked status.

4. **Missing `audit_binding` raises `KeyError`, not `ValueError`.** `part['validation']['audit_binding']` is indexed directly in the ready block. The `report`/`audit_binding` loop at the end is guarded, but this line is not. A malformed ready slice crashes instead of failing with a clear message, and no test covers it.
   - Fix: `require('audit_binding' in part.get('validation', {}), ...)`.

5. **`observed_at` predates the observations** (`refresh-ledger.py`). `now` is taken before the `gh pr view` calls and before `git rev-parse origin/main`, then stamped on all of them. The recorded observation time can be earlier than the state it describes, which matters for a snapshot that claims "GitHub at observed_at".
   - Fix: take a timestamp immediately after each `gh` call, and set the ledger `observed_at` to the latest one after `main_sha` is read.

6. **Partial PR refresh leaves mixed observation times.** Only PRs 273, 274 and 281 get a new `observed_at`, but the ledger-level `observed_at` and `main_sha` are refreshed. Other PRs keep older times under a newer checkpoint, and the validator only checks that the timestamp exists and has a timezone.
   - Either refresh all PRs the ledger references, or state in the report that per-PR times differ. The validator could also require each PR's `observed_at` to be no later than the ledger's.

7. **Failure leaves stray state** (`refresh-ledger.py`). If validation or the write fails, `execution-ledger.tmp.json` may remain. `ledger-after.json` is written after the replace, so a failure there leaves the ledger updated without its after-copy.
   - Fix: write `ledger-after.json` first, or clean up the temp file in `finally`.

## Test gaps

Add tests for bugs 1 to 4: a ready slice with a merged PR, a merged slice with an open PR, a stacked slice on a merged base, and a ready slice with no `audit_binding`.

## Minor

- `setUp` and the stale tests index `milestones[0]['slices'][1]` and `milestones[1]['slices'][0]` positionally. Look slices up by PR number so reordering doesn't silently change what is tested.
- `refresh-ledger.py` hardcodes the audit `model`, `verdict`, and `scope`. It relies on the validator's `audit_binding` code-SHA match and does not read an audit verdict from evidence. You said proof parsing belongs elsewhere, so I'm noting this only so the scope is explicit.