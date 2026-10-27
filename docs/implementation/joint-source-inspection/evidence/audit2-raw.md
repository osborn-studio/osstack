BEGIN_AUDIT

**Scope.** Static review of the supplied source, tests, README, catalog and ledger. I executed nothing. Every behavioral claim below is derived from the code and needs a local run to confirm.

**Verdict: REVISE.** I found no P0 or P1. The core design is sound: the allowlisted environment, `--git-dir` pinning with ancestor/gitfile rejection, replace/lazy-fetch/hook/protocol neutralization, hash recomputation of commit and blob bytes, and digest-bound `not_performed`/`caller_asserted` markers hold up on reading. Four P2 defects contradict README claims or make a bounded-operation claim untrue, and two more P2 items are test and handoff gaps. These should be fixed before the slice is called a clean candidate.

---

### Findings

**F1 — P2 — A license-only subdir is accepted as source evidence**
- Location: `source-snapshot.ts`, `if (inside) sourceCount++` and `if (!sourceCount || …)`.
- README says "Missing/empty/non-tree subdirs fail".
- `sourceCount` counts every file under the subdir, including one declared as a license. That file is then relabeled `role: 'license'`.
- Repro: commit a tree where `method/` contains only `LICENSE`. Call `inspectGitSource({...options, subdir:'method', licensePaths:['method/LICENSE']})`.
- Expected: failure, since no source-role file exists.
- Actual: success with `files=[{role:'license'}]` and a valid pin and digest. A downstream consumer cannot tell this from real method content.
- Correction: count only entries where `inside && !licenses.has(path)`. Add a test.

**F2 — P2 — Git stderr counts against `maxBuffer`, so errors are misclassified**
- Location: `git()` with `stdio:['ignore','pipe','pipe']` and small caps (128, 4096, 65536).
- Node's `execFileSync` applies `maxBuffer` to stderr as well as stdout.
- Repro: `subdir` is a 200-character absent path.
  - `cat-file -t <commit>:<subdir>` runs with cap 128.
  - Git's fatal message embeds the path, which can exceed 128 bytes.
  - That yields `ENOBUFS`, mapped to `RESOURCE_LIMIT`.
  - The correct code is `OBJECT_UNAVAILABLE` or `UNSAFE_ENTRY`.
- Callers would misdiagnose a missing path as a limit breach. The F2 "typed errors" claim is weaker than stated.
- Correction: set stderr to `'ignore'` (nothing reads it), or give stderr a separate fixed cap. Map `ENOBUFS` to `RESOURCE_LIMIT` only for stdout-bearing calls. Add a long-missing-subdir test.

**F3 — P2 — Per-blob subprocess cost can make legitimate in-limit input time out**
- Location: `object()` runs two spawns per file (`cat-file -s`, then `cat-file <type>`).
- A 512-file selection therefore needs about 1,030 spawns inside the single 30 s deadline.
- On macOS, `/usr/bin/git` is an `xcrun` shim, which is the very binary the README cites. If each spawn costs 30 ms or more, a legal 512-file subtree hits `SOURCE_TIMEOUT`. That code is `retryable: true`, so callers would retry a deterministic failure.
- Repro: build a 512-file subtree and time `inspectGitSource`. No test covers a successful maximum-size read; the 512 test only verifies rejection.
- Correction: use one `cat-file --batch-check` for sizes and one `--batch` for contents, with per-object limit checks and a running total. This also removes the TOCTOU between the size call and the read. At minimum, add a max-size success test with a measured time and document the observed budget.

**F4 — P2 — Child kill is SIGTERM only, so a stalled child can outlive the deadline**
- Location: `execFileSync` options.
- There is no `killSignal`. A process that ignores or traps SIGTERM keeps `spawnSync` blocked, so the "30 s bounded" and "timeout/resource release" claims can fail. The timeout test stub is a Node script that dies on SIGTERM, so it cannot show this.
- The binary is host-trusted, but the timeout path is explicitly meant to survive a stalled binary.
- Repro: stub shell script with `trap '' TERM; sleep 60`. Expect `SOURCE_TIMEOUT` at about 5 s; the call likely blocks for 60 s.
- Correction: add `killSignal: 'SIGKILL'`, and add the trap-stub test.

**F5 — P2 — The documented host mirror form (bare) has no positive test**
- Location: tests; the `gitDir !== repo` branch.
- The README says "Provision a complete mirror" and accepts the "exact bare root". Every fixture is a non-bare working repo with `root/.git`.
- The bare branch (`gitDir === repo`) is therefore never exercised on its success path. Neither is gitfile-redirect rejection. Only subdirectory ancestor discovery is tested.
- Correction: add three cases:
  - `git clone --bare` or `--mirror` of the fixture, which must succeed with an identical digest.
  - A `.git` file containing `gitdir: <elsewhere>`, which must give `INVALID_INPUT`.
  - A `.git` symlink pointing outside the repo root.

