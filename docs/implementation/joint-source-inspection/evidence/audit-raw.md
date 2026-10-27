BEGIN_AUDIT
**Target:** J02a `inspectGitSource` (`source-snapshot.ts`, tests, README, package export) and the execution.md / ledger handoff text.
**Base claimed:** #273 `fad0dd45377255a2d3dfceb08fb28c1524b88ead`. I could not check the actual base, the J02a diff, or the Git version used in CI from the pasted text.
**Method:** static read only, nothing executed. Timestamps come from the ledger only (`observed_at 2026-10-27T06:44:27Z`, `accepted_at 2026-10-27T06:50:10Z`). I did not infer a host date. No test result below is verified by me.

## Verdict: REVISE

No P1 found. The core design is sound: allowlisted env, `--git-dir` pinning, replace objects off, commit and blob hashes recomputed per object format, and no checkout reads. Remaining issues are one trust-boundary gap (P2), one error-contract violation (P2), and several limit, documentation and test-honesty gaps (P3).

## Findings

**F1 · P2 · Repository discovery is not bound to `repositoryPath`**
- Location: `inspectGitSource`, the `git rev-parse --absolute-git-dir` call run with `-C repo`.
- Problem: `gitDir` is accepted without checking it belongs to `repo`. A plain subdirectory of any repo (or a path with a gitfile) silently resolves to an ancestor or other store. The alternates, promisor and format checks then apply to that store, not the mirror the host named.
- Repro (local, using the fixture): `inspectGitSource({...options, repositoryPath: join(root,'method')})`. It should fail but returns the same inspection as the root.
- Impact: byte integrity still holds because hashes are rechecked. The host's "this mirror" claim and the partial/alternate gating are what weaken.
- Fix: after `rev-parse`, `realpathSync(gitDir)` must equal `repo` (bare mirror) or `join(repo,'.git')`. Otherwise fail `INVALID_INPUT`. Setting `GIT_CEILING_DIRECTORIES=dirname(repo)` in env also helps.

**F2 · P2 · Error contract: non-`SourceInspectionError` throws, and late input validation**
- Location: the two `SourcePin.parse` calls, `jointDigest`, and `Input.safeParse`.
- Problem: the doc says all failures throw typed codes. `repository` is only checked as `min(1).max(512)`, and the strict `SourcePin` shape (not visible here) is applied only after about 10 git spawns. If `SourcePin.repository` uses `Ref` as sibling fields in `joint-evidence.ts` do (no control characters, trimmed), a bad `repository` surfaces as a raw `ZodError`. `jointDigest` can also throw a plain `Error('INVALID_JOINT_JSON')`. Callers switching on `.code` or `retryable` mis-handle these.
- Repro: `inspectGitSource({...options, repository: ' x\n'})`. This is expected to throw `ZodError`, not `INVALID_INPUT`, and only after git has run. Please confirm against the real `SourcePin`.
- Fix: parse the placeholder `SourcePin` right after `Input.safeParse` and map failure to `INVALID_INPUT`. Wrap the final `SourcePin.parse` and both `jointDigest` calls to rethrow as `SourceInspectionError('UNSAFE_ENTRY')` or `INVALID_INPUT`.

**F3 · P3 · "Reject partial store" check misses included config**
- Location: `git config --local --get-regexp ...`.
- Problem: per git-config docs, `--local` reads one file with includes off, but normal git commands honor `[include] path` in `.git/config`. A promisor or partial-clone setting placed in an included file or `config.worktree` is not seen.
- Repro: add `[include] path = promisor.cfg` to `.git/config`, with `[remote "origin"] promisor = true` in `promisor.cfg`. `inspectGitSource` should throw `PARTIAL_STORE` but does not, by my reading. Please verify locally.
- Mitigation already present: `GIT_NO_LAZY_FETCH=1`. This is defense-in-depth failing, not a network fetch.
- Fix: add `--includes`, and drop `--local` or also query worktree scope. Add a test.

**F4 · P3 · Synchronous API can block the host event loop for up to 30 s, and the budget is tight**
- Location: `execFileSync`, `deadline`.
- Problem: each blob costs 2 spawns, so 512 files is about 1,030 spawns. On slow disks or AV-hooked macOS spawns this can approach the 30 s budget, and a daemon calling it stalls timers and RPC for that long. Neither README nor JSDoc says the function is synchronous. The README does state the 30 s / 5 s limits.
- Repro: a daemon calls it on a 500-file subdir while a `setInterval` heartbeat runs. The heartbeat gaps equal the call duration.
- Fix (minimal): document "synchronous, blocks up to 30 s; call from a worker/child". Optionally use one `cat-file --batch` for blobs, which halves spawns.

**F5 · P3 · Whole-repository tree listing makes small subdirs fail in large mirrors**
- Location: `ls-tree -r -z --full-tree <commit>` with the 2 MiB `TREE_LIMIT`.
- Problem: at roughly 100–110 bytes per entry, a mirror with about 20k tracked files (whatever the subdir size) hits `ENOBUFS` → `RESOURCE_LIMIT`. Any non-UTF-8 path anywhere also poisons the whole inspection. The README calls this "conservatively capped", so the behavior is disclosed, but the 2 MiB cap is not tied to a file-count threshold.
- Repro: commit 25k small files outside `method/`, then inspect `method`. Expected `RESOURCE_LIMIT`.
- Fix: either restrict listing with `ls-tree -r -z <commit> -- <subdir>/ <licensePaths…>` under `GIT_LITERAL_PATHSPECS=1`, or keep as is and state the approximate entry-count ceiling in the README.

