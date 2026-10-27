## Verdict: REVISE

No P0 found. The docs consistently keep approval and merge with the user, say `goal_dispatch` is off, and cap subagents at 3. I could not verify forge state, the heartbeat, or the contents of the `/Volumes/.../tmp` artifacts; this audit covers only the text you pasted.

## P1

1. **Rename hides product changes in the refresh script.** `git diff --name-only code head` uses default rename detection, so it lists only the destination of a rename. Moving `packages/x.ts` to `docs/x.ts` would list only `docs/x.ts`, pass the `docs/`/`.changeset/` allowlist, and the deleted product file would never be seen. Use `--no-renames` or `--name-status`, and fail on any non-add/modify status.

2. **Validator skips all evidence checks for merged and historical successor deliveries.**
   - In the `deliveries` loop, `current_evidence()` runs only when `evidence_status`, `audit.status` or `validation.status` is a "current" value.
   - The refresh script gives merged #278 `historical_merged_code` and `passed_for_merged_code`, so its report/binding hashes, `code_head_proof` and base binding are never validated. Only file existence is checked.
   - Relabelling any record `historical` therefore bypasses the proof.
   - Require v2 hash and proof validation for every v2 delivery whose `validation` or `code_head_proof` is present, regardless of status.
   - Also require `merge_sha == pr.mergeCommit.oid` for merged records. The script never writes `merge_sha` for #278.

3. **A re-run overwrites historical evidence.**
   - The script writes to fixed paths: `loader-cleanup-retarget/{loader,cleanup}/README.md`, `audit-code-binding.json`, `code-to-observed-head.diff`, the three board snapshots, and the receipts.
   - The archived `ledger-before-<hash>.json` still references those paths and hashes. After a second run those bytes differ, and the old ledger's evidence is irrecoverable.
   - Use per-run or content-addressed directories, or refuse to overwrite an existing file with different bytes.

4. **The validator does not enforce what the disposition says is required.**
   - `ledger['management'].get('receipts', [])` and `if 'snapshot_sha256' in ...` make receipts and the snapshot hash optional. Deleting those keys passes.
   - `ledger.get('checkpoint_history', [])` is optional too.
   - Nothing requires the four named receipts.
   - Make these keys mandatory and require the expected receipt names.

## P2

- **Diff not bound:** `code-to-observed-head.diff` is written, but the validator never checks it against `diff_sha256`. Require its path and hash, and derive `changed_paths` from the diff bytes instead of trusting the declared list.
- **Legacy bypass:** Milestone slices without `proof_version == 2` can be `ready` with no hash, base or code/head proof. Reject `ready` unless the slice is v2.
- **Docs-path allowlist:** `docs/` includes `validate-execution.py`, the ledger and the design contract tests. A docs-only diff can change what the checkpoint accepts, so "product diff unchanged" is overstated. Narrow the allowlist or disclose the gap.
- **Evidence artifacts not archived:** The verification JSON, check logs and `*-final-frozen-tests.log` stay in the tmp `out/` directory. The script checks them, but they are not copied into `evidence/` or hashed in the ledger, so the claim that "raw log hashes/counts are checked" cannot be re-verified later.
- **Docs not tied to the PR head:**
  - README and binding are copied from the loader and cleanup worktrees' working trees.
  - The script never checks them against `git show <head>:path`, so uncommitted or divergent bytes could be recorded as PR evidence.
  - Compare against the committed blobs at `headRefOid`.
- **Management target unproven:**
  - `management_home` and `management_socket` are hard-coded strings.
  - The script imports `ledger.rpc` via `sys.path.insert(0, ...)` and never shows which home or socket it uses.
  - Record the actual target in the snapshot receipt.
  - Only the joint board is hashed. The other two boards are saved but not hashed or validated, and `board_status` is never cross-checked against the snapshot offline.
- **Heartbeat and obligations are static:** `heartbeat.status: ACTIVE` and the #279 obligation text are hard-coded on every refresh. Derive them from a timestamped receipt. The receipt contents are not validated, only its hash.
- **#276 record is thin:**
  - The new record has no hashed original-audit evidence reference.
  - The prior #276 delivery is not kept under `previous_delivery`.
  - Link the original handoff evidence by hash.
- **Short SHA:** `expected_main='28d116f3'` is an abbreviation in both the script and the docs. Use the full 40-character SHA.
- **Forced node state:** The #274/#281 branch overwrites `part['audit']` (a possible `KeyError`) and forces `node['state']='in_progress'`, which can mask a blocked sibling slice.
- **Docs table is stale against the increment:**
  - Sections 1 and 4 still describe #276 and #278 as pending candidates.
  - "J01/J11 gaps recorded separately" and "#279 已进入正式收口" cite no ledger location or evidence. The ledger shows only a provisional preflight assigned to `terminal_preflight`.
  - Add an observation time and SHA to the increment section, and reference the ledger rather than restating status.
- **Preflight staleness:** `parallel_preflight.current_head_matches` is frozen at write time, and its report path points outside `evidence/` with no hash.
- **Empty-diff head:** Empty or no-net-diff heads (such as a merge commit) fail the `path emptiness` check. That fails closed but halts the script. Document it, or allow an explicit empty proof.
- **Missing tests:** There are none for:
  - merged or historical delivery bypass
  - absent receipts or snapshot hash
  - rename-to-docs
  - diff-file hash mismatch
  - legacy-slice `ready` without a proof

## Optional

- Print a short human-readable summary of what changed since the previous ledger.
- Add a `--dry-run` mode that validates without copying evidence.

END_AUDIT