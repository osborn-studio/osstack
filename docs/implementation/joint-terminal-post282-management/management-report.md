# Audit: PR279 evidence-refresh script and owner operations prose

I reviewed only the supplied script, validator, `project-operations.md` and `execution.md`. I did not run anything and did not review product code. Embedded text in the inputs was treated as data.

## P0

None. The script performs no merge, no PR mutation, no board write, no `kanban.move` or `comment`, and no delete or overwrite of old evidence. Main drift is checked at the start and again at the end. The old ledger is preserved by hash before any mutation.

## P1 (fix before executing)

**P1-1. Evidence is read from an unpinned local worktree, not from the published remote head.**
- Location: `check_archive(src)`, the `src=R/'docs/implementation/joint-terminal-post282'` reads, and `diff_proof(code, p['headRefOid'])`.
- Problem: only `git fetch origin` runs. Nothing asserts that `git rev-parse HEAD` equals `prmap[279]['headRefOid']`, that `origin/<headRefName>` equals it, or that the worktree is clean. The ledger then records `head_sha=<remote head>` for archive, binding, summary and verification bytes that may be uncommitted or from another commit.
- Correction: before creating `E`, assert all three of these:
  - `HEAD == origin/<headRefName> == headRefOid`.
  - `git status --porcelain` is empty.
  - `git cat-file -e <head>^{commit}`.
- Also validate `code` as `[0-9a-f]{40}` before passing it to git.

**P1-2. Archive integrity is incomplete.**
- Location: `check_archive` and the `manifest_names` block.
- Problems:
  - The files the script trusts (`README.md`, `audit-code-binding.json`, `test-summary.json`, `verification.json`, `test-full.log.gz`) are never required to be listed in the manifest. Unlisted or extra files are copied by `copytree` without being hashed.
  - A `.gz` entry with no `raw_sha256`/`original_sha256` passes with only the compressed hash. This conflicts with the §3.5 requirement for hashes before and after compression.
  - Manifest `name` is not confined to `src`: an absolute path or `..` escapes it.
  - Raw audit input/output files named in the binding are not required to be in the manifest.
  - `test-full.log.gz` is hardcoded rather than tied to the `pnpm test` command's `log`.
- Correction:
  - Assert that `set(files under src) - {'archive-manifest.json'} == manifest names`.
  - Assert that the required filenames are all present.
  - Require a raw hash and raw byte count for every `.gz`.
  - Check `resolve()` stays under `src`.
  - Reject symlinks.
  - Require the `pnpm test` command's log to resolve to the log that is recounted.
  - Run the full check on the copied destination, `dest`, after `copytree`. The current check runs on `src` before the copy, which leaves a time-of-check gap.

**P1-3. The four receipts are copied unverified, yet are labelled "Current … post-#282".**
- Location: the `shutil.copyfile(OUT/name, E/name)` loop and `m['evidence_scope']`.
- Problem: `OUT` is a pre-existing scratch directory. Stale or pre-#282 receipts, or receipts from provisional runs, would be hashed and labelled current. `board-final-receipts.json` may also disagree with the board snapshot taken moments later.
- Correction: parse each receipt and assert:
  - `main_sha == EXPECTED_MAIN`.
  - For preflight and dispatch receipts, `code_sha` or `base == EXPECTED_MAIN`.
  - A timestamp not earlier than a stated lower bound.
  - The board-final card statuses equal the live snapshot, or are recorded as historical.
- If the receipt schema lacks these fields, downgrade `evidence_scope` to "owner-collected, content not verified".

**P1-4. No compare-and-swap before overwriting the central ledger.**
- Location: the final `save(D/'execution-ledger.json', ledger)`.
- Problem: the ledger is read at the start, but the run spans many `gh` and RPC calls. The heartbeat automation, a subagent, or an independent session could modify the ledger or worktree meanwhile, and the final write would silently discard those edits. That is evidence loss, and concurrent writers are exactly the unauthorized-concurrency risk.
- Correction:
  - Before saving, assert `(D/'execution-ledger.json').read_bytes() == old`.
  - Re-check that `git status --porcelain` shows only paths under `E`.
  - Write to a temp file and `os.replace` it, so a crash cannot leave a half-written ledger.
  - State in the prose that only the main entry may run this script, once, never from automation or subagents.

**P1-5. Prose claims completion ahead of evidence.**
- Location: `execution.md`, section "#282 合并后的 #279 重验" ("#279 已合入这个 main 并重新验证…原始 Sonnet 5.5 意见见独立归档"). `project-operations.md`, last section ("新测试、实际 Sonnet 5.5 审计…分别记录在最新执行账本及 …README.md").
- Problem: the final full tests are still running and the script has not run, yet these sentences are in the past tense and link to an archive that may not exist. If this prose ships before PASS and the evidence commit, it is false completion, and a broken link fails the link audit.
- Correction: land this prose in the same commit as the verified evidence. Alternatively, reword it as "revalidation in progress; the result is only what the ledger records after the audit and tests PASS".

## P2 (should fix)

