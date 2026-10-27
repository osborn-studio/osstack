BEGIN_AUDIT

**Verdict: REVISE.** I found no P0. One P1 and several P2s block merge as an opt-in candidate. This is a static read of the supplied source only. I ran nothing, and the fixtures, `evidence/`, `validation.md`, the Python reference script and `index.ts` were not supplied, so claims that depend on them are marked unverified.

**Scope and contracts hold up.** The wrapper kind `source_inspection` is in no `JointContract` union member. The `SourcePin` shape is produced strictly. The file triples passed to `SourceSnapshot.safeParse` are exactly `{path, mode, blob}`, so J01's collision and prefix rules are reused without exporting a snapshot. The code never reads the worktree. Environment is allowlisted. Git is always invoked with `--git-dir` after the ancestor and gitfile check. Blob and commit IDs are recomputed. The claims about being not authenticated and no admission are stated consistently.

## P1

**1. The declared 512-file maximum is not guaranteed to finish inside the 30 s deadline.**
- Path: `packages/skill-registry/src/source-snapshot.ts`, `object()` and the `selected.map` loop.
- Counterexample: each blob costs two process spawns (`cat-file -s` and `cat-file blob`). A 512-file input needs about 1,030 spawns, plus about 12 setup calls. Spawn cost on macOS or a loaded CI host is 10–30 ms, so the run can exceed 30 s. A valid, in-limit input then fails with retryable `SOURCE_TIMEOUT`, and the result depends on host speed.
- The test `successfully inspects exactly 512 files…` only logs elapsed time and has a 45 s test timeout. It never asserts the elapsed time is under the 30 s operation limit, so it cannot catch this.
- Minimal fix: replace the per-blob spawns with one `cat-file --batch-check` (sizes, enforcing the per-blob and aggregate caps before any content read), then one `cat-file --batch` over the vetted OIDs. Pass the OIDs through `execFileSync` `input`, and keep the hash recomputation. Also assert elapsed time in the 512-file test, or lower the file cap to what is measured.

## P2

**2. The commit→tree→path/blob mapping is never hash-verified, so "immutable" covers only the leaves.**
- Path: `source-snapshot.ts`, `object('commit', …)` followed by `ls-tree -r … o.commit`.
- Counterexample: commit and blob bytes are recomputed against their OIDs, but tree objects are not. The `tree <oid>` header line of the verified commit is not parsed or compared with what Git resolves. A tree whose bytes do not match its name, but which is valid zlib, yields a manifest that was never bound to the verified commit, and the digest then claims that commit. The README discloses this trust, but it is the weakest link in the digest claim. It is out of scope only for malicious same-UID mutation.
- Minimal fix: parse `tree <oid>` from the verified commit bytes and run `ls-tree` on that OID. Cheaply hash-verify the trees along the walk (`ls-tree -r -t -z`, then hash each tree), or explicitly narrow the README wording to "blob and commit bytes".

**3. The new digest domains have no protocol-level vectors.**
- Path: `packages/protocol/src/joint-json.ts` (`source-content.v1`, `source-inspection.v1`).
- Counterexample: `digest-vectors.json` is pinned at 24 valid and 5 invalid vectors, and `reference-vectors.json` covers only the listed helpers. The only independent check of the new domains is an inline Python snippet inside the skill-registry test. The README says "registered in the protocol digest catalog". `digest-catalog.json` was not supplied. If it was not updated, `joint-reference.test.ts` fails on the sorted equality.
- Minimal fix: add vectors for both domains (including non-ASCII paths, mode 100755 and the license role) to the protocol fixtures and reference script. Confirm `digest-catalog.json` lists them.

