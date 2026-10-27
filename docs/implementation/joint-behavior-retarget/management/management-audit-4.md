# Round 4 audit: REVISE

This was a static read of the pasted text. I did not run the tests or the scripts, and I cannot verify forge, CI, or heartbeat state. Two caveats on scope: I could not see `execution-ledger.json`, and the "91 tests pass" counts are the owner's claims.

## P0
None found.

## P1

1. **Root v2 can be dropped silently.**
   - Every v2 rule is gated on `checkpoint_proof_version == 2`: receipts, history, diff-byte hash, structured done evidence, and the legacy-Ready rejection.
   - Deleting that one key from `execution-ledger.json` makes it validate as "frozen legacy" and passes `test_current_checkpoint`. Nothing separates legacy history from new publication evidence.
   - Fix: make `test_current_checkpoint` and the `__main__` path require `checkpoint_proof_version == 2` for the live ledger. Keep the legacy fixture tests on the archived `ledger-before.json`.

2. **`diff_path` bytes are not tied to `changed_paths`.**
   - The metadata-only policy gates on the owner-declared `changed_paths`. The hashed diff file is never parsed.
   - A diff that touches `packages/...` can sit beside `changed_paths: ["docs/x.md"]` and validate, because the hash only proves the bytes are the ones recorded.
   - Fix: parse `^diff --git a/(.+) b/(.+)$` headers (safe, since the script uses `--no-renames`) and require the path set to equal `changed_paths`. Add a negative test.

3. **#279 evidence is weaker than the disposition claims, and the base is never checked for ancestry.**
   - The disposition says "all verification exits and raw log hashes/counts are now checked". That holds for the 282/278 branch only.
   - The terminal branch checks only the exit codes, the summary JSON and the archive-manifest file hashes. It does not recheck raw log hashes or recount tests from logs.
   - It has no `git merge-base code base == base` check. The validator only compares the strings `reviewed_base == base_sha == main`, so a `code_sha` on a stale lineage passes.
   - `successor_obligations['279']` hard-codes "6276 passed/5 skipped/0 failed" and "actual Sonnet5.5 PASS" instead of deriving them from `ts` and the binding. This can contradict the structured fields.
   - Fix: add the merge-base assertion and derive the counts from `ts`.

4. **Non-Ready milestone slices can carry "current" evidence without proof.**
   - Under `ready()`, current evidence is fully checked. A node slice in `candidate_pr_open`, `revalidating` or `blocked` with `evidence_status: current_for_code_sha` is only checked for head/base equality and for file existence.
   - Successors already close this with the `elif ... current_evidence(part)` branch and a test. Milestone slices lack the same branch.
   - Fix: apply the same branch to milestone slices.

## P2

- **State consistency is not enforced.** A slice in `open` or `candidate_pr_open` that references a `MERGED` PR validates. The script updates only the 274/281 slices, so confirm that the slices for #276 and #278 were not left stale in the ledger. Add the rule "PR MERGED ⇒ slice merged".
- **Several "required and checked" items are shallow.**
  - Receipts only need a matching name and hash. `{}` passes, as the test fixture shows.
  - `node.board_status` is read from the snapshot at generation time but never cross-checked against the hashed snapshot by the validator.
  - `heartbeat.goal_dispatch_enabled is False` is written but not enforced.
- **The archive script writes unconditional prose.**
  - The README states "byte-identical to the former stacked patch" for both kinds without checking it.
  - It references `dispositions.md`, which the script never creates.
  - It says "build, strict typecheck, lint and inventory passed" but only asserts that there are five checks with exit code 0. The check names and commands are not verified.
  - It tests `'HEAD '+sha+'\n' in audit_input` unanchored.
  - It uses a three-dot diff without asserting that base is an ancestor of code. The refresh script does assert this.
- **Fragile asserts and comments.** Asserts are the only guards, so `python -O` disables them. The `expected_main` comment says "resolved below", but `rev-parse` of a full SHA does not verify that the object exists.
- **The rpc helper hash is taken after the import.** The hash is read after `from ledger import rpc` runs, so the hash can differ from the code that actually ran. Hash it before importing.
- **Failed runs leave partial evidence.** `e.mkdir` runs before any assertion, so a failed run leaves a partial timestamped directory that could be committed.
- **Docs wording.**
  - "修改目标分支" is ambiguous. State that it means retargeting a PR base, not pushing to `main`.
  - State that the heartbeat only observes and reports, and never merges or approves. Any outward action must re-read live state.
  - The "仅文档/changeset 差异" wording should note that `docs/` includes executable `.py` files such as this validator. These are covered only by the separate management audit.
  - The heartbeat is described as created, in the present tense. Cite the receipt hash and time instead.

## Optional
- Parse `Verdict:` more tolerantly. `**Verdict:** PASS` fails closed, which is safe but brittle.
- Wrap `KeyError` and `TypeError` from malformed ledgers into `ValueError` for cleaner failures.
- Move the dated "当前批次观察" section out of the standing rules file.

Fixing P1.1 to P1.4 should be enough for PASS next round.

END_AUDIT