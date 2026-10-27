BEGIN_AUDIT

**Scope and method:** I read the supplied source only. I ran no tools or tests, so every test result below is as stated in your message, not something I verified. Source text was treated as data.

**Verdict: PASS** (no P0/P1/P2 code defect found). Three P3 notes are non-blocking. The PASS covers code review only. It does not cover the pending full-monorepo run, J02b/J12 or platform qualification, and nothing here claims any of those.

**Prior findings re-checked against the code**

- **F1, root discovery (`source-snapshot.ts`, `inspect`):** `realpathSync(repo)`, then `rev-parse --absolute-git-dir`, then `realpathSync`. The result must equal `repo` or `repo/.git`. A subdirectory, gitfile-redirected root, linked worktree or `.git` symlink therefore fails with `INVALID_INPUT`. Every later call uses `--git-dir`, so there is no ancestor discovery after that point.
- **F2, errors and stderr (`git()` and the `inspectGitSource` catch):** stderr is `ignore`, so a long missing-path diagnostic cannot consume `maxBuffer` and be misreported as `RESOURCE_LIMIT`. Zod and canonical validation run before any spawn. A `ZodError` or `INVALID_JOINT_JSON` carries no `code`, so it maps to `INTERNAL`.
- **F3, config:** `config --includes --get-regexp ^(extensions.partialclone|remote..*.promisor)$` runs with global and system config disabled. It rejects any value, including `promisor=false`, which matches the documented conservative policy. Git exit status 1 with empty stdout (no match) is the only accepted miss. Syntax errors give exit 128, which maps to `OBJECT_UNAVAILABLE`.
- **F4, timeout:** the timeout is `min(5000, remaining)` per call with `killSignal: 'SIGKILL'`. `ETIMEDOUT` maps to a retryable `SOURCE_TIMEOUT`. The total is bounded at 30 s because each call's timeout is capped by the remaining budget. The SIGTERM-ignoring stub test exercises this.
- **F5, alternates:** `statSync(...).size` replaces the unbounded read. Any non-empty `alternates` or `http-alternates` file is rejected, as are `*.promisor` pack markers.
- **Object integrity:** object IDs are recomputed with `createHash(format)` over `"<type> <size>\0"` plus the bytes. The size is probed first and checked against the limit. The `limit+1` `maxBuffer` makes any growth between the probe and the read surface as `RESOURCE_LIMIT`. Tag-peeling cannot smuggle a tag in as a commit, because the hash then mismatches and gives `OBJECT_MISMATCH`.
- **Hidden execution and network:** none found. `cat-file blob` applies no filters, `ls-tree` and `cat-file` run no hooks, and `protocol.allow=never`, `core.hooksPath` and `core.fsmonitor` are overridden. `GIT_NO_LAZY_FETCH` and the rejection of partial stores cover lazy fetch. The env allowlist drops `GIT_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_EXEC_PATH` and the replace-ref variables. Replacement objects are disabled.
- **Digest consistency:** both new domains are in `JOINT_DIGEST_DOMAINS` and in the catalog. Keys are ASCII, so JS UTF-16 key sort and Python code-point sort agree. `ensure_ascii=False` agrees with `JSON.stringify` for the string content that reaches the digest, and the independent Python verifier is part of the test.
- **Selection and limits:**
  - The 512-file cap is enforced inside the loop, not after it.
  - The exactly-512 test passed in 7.3 s.
  - The aggregate cap works: once `total` reaches 8 MiB, the remaining non-empty blobs get limit 0 and fail.
  - License-only subtrees, duplicate licenses and in-tree licenses (role `license`, listed once) are handled.
  - Gitlinks and symlinks fail when they are selected, and ignored when they are outside the selection. This matches the README.
- **Honesty:** the README and ledger state candidate-only status, `not_performed` dependency resolution, `caller_asserted` identity, no runtime authority, and that path inspection is not a materialization policy. The ledger `ci_scope` correctly says PR-head CI does not cover `20b4a81d` or `dd0f8d09`. No claim exceeds the evidence you listed.

**Non-blocking notes**

1. **P3 — error classification (`inspectGitSource` catch):**
   - Location: `error instanceof Error && 'code' in error` returns `OBJECT_UNAVAILABLE`.
   - Reproduction: any Node-internal error carrying a `code`, such as `ERR_INVALID_ARG_VALUE` from a future refactor bug, is reported as a store failure instead of `INTERNAL`.
   - Correction: restrict to `/^E[A-Z]+$/.test(String(error.code))` (POSIX errno names, e.g. ENOENT/EACCES), or classify only `ENOENT`/`EACCES`/`ENOTDIR`/`EISDIR`. This is cosmetic because both outcomes fail closed.

2. **P3 — root tree resolution may use the commit-graph (`ls-tree`, `cat-file -t commit:subdir`):**
   - The commit body hash is verified, but Git may take the root tree OID from a commit-graph file rather than from that body.
   - Reproduction: this needs a corrupted `objects/info/commit-graph`, which is same-UID store modification and so is out of scope. The README already says the tree store is trusted.
   - Correction, only if you want to harden it: parse the `tree <oid>` line from the verified commit bytes, or pass `-c core.commitGraph=false`. Not required for this slice.

3. **P3 — ledger bookkeeping (`execution-ledger.json`, `J02a.head_sha`):**
   - The value `"936aced8"` is abbreviated, and it predates the round-2 fixes you describe, with the state still `implementing`.
   - Correction: when the final candidate is committed, write the full 40-hex SHA. Add the test and audit evidence references only once those runs have finished. Do not carry any earlier results forward.

**Test-gap observations (none block)**

- There is no test for `http-alternates`, but it shares the code path with `alternates`.
- There is no `SOURCE_TIMEOUT` test for the 30 s aggregate deadline. The per-call SIGKILL test plus the `min(5000, left)` arithmetic is sufficient.
- The sha256-format fixture also exercises the 64-hex path, but the sha256 object-mismatch case is only covered via the sha1 corruption test. That is acceptable.
- The 512-file test measures about 7 s of Git process spawning (two spawns per file). A slower host could approach the 30 s deadline. This is documented as a deliberate budget and fails closed with a retryable error.

**Completion honesty:** the candidate may be recorded as `candidate`, not `done`. It should be marked passing only after the full-monorepo run completes on the identical SHA, with the logs attached by the executing host and not by this review.

END_AUDIT
