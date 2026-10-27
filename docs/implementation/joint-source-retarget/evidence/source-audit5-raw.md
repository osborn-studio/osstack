BEGIN_AUDIT

**Verdict: PASS.** This is a static read of the supplied source against base `69859eec`. I found no P0, P1 or P2. It is not runtime, host or Git-vendor qualification. The Draft status and pending host validation are correctly stated, and the PR does not claim PASS.

## Confirmed fixed

- **Identity hygiene.** `inspect()` rejects control bytes and `scheme://…@` userinfo with `INVALID_INPUT`.
  - The check runs right after `Input.safeParse` and before any `realpathSync`, spawn or file access.
  - The guard has no effect on the digest because the identity stays opaque.
- **Previous P2 (test discrimination).** The hygiene and `'\ud800'` cases now use the real `gitBinary` from `fixture()`.
  - Deleting the userinfo regex would therefore turn `https://user:secret@…` and `https://token@…` into passing inspections and fail the test.
  - The `'\ud800'` case is rejected by `canonicalJointJson`'s `unicode()` check after `SourcePin.safeParse`, so it fails for the intended reason.
- **Contract compatibility is unchanged.**
  - `SourcePin.safeParse` and `.parse`, and the `SourceSnapshot.safeParse` used for the collision/prefix check, are used as before.
  - `selected` has exactly the `{path,mode,blob}` shape that `SourceSnapshot` expects.
  - Both domains are in `JOINT_DIGEST_DOMAINS` and `digest-catalog.json`.
  - The wrapper is rejected by the decoder, and the test also covers a relabeled `source_snapshot` carrying `dependencies: []`.
- **Boundaries I re-checked and found sound:**
  - **Git invocation.** Each call uses `--git-dir`, an allowlisted env with `HOME` unset, `GIT_CONFIG_GLOBAL=/dev/null`, and `core.hooksPath`/`fsmonitor`/`protocol.allow` overrides. `cat-file` is never run with `--filters` or `--textconv`.
  - **Object IDs.** `commit` must be 40/64 lowercase hex, so no rev-syntax injection into `cat-file` or `ls-tree`. `subdir` cannot contain `:`, so `${commit}:${subdir}` stays literal.
  - **Tag substitution.** A tag OID passed as `commit` dereferences to different bytes or a different size and ends in `OBJECT_MISMATCH`.
  - **Batch framing.** Header, size, trailing newline and exact end offset are verified, and each blob is re-hashed against its OID. The batch-check (64 KiB) and batch (8 MiB + 64 KiB) buffers fit the worst case of 512 distinct OIDs.
  - **Digest size.** A worst-case file set of 512 files with 512-byte `"`-heavy paths (each `"` escapes to two bytes) stays around 650 KB, below the 1 MiB `canonicalJointJson` cap. So `INTERNAL` is not reachable from a valid selection.
  - **Python/JS canonicalization.** The two are compatible for this payload because all keys are ASCII and control characters are rejected.

## Findings

### P3-1. Control-byte guard is dead code, and the disposition overstates it
- **Path:** `source-snapshot.ts` (`inspect()`, hygiene line) and `audit-dispositions.md` "Round 4".
- **Counterexample:** `Ref` in `joint-primitives.ts` already rejects characters below 32 and 127. `SourcePin.safeParse(preliminary)` therefore returns `INVALID_INPUT` for `opaque\nidentity` and `opaque\u007fidentity` even if the control predicate is removed. Only the userinfo regex is protected by a guard-removal mutation. Round 4's claim "A guard-removal mutation must now fail the test" holds for userinfo only.
- **Minimal fix (pick one):** drop the control predicate and rely on the shared `Ref`, which also avoids rule drift. Or keep it as defense in depth and reword the disposition to say the control cases are covered by the shared contract.

### P3-2. Userinfo regex has false positives
- **Path:** `source-snapshot.ts`, `/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i`.
- **Counterexample:** `https://example.invalid?ref=a@b` and `https://example.invalid#x@y` have no `/` after the authority, so `[^/]*@` matches inside the query or fragment and rejects a credential-free identity. This fails closed, so it is safe.
- **Fix:** isolate the authority with `[^/?#]*@`, and add one positive and one negative test.

### P3-3. `'code' in error` misclassifies runtime errors
- **Path:** `source-snapshot.ts`, `inspectGitSource` catch.
- **Counterexample:** a Node `ERR_*` error, such as `ERR_INVALID_ARG_TYPE` from an internal bug, becomes retry-free `OBJECT_UNAVAILABLE` instead of `INTERNAL`. This hides defects behind a store-failure code and is not an admission risk.
- **Fix:** map only errno-style codes (`/^E[A-Z0-9]+$/`, not `/^ERR_/`) to `OBJECT_UNAVAILABLE`, and map everything else to `INTERNAL`.

### P3-4. Test hygiene and missing boundary pins
- **Path:** `source-snapshot.test.ts`.
- **Console noise.** The 512-file test calls `console.info`, which is unnecessary in CI. The 45 s timeout is generous given the measured 134 ms. Neither is a defect.
- **Async describe.** `describe(..., async () => …)` has no `await` inside, so it works, but it is discouraged and can trip future Vitest strictness. Make it synchronous.
- **Boundary regressions not pinned.** Add cases for:
  - a tag OID passed as `commit`, expecting `OBJECT_MISMATCH`;
  - a path of exactly 512 bytes and exactly 64 components, expecting pass;
  - a symlink or gitlink outside the subtree that is not a license, expecting pass;
  - `repositoryPath` set to the `.git` directory, expecting `INVALID_INPUT`.
- **Hardcoded SHA-1.** The raw-tree test hardcodes SHA-1 object construction. That is fine because `fixture()` defaults to `sha1`, but it should say so in a comment.

### P3-5. Unverifiable from this source (host checks)
- **Kind literal.** The negative-decoder test passes `'recovery_proof'` to `decodeJointContractAs<K extends JointContract['kind']>`. If `RecoveryProofEnvelope.kind` is a different literal, `tsc -p .` fails because the test is compiled. Vitest would not notice, since it does not typecheck. The host build covers this.
- **Packaged tests.** `files: ["dist"]` plus `tsc -p .` emits `source-snapshot.test.js` unless the tsconfig excludes it. The dispositions claim the dry-run excludes it. Confirm from the `npm pack --dry-run` file list, and confirm that the lockfile and the 0.22.0 rewrite of the `workspace:*` deps match the dispositions.
- **Cosmetic.** `@osstack/protocol` is listed after `zod` in `dependencies`.

## Scope notes (not defects)

I did not repeat any of these:
- Tree-edge trust, authenticated repository identity and URL normalization.
- Materialization aliases. The case-collision check uses `toLowerCase`, not full case folding, and that is the future writer's obligation.
- Same-UID mutation of the host binary or store.
- Mutable result objects, and J02b, J03 and J12 runtime features.
- Credential forms the producer does not detect, such as `user:pw@host/path`, backslash authorities, query-string tokens, C1/bidi characters, and `ssh://git@host`. The README discloses that callers must supply a sanitized identifier.
- The scheduling-only 30 s deadline.

## Before Ready (host-side)

- Fresh runs against `69859eec` on the exact committed SHA: clean build, then the skill-registry and protocol tests, then `joint-reference-vectors.py --check`.
- The Python vectors do not cover the two new domains. The test's inline Python check does, using the same canonicalization rules, so this is not a gap for this slice.
- `npm pack --dry-run`, plus the package export and declaration check.
- Record the exact commit SHA alongside the Git vendor and version used. This review is not a substitute for any of these.

END_AUDIT