**F6 — P2 — Handoff: CI evidence is tied to PR heads, but the accepted candidate is a different SHA**
- Location: `execution-ledger.json` `handoff` versus `prs`.
- The accepted `code_candidate` is `20b4a81d…` (integration head `dd0f8d09…`). The recorded CI results are for PR heads such as #279 `cae25bc6…` and #275 `48d6b927…`.
- Nothing in the ledger records that the integration tree equals the stacked PR tips, or which PR head corresponds to which candidate content.
- `report_sha256` is recorded, but the report text was not supplied to me, so I cannot verify it.
- The ledger does not claim green CI for the candidate, so this is not dishonest. But "accepted COMPLETE" next to green PR checks invites that inference.
- Timestamps support the ordering. Acceptance was recorded at `2026-10-27T06:50:10.706240+00:00`. Several `check` runs (#276, #278, #279) completed afterwards, and the snapshot is `observed_at 2026-10-27T07:01:44.685229+00:00`. Acceptance preceded final CI, as the acknowledgement admits.
- Correction: add a ledger note recording one of two things:
  - Tree-equality of the integration head against #279's tip, with the comparison command and its recorded result.
  - An explicit statement that PR-head CI does not cover `20b4a81d`/`dd0f8d09`.

---

### P3 items

- **P3-a:** The config query `remote..*.promisor` matches `promisor = false`. A remote explicitly set non-promisor is rejected as `PARTIAL_STORE`. This is conservative, but the README should say so, or the code should use `--type=bool` and check values.
- **P3-b:** `inspectGitSource`'s catch-all maps any non-typed throw (for example a `ZodError` from the final `SourcePin.parse`, or a `TypeError`) to `OBJECT_UNAVAILABLE`. Programming errors disguised as missing objects will hurt debugging. Consider an `INTERNAL` code, or log and rethrow in tests.
- **P3-c:** `pathSafe` rejects `.git` and trailing dot/space, but not NTFS short-name forms (`git~1`), HFS-ignorable-codepoint spellings of `.git`, or Windows reserved device names. This is out of scope while nothing is checked out. J02b must not materialize these paths without its own check. State that in the README.
- **P3-d:** `readFileSync` on `info/alternates` is unbounded. A huge file is read fully before the length test. Use `statSync().size`.
- **P3-e:** The "never executes hooks/filters" test is weak. `ls-tree` and `cat-file` never run post-checkout hooks or smudge filters, so the test would pass for most implementations. It does not show that `--filters`/`--textconv` are avoided. Reword the test name, or add a `diff.external`/`core.pager`/textconv sentinel. This is an honesty issue about test strength, not a code defect.
- **P3-f:** `core.worktree` or a cwd-as-worktree implication when `--git-dir` is passed without `--work-tree`. No read command touches the worktree, so there is no effect today. Setting `cwd` to the git dir would make the invariant structural.
- **P3-g:** Commit cap of 64 KiB rejects some legitimate commits (many parents, long signatures). The README documents this, so no change is required. Note it as a known false-reject.

---

### Checked and found sound

- **Environment and config:**
  - The env is an allowlist. No inherited `GIT_*` reaches children; only `PATH` is passed through, and it matters only for external helpers, not the builtins used.
  - Global and system config are disabled.
  - `-c protocol.allow=never` plus `GIT_NO_LAZY_FETCH` covers network. `GIT_NO_REPLACE_OBJECTS` is set.
- **Root pinning:** `rev-parse --absolute-git-dir` followed by `realpathSync` and an exact match against `repo` or `repo/.git` rejects ancestor discovery and gitfile redirects. Equality is on realpaths, so symlink tricks on the final component fail.
- **Object integrity:** the hash header `type size\0` is computed with the repository's actual format (`sha1`/`sha256`), and the commit length is checked against the format.
- **Limits:** blob size is checked before read. The file cap and 8 MiB running total use the remaining budget, and oversized listings fail as `RESOURCE_LIMIT` via `ENOBUFS` on stdout.
- **Selection:**
  - `ls-tree -r -z --full-tree` avoids quoting problems.
  - Out-of-tree entries are ignored unless a declared license, so symlinks and gitlinks elsewhere do not poison results.
  - Selected symlinks and gitlinks fail.
  - The J01 `SourceSnapshot` parse is reused for collision and prefix invariants. It is used only as a validator; no snapshot is emitted.
- **Digests:**
  - Keys are ASCII-enforced, so the UTF-16 key sort in `canonicalJointJson` agrees with Python `sort_keys`.
  - File ordering uses UTF-8 byte order.
  - Both new domains are in `JOINT_DIGEST_DOMAINS` and in the catalog, consistent with the README.
  - The independent Python check covers non-ASCII paths and both digests.
  - The inspection digest binds `dependency_resolution`, `repository_identity` and `expected_digest_checked`, so the markers cannot be stripped without detection.
- **Honesty of scope:** the README and ledger consistently say candidate, J02b owns closure, no runtime authority, and no detached snapshot. The execution notes carry the owner-unavailable halt rule, and the base is pinned to #273 `fad0dd45…`.

---

### Minimal correction set (ordered)

1. F1: exclude license-role files from `sourceCount`, plus a test.
2. F2 and F4: set stderr to `'ignore'` and `killSignal: 'SIGKILL'`, plus the long-path and trap-stub tests.
3. F3: batch `cat-file`, or at least add a measured 512-file success test with a recorded budget.
4. F5: add bare, mirror, gitfile and symlink root tests.
5. F6: add the tree-equality or non-coverage note to the ledger.

After these, the re-review is limited to the changed lines. This verdict makes no claim about the full mono test run or acceptance; both remain unexecuted.

END_AUDIT
