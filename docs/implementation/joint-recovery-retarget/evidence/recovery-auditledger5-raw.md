**Verdict: PASS**

I found no blocking bugs in the fix or in the surrounding code. This is a static read only, with no tools run, as requested.

**The fix**
- `refresh-ledger.py` now runs `git fetch origin main` after the PR queries, then compares `git rev-parse origin/main` against `observed_main`. The comparison is `assert observed_main==...`.
- `observed_main` is captured after the first fetch and before any `gh pr view` call, so it brackets the whole PR observation sequence. `main_sha` is set from `observed_main`, which is the value the comparison just confirmed.
- A failed fetch, a failed `gh` call, or a moved `main` all abort before `ledger-after.json` is written and before `execution-ledger.json` is replaced. All mutation happens on the in-memory `v` until the end, so a mid-run failure leaves the on-disk ledger unchanged.
- The ledger and the validator both state that PR observations are sequential and not atomic, and each PR has its own `observed_at`. The code matches that wording.

**Regression check**
- **Validation ordering:** `validator.validate(v)` runs before any write. The write goes to a temp file in the same directory and is committed with `Path.replace`, which is atomic on the same filesystem. The `finally` cleanup is harmless after a successful replace.
- **Main-base drift:** the `base_branch=='main'` and `base_sha` drift check is applied to every slice, not only the refreshed J02/J11 slices. If `main` moves, any unrefreshed main-based slice makes validation fail closed instead of being silently carried forward. That is the right behavior.
- **Ready guards:** the Ready path still requires all of the following:
  - the PR is open and not draft;
  - `evidence_status`, `audit.status`, and `validation.status` are current or passed;
  - `code_sha` is a 40-hex string and matches the validation `code_sha`;
  - the audit binding is read from a path confined under `evidence/`, and its `code_sha`/`code_commit` and `PASS` verdict must match;
  - `failed==0` and `passed>0`;
  - the base is exactly one of stacked or `main`, and a `main` base must equal `main_sha`.
- **Evidence paths:** `evidence()` resolves symlinks before the `is_relative_to(ROOT/'evidence')` check. This also covers `report`, `audit_binding`, the handoff report and archive, and the management snapshot. `test_path_escape` and `test_design_file_is_not_evidence` exercise it.
- **Retarget history:** it is only appended, deduplicated, and marked `historical`. The validator requires matching predecessor `candidate_history` evidence with an `evidence_url`, so a fabricated predecessor fails.
- **Docs-only head commits:** `head_sha` is bound to the observed PR head, while `code_sha` is bound to the candidate, audit, and test summary. Keeping the two separate matches the stated design. Milestones stay incomplete: J01 becomes `in_progress`, J02/J11 become `candidate_pr_open`, and `runtime_enabled=False` is enforced by the validator.

**Tests**
- Coverage matches the guards: stale versus real drift, retarget to `main`, historical or pending evidence, wrong code or binding, REVISE binding, failed or zero test counts, closed or merged PR mismatches, the handoff hash, path escape, owner, and runtime forgery. I found no test that passes for the wrong reason.
- `test_ready_revise_binding` patches `json.loads` and only mutates a dict containing `code_commit`. If the fixture binding used only `code_sha`, the test would fail (no `ValueError`) rather than pass falsely, so it can't hide a regression.
- `setUp` upgrades only the in-memory fixture, and the preserved snapshot bytes are untouched.

**Non-blocking notes (no change required for PASS)**
- The refresh safety checks use bare `assert`. Running the script with `python -O` would strip them, including the new main-moved check. Using `if ...: raise SystemExit(...)` would make them robust, but the script is invoked normally.
- A move of `main` after the second fetch and before the write is an inherent race for an offline snapshot. `observed_at` and the documented observation window describe it honestly.
- The hardcoded absolute paths make this a local operator script, which is acceptable for a checkpoint refresh tool.

**Result:** the missing second fetch is correctly fixed, and I found no regression in the validator, tests, or refresh flow. The checkpoint stays a historical offline observation with milestones incomplete and `runtime_enabled=false`.