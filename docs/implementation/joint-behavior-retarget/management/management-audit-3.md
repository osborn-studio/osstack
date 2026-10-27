# Closure Review Round 3: Verdict REVISE

This is a static review of the pasted text only. I did not run anything, and I cannot verify forge, CI, or board state. No P0 found; the P1s below are all fixable locally.

## P0
None.

## P1 (fix before closure)

1. **The `done` gate accepts any hashed file.**
   - In `validate-execution.py`, the `done` branch calls `hashed_evidence` on `acceptance_evidence` and `merged_candidate_ci_evidence`, but never checks what those files contain.
   - `completed_node()` in the tests sets both fields to the handoff report, and that passes. `acceptance: "passed"` is self-declared.
   - This is exactly the false-completion path you asked about, even though no ledger node is likely `done` today.
   - Minimum fix:
     - Require the two paths to be distinct and neither to equal the handoff report.
     - Require each file to be JSON containing the node id.
     - Require the CI file to name the merge commit, matching the observed `mergeCommit.oid` of each slice PR.
   - Add negative tests for each.

2. **The base-drift check is skipped for non-Ready successors.**
   - For `deliveries`, `main_sha` is compared to `base_sha` only inside `ready()`.
   - A `revalidating` or `blocked` successor with `evidence_status: current_for_code_sha` and a stale `base_sha` passes `current_evidence`. Milestone slices do have this check ("main candidate base drift"), so the two paths are asymmetric.
   - The refresh script asserts `base == main` for #282 only at run time. The validator itself would not catch a hand-edit or a later refresh.
   - Fix: for any non-merged successor with `base_branch == 'main'` and a `base_sha`, require `base_sha == ledger['main_sha']`, or require status `historical`. Add a test.

3. **The audit PASS is extracted by substring and then hard-coded.**
   - The archive script asserts `'Verdict: PASS' in audit['result']`, then writes `'verdict':'PASS'` as a literal.
   - A round-4 report that quotes an earlier PASS, or that ends in REVISE, still satisfies the check.
   - The binding also records the audit file name but no hash, and the audit text is not tied to `code_sha` or `reviewed_base`.
   - Fix:
     - Parse the last `Verdict:` line and require exactly PASS.
     - Require the audit text to contain the `code_sha` and base prefixes.
     - Store the audit file's sha256 in the binding.

## P2

1. **Recorded but unverified hashes.**
   - The validator hash-checks `checkpoint_history`, `receipts`, and the joint snapshot.
   - `board_snapshots` (two of the three boards), `rpc_helper.sha256`, and `parallel_preflight.report_sha256` are written by the script but never re-checked.
   - Either validate them (all are under the evidence root, except the preflight report) or describe them as "recorded, not enforced". Your disposition says "recorded", which is accurate.

2. **Receipt contents are never read.**
   - The validator checks only that the four receipts exist and match their hashes; a `{}` file passes, as the tests do.
   - The refresh script hard-codes the obligation text "279 … now assigned to terminal_preflight", and the heartbeat claim comes from a copied receipt.
   - Check at minimum `automationId == 'osstack'` and `goal_dispatch_enabled is False`, or label these as owner-attested.

3. **CI state is not enforced.**
   - The script can emit `state: ready` with `merge_readiness.ci: pending_or_failed_at_observation`.
   - Section 3.5 of `project-operations.md` allows that only as "Ready, checks pending". The validator does not require the `ci` field or check that it exists, so nothing stops a batch generator from listing such a PR as approvable.
   - Require the field to be present and keep the batch generator keyed on it.

4. **Status naming.**
   - The script sets `passed_for_merged_code` on #274 and #281 based on pre-merge candidate validation. A squash merge may differ from the tested head.
   - Rename it to something like `passed_for_candidate_head_merged`, or record the merge-commit tree comparison.
   - The script also forces `node['state']='in_progress'` and refreshes `board_status` from the snapshot, without validating the two against each other. The only coupling is the stale case.

5. **Metadata scope is not inert.**
   - `docs/` now contains the validator and its tests, and `.changeset/` affects release versions.
   - Both pass the "metadata scope" check, so a head change to the validator is self-approving.
   - `metadata_scope` discloses this. Add a rule that changes to `validate-execution.py`, its tests, or `.changeset/` need their own audit entry or an explicit flag in the proof.

6. **The final head can never be proven offline.**
   - The ledger records the head observed before the commit that adds it, so the published head always differs from `head_sha`.
   - Add a post-push step to the operations doc: re-read the PR head, confirm it is the recorded head plus docs-only commits, and re-check CI on the new head.

7. **The board RPC socket is `/tmp/osstack-debt-ledger.sock`.**
   - Board status, which the stale-block invariant uses, comes through that path.
   - The ledger already says the socket is not authenticated. Check the socket's owner and mode before use.

8. **Tests are missing for:**
   - the successor-draft stale base (P1-2);
   - `done` evidence reuse (P1-1);
   - `board_snapshots` and `rpc_helper` tamper;
   - a non-merged closed PR in the script path, which does fail loudly because `ready()` rejects non-OPEN PRs.

## What holds up

- Code/head handling is sound within its stated trust boundary:
  - `--no-renames` is used.
  - The path scope is strict.
  - Empty and net-empty diffs are explicit.
  - Diff bytes are hash-bound under root v2.
  - The old #276 audit is not re-attributed.
- The script validates before an atomic replace, and it archives the prior ledger by hash.
- Evidence directories are per-run and immutable.
- `project-operations.md` states the limits correctly: heartbeat is not goal_dispatch, there is no auto-merge, and CI and Ready are separate.

## Optional improvements
- Verify the five check names (build, typecheck, lint, inventory, test) in the verification JSON, instead of only the count of 5.
- Cap or flatten the nested `previous_delivery` chain, since each refresh adds a level.
- Make the hard-coded `expected_main` a command-line argument.

END_AUDIT