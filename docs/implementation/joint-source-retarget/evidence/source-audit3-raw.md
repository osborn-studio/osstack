BEGIN_AUDIT

**Verdict: PASS** (static read only). No P0 or P1 found. This is not runtime or host qualification. I executed no tests, and the PR is correctly Draft with host validation pending. Nothing below should be read as that validation passing.

## What I checked and found sound

**Git command boundary** (`packages/skill-registry/src/source-snapshot.ts`)
- Every value interpolated into a Git argv is either static or has already been validated as full hex (`commit`, blob OIDs). `subdir` appears only after `${commit}:` and `licensePaths` never reach Git. I found no option-injection path.
- The env is an allowlist. Global/system config, replacement objects, lazy fetch, hooks, fsmonitor and protocols are disabled. Inherited `GIT_*` variables are dropped, including `GIT_CONFIG_COUNT` and `GIT_CONFIG_PARAMETERS`.
- Discovery is pinned. `--absolute-git-dir` is realpath'd and must equal `repo` or `repo/.git`. Ancestor discovery, gitfile redirects and a symlinked `.git` therefore fail with `INVALID_INPUT`, matching the tests.
- A tag OID passed as `commit` is caught. `cat-file commit <tag>` peels the tag, so `bytes.length !== size` or the recomputed hash gives `OBJECT_MISMATCH`. The behavior is safe but unpinned by a test (see P3-3).

**Immutable bytes and digests**
- `cat-file --batch-check` sizes every blob and bounds the aggregate (counted per selected file) before `--batch` reads any content.
- The batch parser checks the header string, the trailing LF and the exact total length. It recomputes the Git OID over `type size\0bytes` and uses the repository's own hash format.
- The empty-last-object case parses correctly (`start+0` is the trailing LF index, which is less than `batch.length`).
- Both digest domains match `digest-catalog.json` field for field. File sort is raw UTF-8 bytes, as the catalog says.
- Worst-case canonical size is about 375 KB for 512 files at 512-byte paths, under the 1 MiB `canonicalJointJson` cap.
- Python `ensure_ascii=False, sort_keys` agrees with the JS canonicalizer here because all keys are ASCII.

**Contract compatibility**
- `SourcePin.parse` is used for the pin. `SourceSnapshot.safeParse` is used only as a collision/prefix/portable-path gate on `{path,mode,blob}`, which is the shape on main `69859eec`.
- The wrapper has an unregistered `kind` and extra strict fields. The tests assert that it is rejected by `SourceSnapshot` and by `decodeJointContractAs` for source_snapshot, method_proposal, method_binding, trial_permit and recovery_proof.
- `JOINT_DIGEST_DOMAINS` and the catalog are asserted equal in `joint-reference.test.ts`.
- The root export is untouched. `./source-snapshot` is explicit, so it wins over the `./*` wildcard.

**Limits**
- Reject-not-truncate is implemented for all of these:
  - 512 files
  - 512 KiB per blob
  - 8 MiB aggregate
  - 2 MiB tree listing (`ENOBUFS` → `RESOURCE_LIMIT`)
  - 64 KiB commit
- The tests hit the boundaries: exactly 512 passes, 513 fails, an exact 512 KiB blob passes, and an 8.5 MiB total fails.
- Per-call 5 s `SIGKILL` and the 30 s scheduling deadline match the docs. The docs do not oversell them as wall-clock guarantees.

## Findings

### P2-1. `repository` is not hygiene-checked, so credentials or control bytes can be digest-bound
- **Path:** `source-snapshot.ts`, `Input` and the `SourcePin.safeParse` preliminary. `SourcePinShape.repository` is only `string().min(1).max(512)`.
- **Counterexample:** `repository: "https://ghp_TOKEN@github.com/o/r\n"` succeeds. The token and newline are carried into `pin.repository`, the file-manifest digest input and `inspection_digest`, which are persisted evidence. The README says callers "must remove credentials", but the producer enforces nothing, even though it is the only code that sees the string before it is digest-bound.
- **Minimal fix:** Reject `INVALID_INPUT` for any control character (`<0x20`, `0x7f`) or `^[a-z][a-z0-9+.-]*://[^/]*@` (userinfo). Add one test. Do not canonicalize or infer equivalence, since identity stays opaque.
- **Why not higher:** The caller obligation is documented and was dispositioned. This is cheap defense in depth, not a boundary break.

