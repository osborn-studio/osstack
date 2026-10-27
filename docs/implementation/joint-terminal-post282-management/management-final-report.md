# Closure audit: B1 and script cleanups

Scope: B1 and the listed nonblocking cleanups only. I ran nothing and I'm making no runtime-validation claim. The staged prose is judged from the text you quoted, not from the scratch file.

## B1: closed

The replacement reads "#279 分支已同步到该 main，正在重验；本轮结果以随本次提交归档的实际命令为准，PR 本身仍待用户审批合并。"

- It no longer says #279 was merged, which matches the script's `prmap[279]['state']=='OPEN'` assertion.
- "正在重验" avoids claiming completion, and "仍待用户审批合并" states that approval is still owed.
- The result is bound to the archived commands, so the sentence does not pre-assert a pass.

One condition: the copy into `execution.md` must be byte-for-byte what you quoted. I can't verify that from here. Your final doc-link/checkpoint tests are the right place to catch a mismatch.

## Nonblocking items

1. **Validator result:** closed. `validate_published` calls `validate`, which fails through `require` and raises `ValueError`. The script also asserts `result['status']=='checkpoint_consistent'`, and the validator tail returns exactly that key, so the check is consistent.
2. **`sys.path.insert`:** closed. The line is gone and the validator runs via `exec(compile(validator_bytes…))` with `__file__` set. `sys` and `importlib.util` are still imported but unused, which is harmless.
3. **Failed runs in `commands`:** accepted as a precondition. The script fail-closes unless every command exits 0 and exactly one `pnpm test` matches `code_sha`. Keeping historical failures in a separate field is the right arrangement.
4. **Receipt bound:** closed. It now compares against `prmap[282]['mergedAt']`. A timezone-naive receipt `observed_at` would raise a `TypeError`, which fails closed.
5. **Raw-audit membership:** accepted as described. It remains a substring heuristic and you are not claiming cryptographic attestation. Owner content inspection and the code binding are the real controls, and your wording is honest about that.
6. **README counts and untracked outputs:** accepted. The manual check before staging and the untracked `.next` and partial outputs are fine as long as the owner's final scope review excludes them from `git add`.

I found nothing new that blocks, and I did not reopen scheduler design.

VERDICT: PASS
END_AUDIT