**F6 · P3 · Undocumented or unjustified limits**
- The commit object is capped at 64 KiB (`object('commit', …, 65536)`) and fails with `RESOURCE_LIMIT`. The README does not list it.
- The Git ≥ 2.48 floor has no stated reason. `GIT_NO_LAZY_FETCH` needs only 2.44 and `GIT_CONFIG_GLOBAL` 2.32. Stock Ubuntu 24.04 (2.43) and Debian 12 (2.39) are below it, and Apple Git versions vary. The tests use `which git` with no pre-check, so a CI image below 2.48 would fail every test with `UNSUPPORTED_GIT`. Please confirm CI's Git version.
- `execFileSync`'s `maxBuffer` also applies to stderr. Small caps such as 128 or 4096 can turn a verbose warning on an otherwise good call into `RESOURCE_LIMIT`. Give stderr a separate, larger allowance or ignore it.
- A refused `safe.directory` (different owner, global config disabled) is reported as `OBJECT_UNAVAILABLE`, not a clearer code.

**F7 · P3 · Test gaps and weak assertions**
- The hook/filter test is vacuous for hooks. `cat-file` and `ls-tree` never trigger `post-checkout`, and no filter is invoked without `--filters`. Replace the hook case with config that can actually fire in these commands (e.g. `core.fsmonitor`, `core.pager`, `core.alternateRefsCommand` pointing to a sentinel script), or relabel the test as a checkout-file-ignored test.
- Missing negative tests:
  - `SOURCE_TIMEOUT`: use a `gitBinary` wrapper script that sleeps.
  - Tree output > 2 MiB.
  - `UNSUPPORTED_GIT`: use a stub printing `git version 2.47.9`.
  - `.promisor` pack marker and `http-alternates`.
  - Non-ASCII, NFC-colliding and trailing-dot/space paths.
  - A symlink at a license path outside the subdir.
  - An exact-boundary pass: exactly 512 files, exactly 512 KiB.
  - Non-UTF-8 path outside the subdir (documented as a failure).
- Many rejection tests assert bare `toThrow()` (case collision, missing objects, missing blob, duplicate license). Assert codes (`UNSAFE_ENTRY`, `OBJECT_UNAVAILABLE`, `INVALID_INPUT`) so a different failure cannot satisfy them.
- The Python parity check uses ASCII paths only. Add one non-ASCII path (e.g. `méthode/ü.md`) to exercise raw-UTF-8 sorting and `ensure_ascii=False` parity.

**F8 · P3 · Handoff and ledger honesty**
- The ledger's `observed_at` (06:44:27Z) precedes `handoff.accepted_at` (06:50:10Z). The per-PR check rollups (#274–#279 `check` IN_PROGRESS) are therefore older than the acceptance. The acknowledgement correctly says CI and reviews remain PR obligations. Add a per-PR observation time, or an explicit note, so "accepted COMPLETE" is not read as "green".
- The J02a ledger entry has no PR number, head SHA, test evidence or audit-disposition reference yet. `implementing` is honest, but the brief cites "19 passed + 2 more, full mono running". That is not recorded anywhere in the reviewed files, so I treat it as unverified.
- The README points to `evidence/` and `validation.md` for the final review and host test evidence. Those were not in the reviewed set. This is fine for a candidate, but must not be cited as done.
- Digest-domain registration is confirmed in code (`JOINT_DIGEST_DOMAINS` has `source-content.v1` and `source-inspection.v1`). The catalog side was not provided, so I cannot confirm it.
- `package.json` adds a public npm subpath export (`./source-snapshot`) on a published package. The README says candidate-only, with no runtime consumer. State that the subpath is unsupported until J02b, or hold the export.

## Checked and found sound
- **Environment:** the allowlist drops `GIT_DIR`, object/alternate/exec-path/replace and config-count variables. `GIT_CONFIG_GLOBAL=/dev/null` also disables the XDG config. The injection test covers the key variables.
- **Object integrity:** hashes use the repository's own format (`sha1`/`sha256`) over the `type size\0` header plus the exact bytes. Size is checked before content, and the content read is capped at `limit + 1`. A tag OID passed as the commit fails the hash check rather than being peeled silently.
- **Tree entries:** `-z` removes path quoting. Only `100644`/`100755` blobs are accepted in the selected tree. Gitlinks and symlinks in the selected tree are rejected. The OID length matches the commit length.
- **Digest consistency:** the content digest covers `{schema_version, repository, commit, subdir, files}` and the inspection digest covers everything but itself, as documented. File order is raw-byte sorted. The license-in-tree dedupe and role binding are consistent with the README. The independent Python recomputation matches the documented shape.
- **Hidden execution/network:** only builtin plumbing (`--version`, `rev-parse`, `config`, `cat-file`, `ls-tree`) is run with `protocol.allow=never`. No `-c` override hides a vector I can identify from this code.
- **Scope claims:** the output has no `SourceSnapshot` and no `dependencies` array. The placeholder snapshot is used only for the collision and prefix invariants. The README and execution.md are consistent with the code on candidate status and non-closure.

## Minimum to reach PASS
Fix F1 and F2 with a regression test each. Add the F3 `--includes` fix with a test. Make the F4/F5/F6 behaviors explicit in the README, and tighten the F7 assertions and the vacuous hook test. Record the J02a head SHA and test evidence in the ledger once available (F8).
END_AUDIT
