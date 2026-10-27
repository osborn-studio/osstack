BEGIN_AUDIT

**Verdict: REVISE.** This is a static read of the supplied text only. Nothing was executed and none of the sources were treated as instructions. This is not runtime qualification.

I found no P0 and no confirmed way to forge or escalate authority through the inspector. The Git command boundary, byte hashing, the wrapper's separation from the latest contracts, and typed errors are mostly sound. The REVISE verdict rests on one P1 evidence-claim defect and several P2 gaps in integrity, contract semantics, and test reliability.

## P1

**P1-1. The README claims retarget verification that the retarget report says is still in progress.**
- Path: `docs/implementation/joint-source-inspection/README.md`, "Digests and provenance".
- Claim: "Fresh retarget verification is recorded in [the retarget report]".
- Counterexample: `docs/implementation/joint-source-retarget/README.md` says validation and audit "are in progress; the PR remains Draft". `audit-dispositions.md` item 6 says outputs "must pass before Ready". The README also cites `evidence/` and `validation.md`, which are not in the reviewed set.
- Impact: a downstream reader (J02b, a reviewer) is told evidence exists when it does not. This is a false statement on an admission-boundary document.
- Minimal fix: reword to "pending; see the retarget report", or land the actual results. Drop the `evidence/` and `validation.md` references until those files exist.

## P2

**P2-1. The result cannot be re-verified after crossing the required worker boundary.**
- Path: `packages/skill-registry/src/source-snapshot.ts` (exports) and the README, which requires worker isolation.
- Counterexample: the parent receives a JSON `GitSourceInspection` over IPC. Only TypeScript types exist. There is no runtime schema and no exported function that recomputes `pin.content_sha256` and `inspection_digest` from the wrapper. A truncated or corrupted payload, or one with an inconsistent digest, is accepted by any consumer that trusts the types. The only recomputation is an inline Python snippet inside a test.
- This is integrity and shape only, not authentication. The README still says the output is "immutable", yet the returned object is a mutable plain object.
- Minimal fix: export a pure `verifyGitSourceInspection(unknown)`. It should strict-parse the wrapper, recompute both digests, and check the license_refs derivation and file ordering. Add a tamper test. Optionally freeze the result.

**P2-2. Two unrelated paths in an upstream repo can make a pinned subdir uninspectable.**
- Path: `source-snapshot.ts`, `utf8(git(['ls-tree','-r','-z','--full-tree',…]))`.
- Counterexample: a commit pinned at `method/` also contains `legacy/caf\xe9.txt` encoded as Latin-1. `utf8()` fails on the whole listing, so the result is `UNSAFE_ENTRY` for a subdir that is entirely clean. The 2 MiB cap works the same way: a large unrelated tree causes `RESOURCE_LIMIT`. An immutable commit cannot be repaired upstream, so this is an availability lever controlled by whoever authored the unselected paths. The README documents it, but documentation does not remove it.
- Minimal fix: parse the listing as bytes. Split on `\0`, then on the first tab. Compare the raw path bytes against the subdir prefix and the license bytes, and UTF-8-decode only selected entries. Optionally list `commit:subdir` and each license path separately with `--literal-pathspecs` to drop the whole-repo cap too.

**P2-3. The `license_refs` semantics are defined only by this producer.**
- Path: `source-snapshot.ts` (`sha256:<file hash>`) versus `packages/protocol/fixtures/joint/contracts.json`.
- Counterexample: the frozen valid `source_pin` fixture uses `"license_refs": ["LICENSE"]`, which is path-like. `SourcePinShape` accepts any 1–512 character string. A consumer written against the frozen fixture reads the inspector's `sha256:…` values as names or paths. A producer can emit either and both validate. No protocol-level test or catalog text pins the meaning. It exists only in the README, and the inspector's own tests do not assert the ref format.
- Minimal fix: in `digest-catalog.json`'s `source-content` and `source-inspection` rows, state that `license_refs` are `sha256:` content refs, and add a producer test asserting that format. Leave the shared fixture untouched, but record in the README that J02b must reconcile the two conventions.

**P2-4. The cost model makes the 512-file success test depend on host speed.**
- Path: `source-snapshot.ts` (`object()`) and the 512-file test.
- Counterexample: each blob costs two synchronous spawns (`cat-file -s`, then `cat-file blob`), so a full capture is about 1,030 spawns against a 30-second deadline. The test hard-asserts success and measured about 7 s on one host. A loaded or slower CI runner can legitimately return `SOURCE_TIMEOUT` and fail the suite, which defeats the "reject threshold, not a completion SLA" framing. The disposition defers batching, but the test still treats timing as a pass condition.
- Minimal fix: use one `cat-file --batch-check` (a bounded 512 lines) to validate all sizes, then one `cat-file --batch` with `maxBuffer = remaining total + framing`. Keep the per-object hash check. Failing that, make the test tolerate retryable `SOURCE_TIMEOUT` on shared CI.