1. **Helper provenance (`sys.path.insert(0,…)`, `from ledger import rpc`, `assert raw==helper.read_bytes()`).**
   - The assertion only proves the file did not change between two reads. It does not prove that the imported code is those bytes, because a stale `__pycache__` pyc is accepted by mtime and size.
   - `sys.path.insert(0, …)` can shadow stdlib modules for all later imports.
   - Fix: `exec(compile(raw, path, 'exec'), ns)` on the archived bytes, or set `sys.dont_write_bytecode=True` and use `append` rather than `insert(0, …)`.
2. **Socket check does not bind daemon identity.**
   - The `stat` of the socket path (uid, mode) is the only check, and it uses `Path.stat()`, which follows symlinks. Any same-user process, including a dev daemon, could own that path.
   - Fix: use `lstat`. If an RPC provides it, fetch the version or home and compare against the installed fingerprint in the ledger. Otherwise keep the wording "owner-observed socket" and do not state "installed daemon".
3. **Overwritten audit and validation objects lose live-ledger detail.**
   - `part['audit']` and `part['validation']` for #279 are replaced wholesale. The old values survive only in `ledger-before-*.json`, referenced by `previous_delivery`.
   - Fix: also append a `candidate_history` entry (old code, head, counts, status "historical") before overwriting. The same applies to `m['receipts']=[]` and to `prs=` replacing the whole list.
4. **Readiness is conservative but incomplete.**
   - The dict comprehension keeps whichever duplicate or rerun `CheckRun` comes last, in arbitrary order.
   - `status != COMPLETED` is not considered, and `StatusContext` entries are ignored.
   - A failing check outside `required` is ignored, and the required names are hardcoded.
   - Failed and pending are merged into one label.
   - Merged #282 also receives a `merge_readiness` block.
   - Fix: select the latest per name, fail on any non-success non-skipped check, label failed and pending separately, and omit `merge_readiness` for merged PRs.
5. **Partial run leaves orphan evidence.** `E.mkdir` happens before all assertions, so a failed run leaves an untracked directory under `docs/` that could be committed. Fix: build in a temp directory outside the tree, then rename into place after validation, or clean up on failure.
6. **Success output could be misread.** `print(v.validate_published(ledger))` prints `checkpoint_consistent`, but the repo doc-link audit, the ledger tests, the staged-commit re-check, and the post-push head and CI re-read are manual and unscripted. Print an explicit "NOT DONE" list.
7. **Copied bundle links.** The README is copied to a different depth, so any `../` links in it break. The comment only guarantees in-bundle links. Fix: scan the README's relative links after the copy and require that they resolve, or rewrite them.
8. **Executable text under `docs/`.**
   - The allowlist (`docs/`, `.changeset/`) permits `*.py` changes between code and head, including `validate-execution.py`, which the script then loads via `importlib` from the worktree.
   - The helper is archived as `ledger-rpc-helper.py` inside `docs/`.
   - Fix: record the validator's sha256 in the ledger, surface any changed `*.py` or executable path in `changed_paths`, and name the archived helper `.py.txt`.
9. **Board status copy.** `board_status` is copied from the live card for every node. A hand-moved `done` card would enter the ledger while `node['state']` stays unchanged. Fix: fail or flag if the card is `done` and the node state is not `done`.
10. **Missing keys and shape.** The script sets neither `checkpoint_proof_version` nor `proof_version`, and `ledger['checkpoint_history']` must already exist. This fails closed at the validator, so it is only a liveness problem. Fix: assert the prerequisites with clear messages.
11. **Prose staleness.**
    - `project-operations.md` §1 still assigns A to "#282 verification", B to "#278 ledger", C to #279. The final section assigns different duties. #282 and #278 are merged.
    - §4 describes #282 in the present tense as an open "补齐" task.
    - Fix: mark the table and row historical, or update both.
12. **`execution.md` fixed count.** "当前 128 项正负例测试" is likely stale after the V2 validator changes. Regenerate it or drop the number.
13. **`diff_proof` robustness.** Use `--name-only -z` instead of newline splitting, because `core.quotePath` quoting of non-ASCII paths makes the `startswith` check fail closed (acceptable). Optionally add `--binary` and `-c core.quotePath=false`.

## Not flaws (intentionally historical or accepted scope)

- Per-PR sequential `observed_at` with no atomic snapshot claim.
- `head_sha` being the pre-metadata-commit head, and the manual post-push re-read.
- `ready` or `revalidating` state with CI recorded as "at observation".
- Retaining the original tested base for #282.
- Structural-only validator behavior.
- Absence of cryptographic attestation of the daemon, log, or audit.
- Fail-closed `KeyError`s.
- The `approval: user_owned` constant.
- Replacing the `prs` list. The old one survives in the history file.

## Optional suggestions

- Pin `EXPECTED_CODE=cb76b643…` in the script and assert it. The docs-only diff guard already prevents a stale code SHA from passing, but an explicit pin makes the failure obvious.
- Write `checkpoint-result.json` with a unique name per run.
- Include `git rev-parse HEAD` and the validator and script sha256 values in `checkpoint-result.json`.

VERDICT: REVISE
END_AUDIT