### P3-1. Stale and contradictory performance claim in the dispositions
- **Path:** `docs/implementation/joint-source-retarget/audit-dispositions.md`, item 1 versus Round 2 P2-4.
- Item 1 still says the real 512-file test "completed in about 7 seconds" and that "Batch I/O is a future optimization". Round 2 says batching was implemented. The 7 s figure comes from the per-blob design.
- **Fix:** Re-measure and update, or drop the number. Keep the "not an SLA" language.

### P3-2. Overbroad error mapping
- **Path:** `inspectGitSource` catch block, `'code' in error` → `OBJECT_UNAVAILABLE`.
- Any Node error carrying a `code` is classified as a non-retryable store failure. That includes `ERR_*` argument or runtime bugs, which should be `INTERNAL`.
- **Fix:** Map only errno-style codes (`/^E[A-Z0-9]+$/` and not `ERR_`) to `OBJECT_UNAVAILABLE`. Everything else becomes `INTERNAL`. Add a test with a stubbed throwing path if practical.

### P3-3. Test gaps at boundaries the code already handles
Each is a regression pin, not a defect:
1. An annotated-tag OID as `commit` → expect `OBJECT_MISMATCH` (peeling behavior above).
2. Uppercase or short `expectedContentSha256` → `INVALID_INPUT`.
3. A symlink or gitlink outside the subtree and not a license is tolerated, while one at the license path fails. The README states this, but only the license-symlink case is tested.
4. A path-length boundary: exactly 512 bytes passes, 513 fails. The current test checks only 513 and 65 components.
5. `repositoryPath` pointing at a `.git` directory (accepted by the `gitDir === repo` branch) is untested. Either test it or document it as intended.

### P3-4. Opaque failure diagnosis
- **Path:** `git()`, `stdio[2] = 'ignore'`.
- Dubious ownership, a permission denial and a missing object all surface as `OBJECT_UNAVAILABLE` with no operator-visible distinction. Discarding stderr is a defensible trade-off against stdout limits, and the dispositions accept it.
- **Optional fix:** Capture a small bounded stderr (at most 4 KiB, never returned or embedded in the error) only to select a distinct code, for example `UNTRUSTED_REPOSITORY_OWNER`.

### P3-5. Unverifiable packaging claims from this prompt
- **Path:** `packages/skill-registry/package.json`.
- `@osstack/protocol` is listed after `zod` (cosmetic ordering).
- The lockfile update claimed in the dispositions, any changeset or version bump for the new public subpath, and the exclusion of `*.test` output from `dist` and `files` were not in the supplied source.
- **Fix:** Confirm each in CI or package-check output before marking Ready.

### P3-6. Timing-sensitive test and noise
- **Path:** `source-snapshot.test.ts`, the 512-file test.
- It still has a 45 s timeout and a `console.info` timing line. On a loaded host, `SOURCE_TIMEOUT` would fail it, which is consistent with the documented non-SLA but may flake CI.
- **Fix:** Drop the `console.info`. Keep the file-count assertion. Consider recording elapsed time in the validation artifact instead of test stdout.

## Scope notes (not defects)
- Tree-edge trust, the lack of authenticated repository identity, materialization aliases (HFS and short names), the mutable result object, and J02b/J03/J12 work are all explicitly deferred or disclaimed. I did not repeat them.
- The retarget README correctly stays Draft and does not claim validation.

## Before Ready (host-side, outside this static review)
Fresh `build`, then the skill-registry and protocol tests, the Python `--check` and the package export check, all against base `69859eec`, with the exact commit SHA recorded.

END_AUDIT