**4. Many boundary tests use bare `.toThrow()`, and several documented limits have no test.**
- Path: `source-snapshot.test.ts`.
- Counterexamples:
  - `rejects missing objects…`, `rejects unsafe subdir` and the case-collision test never assert the error code. `{commit:'f'.repeat(64)}` on a sha1 repo could fail for the wrong reason, and a regression to `INTERNAL` would still pass.
  - There is no test for tracked unsafe paths: `method/a:b`, `x.`, `.GIT/x`, a backslash, a control byte, or invalid UTF-8 outside the subtree.
  - There is no test for the 64-component or 512-byte limits, or for prefix collisions (`a` and `a/b`).
  - There is no test for the 2 MiB tree cap or the 64 KiB commit cap.
  - There is no test for the object-format mismatch, a gitlink at the subdir, or a duplicate license across the source/license roles.
  - There is no `GIT_CONFIG_COUNT` or `GIT_CONFIG_PARAMETERS` injection test.
- Minimal fix: assert `code` with `toMatchObject` everywhere. Add tests for each limit and rejection the README lists.

**5. There is no test of the public export surface.**
- Path: `packages/skill-registry/package.json` and `source-snapshot.test.ts`.
- Counterexample: the test imports `./source-snapshot.js` relatively. Nothing verifies that `@osstack/skill-registry/source-snapshot` resolves through `exports` after build, that its `types` file exists, or that the root entry still lacks `inspectGitSource`. A wrong `dist` path or an accidental root re-export would pass.
- Minimal fix: add a test modeled on the `joint-admission` import-blocking test, covering subpath success and root absence. Also confirm the `prepack` script keeps the new subpath and that `tsc` handles `src/*.test.ts` consistently with sibling packages.

**6. The retarget evidence claims are not backed.**
- Path: both READMEs.
- Counterexample: the J02a README says "Fresh retarget verification is recorded in the retarget report". That report contains no commands or results, only "in progress; Draft". The README cites `evidence/` and `validation.md`, which are not in the supplied files. The Git 2.55.0 observation comes from a different PR's check log, not this PR on `69859eec`.
- Minimal fix: record the actual commands, outputs, CI run and Git versions for this base, or reword the README to say they are pending.

## P3

**7. Typed-error misclassification.**
- Path: `source-snapshot.ts` `git()` and `inspectGitSource`.
- Counterexample: a `gitBinary` that is a directory, not executable, or missing (spawn `ENOENT`/`EACCES`) maps to `OBJECT_UNAVAILABLE`. That code is documented as a filesystem/store failure, and `INVALID_INPUT` is the better fit. The catch-all `'code' in error` also relabels non-filesystem Node errors. A concurrent `gc`, `repack` or fetch on the mirror yields a non-retryable `OBJECT_UNAVAILABLE` for a transient race.
- Minimal fix: classify spawn errors before the store errors. Narrow the catch-all to `errno` codes. Consider marking mid-run object disappearance as retryable.

**8. `repository` is not constrained.**
- Path: the `Input` schema in `source-snapshot.ts`.
- Counterexample: `repository` accepts leading or trailing whitespace and control characters, because `SourcePin` uses a bare `z.string()` there. Two spellings of the same remote produce different digests, and the value is bound into the content digest.
- Minimal fix: apply the `Ref`-style canonical check (no control characters, no surrounding whitespace). Document that there is no URL normalization.

**9. The executed binary and PATH differ from what the host named.**
- Path: `realpathSync(o.gitBinary)` and `env.PATH`.
- Counterexample: the resolved path is executed, so a multi-call or wrapper symlink loses its `argv[0]` identity. The inherited `PATH` makes behavior depend on the caller's environment.
- Minimal fix: execute the host path as given after a trust check, and pin `PATH` to a fixed value.

**10. The collision profile is narrower than the platforms it names.**
- Path: `pathSafe` plus `SourceSnapshot`'s `normalize('NFC').toLowerCase()`.
- Counterexample: `ß`/`SS`, NFKC and HFS ignorable-codepoint aliases, and Windows reserved names (`CON`) are accepted by inspection. The README disclaims this for materialization, so it is only a reminder that J02b must enforce it before any write.

END_AUDIT