BEGIN_AUDIT

**Verdict: PASS** (static read only, base `69859eec`). I found no P0 or P1. This is not runtime or host qualification, and nothing here replaces the pending host validation. The PR is correctly Draft.

## Confirmed fixed

- **Repository hygiene (prior P2-1).** `inspect()` in `source-snapshot.ts` now rejects `/[\x00-\x1f\x7f]/` and `^[a-z][a-z0-9+.-]*:\/\/[^/]*@` (case-insensitive) with `INVALID_INPUT`.
  - The check runs after `Input.safeParse` and before any `realpath`, spawn or file access, so a rejected identity never reaches Git or a digest.
  - Counterexamples now rejected: `https://ghp_TOKEN@github.com/o/r` and `opaque\nidentity`.
  - Identity stays opaque, with no normalization, as the dispositions state.
- **Contract compatibility is unchanged.** `SourcePin.parse` and `SourceSnapshot.safeParse` are used as before. The wrapper is still rejected by the decoder for all five kinds. Both digest domains are still in `JOINT_DIGEST_DOMAINS` and `digest-catalog.json`.
- **No other source change.** The Git argv, env allowlist, limits, batch parser and error taxonomy are untouched, so I see no regression surface beyond the new line.
- **Docs match the code.** The README says the producer rejects ASCII control bytes and URL userinfo, and that callers must still sanitize other forms. Round 3 in the dispositions records this accurately.

## Findings

### P2-1. The new negative tests do not exercise the fix
- **Path:** `source-snapshot.test.ts`, test "binds the mirror root and rejects malformed identity before running Git".
- **Counterexample:** The four new cases (`https://user:secret@…`, `https://token@…`, `opaque\nidentity`, `opaque\u007fidentity`) all pass `gitBinary: '/nonexistent'`. With the new hygiene line deleted, `realpathSync('/nonexistent')` still throws and maps to `INVALID_INPUT`. The suite stays green with the fix reverted. The existing `'\ud800'` case has the same flaw. The comment "before running Git" is not what the test proves.
- **Minimal fix:** Use the real `gitBinary` in the loop. The cases must then fail only because of the hygiene check, since the fixture is otherwise valid. Optionally add a sentinel git stub that touches a file, asserting it is never invoked.

### P3-1. Hygiene gaps (defense in depth, not a boundary break)
- Credentials with no scheme or no `//`, such as `user:pw@host/path`, and credentials in a query string, such as `?token=x`, pass. This is consistent with the documented caller obligation.
- C1 controls (U+0080–U+009F), U+2028/2029 and bidi overrides pass. `Ref` in joint-primitives only rejects ASCII controls.
- **Fix, if wanted:** Reject `/[\u0080-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/`, or reuse the protocol `Ref` refinement so the rules cannot drift. Add a test if you do.

### P3-2. Userinfo rule also rejects `ssh://git@host/...`
- This is common and carries no secret, and the rule gives it no escape hatch. The README says "URL userinfo" is rejected, so it is documented.
- **Fix:** Add one sentence saying that callers must choose an identifier without `user@`, for example `https://` or `ssh://host/...`. Alternatively, allow userinfo with no `:` and document it. I recommend keeping the strict rule and documenting it.

### P3-3. Carried-over items (unchanged, non-blocking)
- **Error mapping.** `'code' in error` maps to `OBJECT_UNAVAILABLE`, so `ERR_*` runtime bugs are misclassified. Map only errno-style codes `/^E[A-Z0-9]+$/` and not `ERR_*`; everything else becomes `INTERNAL`.
- **Test noise.** The 512-file test still has `console.info` timing and a 45 s timeout. The dispositions record 134 ms as a non-SLA measurement. The log line is unnecessary.
- **Boundary regression pins.** These are still missing:
  - a tag OID passed as `commit` expects `OBJECT_MISMATCH`;
  - a path of exactly 512 bytes passes;
  - a symlink or gitlink outside the subtree and not a license is tolerated;
  - `repositoryPath` set to a `.git` directory.
- **Stale disposition item 1.** It is labeled "superseded by Round 2 batching" and Round 3 gives 134 ms, so the contradiction is resolved. Only the "future optimization" wording remains.
- **Packaging claims.** The `files`/`dist` test exclusion, the lockfile update and the 0.22.0 dependency rewrite are asserted in the dispositions. They are not verifiable from this source.
  - `package.json` has `"files": ["dist"]`, and `tsc -p .` emits `source-snapshot.test.js` into `dist` unless the tsconfig excludes it.
  - Confirm the tsconfig exclusion and the `npm pack --dry-run` file list in CI.
  - `@osstack/protocol` is listed after `zod` (cosmetic only).

## Scope notes (not defects)
- Tree-edge trust, authenticated repository identity, materialization aliases, mutable result objects and J02b/J03/J12 work are explicitly disclaimed. I did not repeat them.
- The retarget README stays Draft and makes no validation claim.

## Before Ready (host-side)
- **P2-1:** Fix the test so it discriminates.
- **Fresh runs against `69859eec`:** a clean build, then the skill-registry and protocol tests, the Python `--check`, and the package export/dry-run check. Record the exact commit SHA.

END_AUDIT