**P2-5. Build ordering and dependency surface changed for the whole package.**
- Path: `packages/skill-registry/package.json`.
- The root entry is unchanged, but `@osstack/protocol` is now a runtime dependency of a published package (`publishConfig.access: public`). Whether protocol is publishable at a matching version, and whether `prepare-npm-package.mjs` rewrites it, cannot be seen from the supplied sources. `pnpm-lock.yaml` is not shown either.
- The `test` script is `vitest run` with no build step. The export test needs `dist/*.d.ts`, and `@osstack/protocol/joint` resolves to a built `dist`. A stale protocol `dist` without the two new domains makes `jointDigest` throw `UNKNOWN_JOINT_DIGEST_DOMAIN`, which the inspector surfaces as `INTERNAL`. On a cold checkout or filtered test run the tests fail for build-ordering reasons, not product reasons.
- Minimal fix: confirm the lockfile and the publish path for protocol. Add a task dependency (turbo `dependsOn: ["^build","build"]`) or a `pretest` build.

**P2-6. Several tests would still pass after the regression they are meant to catch.**
- Path: `source-snapshot.test.ts`.
- Counterexample: the case-collision test, the missing/corrupt-blob test, and the duplicate-license test use bare `.toThrow()`. If the collision check regressed to throw `INTERNAL` or `OBJECT_UNAVAILABLE`, all three would stay green.
- Untested boundaries:
  - Relative `gitBinary` or `repositoryPath` (the `isAbsolute` branch).
  - The `ENOBUFS` → `RESOURCE_LIMIT` mapping for a >2 MiB `ls-tree`. It is Node-version-dependent, and `engines` says `>=20`.
  - The 30-second deadline path, which fires before a spawn. Only the 5-second per-process timeout is exercised.
  - The 513-file boundary. The test uses 515.
- Minimal fix: assert the exact `code` in each of those tests and add the four missing cases.

## P3

1. **README versus code on partial-store keys.** The README says "any configured partial/promisor key". The code matches only `extensions.partialclone` and `remote.*.promisor`. `remote.<n>.partialclonefilter` passes. Add it to the regex, or narrow the README.
2. **"Commit bodies are capped at 64 KiB".** The code caps the whole commit object, headers included. Reword.
3. **Path rules in the README are incomplete.** Actual rejection also comes from the SourceSnapshot `Ref` rule, which rejects a full path that changes under `trim()` (including NBSP). Equivalent paths are also rejected via NFC plus `toLowerCase()`, which is not full case folding. List these or point to the contract.
4. **Platform.** The code assumes POSIX (`/dev/null`, `GIT_CONFIG_GLOBAL`, `colon` and `backslash` rules). State "POSIX only", since `engines` does not exclude Windows.
5. **`"./*": "./*"` in `exports`.** If it is not pre-existing, it makes the deep path `…/dist/source-snapshot.js` reachable, so "opt-in subpath" is not enforced by exports. Verify; the wildcard is harmless if it was already there.
6. **`repository` is opaque.** A value such as `https://user:token@host/…` is copied into the pin, the digest and every output. Consider rejecting userinfo, or document that callers must pass sanitized identifiers.
7. **Error mapping.** Any error carrying `code` becomes `OBJECT_UNAVAILABLE`, including transient `EMFILE`, `EAGAIN` and `ENOMEM`, and these are non-retryable. This was accepted in disposition 7; at minimum document it.
8. **Git 2.48 floor is unmeasured.** Only 2.47.9 rejection is tested through a stub. Measured binaries are 2.54 and 2.55. The README says this honestly; keep it that way.
9. **Tree objects are not hash-verified.** This is documented and within the trusted-store scope. The consequence is that the digest binds commit and blob bytes, and the commit-to-path mapping is only as good as Git's tree read. Keep it explicit in J02b hand-off text, and note that the inspector retains only hashes, so a later materializer must re-verify blob object ids.
10. **Independent-verification wording.** The inline Python check recomputes the canonical JSON digests from the output files. It does not re-hash blob bytes, so the "independent" claim covers canonicalization only.

## What held up

- **Contract separation.** The wrapper uses `kind: source_inspection`, which is not in the `JointContract` union. Extra file fields (`bytes`, `sha256`, `role`) fail the strict `SourceSnapshot` files shape. Relabeling still fails because of the `dependencies` and wrapper fields. The embedded `pin` passes strict `SourcePin`. The sort order (raw UTF-8 bytes) matches the `source-snapshot.v1` catalog rule.
- **Domain registry.** `JOINT_DIGEST_DOMAINS` and `digest-catalog.json` both contain the same 20 domains, so the existing sorted-equality test remains consistent. No existing digest rule changed.
- **Git command boundary.** Full-OID arguments cannot be parsed as options. Pathspecs are not used. The environment is allowlisted. Global and system config are disabled. Replace objects are off, hooks and fsmonitor are neutralized, and `protocol.allow=never` is set. Ancestor and gitfile discovery are rejected. The blob size check precedes the content read. Commit and blob hashes are recomputed with the repo's object format. Aggregate and per-blob caps reject rather than truncate. Failures return no partial evidence.
- **Size headroom.** The worst-case canonical JSON for 512 files stays under the 1 MiB `canonicalJointJson` limit.

END_AUDIT