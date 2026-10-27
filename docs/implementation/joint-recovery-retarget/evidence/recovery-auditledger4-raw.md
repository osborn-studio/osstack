**Verdict: REVISE**

Only one concrete bug blocks this. I read the source as data and ran nothing.

**Blocking**

1. **`refresh-ledger.py`: the main-drift assertion can never fail.**
   - The script runs `git fetch origin main` once, at the top. It then observes every PR, which takes a while.
   - Afterwards it asserts that `git rev-parse origin/main` equals `observed_main`. That reads the same local ref with no second fetch, so the assert always passes.
   - If main advances during the PR observations, `v['main_sha']` is stale. Ready slices would then be stamped with a `base_sha` that is no longer main, and the validator would accept them because it only compares against `ledger['main_sha']`.
   - The comment says the window is non-atomic, but the code implies a check that never happens.
   - Fix: repeat `git fetch origin main --quiet` immediately before the assert, and fail or retry if the SHA changed.

**Non-blocking (fix if cheap)**

2. **`validate-execution.py`, `done` check: wrong exception type.**
   - `prs[s['pr']]` raises `KeyError` for an unknown PR, not `ValueError`.
   - Slices with a `pr` are already checked against `prs` earlier, so this is only reachable for malformed done nodes.
   - Tests that expect `ValueError` would see a different exception there.

3. **Validation report content is not tied to the audited summary.**
   - Refresh asserts on `out/<kind>-test-summary.json` and `audit-code-binding.json`.
   - `validation.report` (the `README.md`) is only checked for existence under `evidence/`, and it is not hash- or SHA-bound.
   - A mismatched README would pass. The risk is low for a historical checkpoint.
   - You could optionally require the README to contain `code_sha`.

**Checked and found sound**

- **Evidence paths:** `evidence()` resolves the path, so `..`, absolute paths and symlink escapes are rejected. Anything outside `evidence/` is rejected, and the test that points the handoff report at `README.md` is consistent with that.
- **Ready gate:** the validator requires an open, non-draft PR, current evidence and audit, `code_sha` bound to both validation and the audit binding, a PASS verdict, `failed == 0`, `passed > 0`, and exactly one of stacked-or-main base. A main base must equal `main_sha`.
- **Stale and retarget handling:**
  - Retarget history requires historical status and predecessor evidence.
  - Stale slices must be blocked, have real drift, and carry a revalidation action.
  - A closed or merged predecessor forces a blocked stacked slice.
- **Safety invariants:** `runtime_enabled is False`, owner and handoff, a timezone-aware `observed_at` at both checkpoint and PR level, the 32-milestone identity, and `done` requiring acceptance and merge evidence are all enforced.
- **Intentional design:**
  - Code SHA differing from head SHA is allowed.
  - Milestones stay incomplete: J01 is `in_progress`, and J02/J11 are `candidate_pr_open` and blocked.
- **Refresh write path:** the ledger is validated in memory before the write. It goes through a temp file and `replace`, with cleanup in `finally`. The retarget-history append is idempotent. The candidate base, binding and report are asserted against `main_sha` and `code_sha`.
- **Tests:** they cover the fixture upgrade, stale, retarget and ready negatives, and the `json.loads` patch for a REVISE binding. I found no shadowing or logic errors. The `p` inside the generator expressions is local.

Apply fix 1 and this is a PASS. Fixes 2 and 3 are optional.