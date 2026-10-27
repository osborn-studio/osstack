BEGIN_AUDIT

**Verdict: REVISE.** The scope is sound and appropriately bounded. The blockers below are spec ambiguities that would let two implementers produce different digests, or let a partial snapshot be read as a closed one. None needs future registry work.

**Blockers (fix before implementation)**

1. **`dependency_resolution='not_performed'` sits outside the digest-bound object.** It lives on the output wrapper, not in the J01 `SourceSnapshot` or `sourceSnapshotDigest`. An empty `dependencies` array in a detached snapshot is indistinguishable from "no dependencies, closed". The "no registry may treat it as closed" rule is prose only. Fix: either encode the marker inside the snapshot (if #273 allows it), or require that the only exported type is the wrapper and that J02b admission rejects a bare `SourceSnapshot`. State which.

2. **Manifest path semantics are undefined.** Are `files[].path` values repo-relative or subdir-relative? License files may lie outside the subdir, so they must be repo-relative, and the spec should say so. The following cases are also unspecified:
   - A declared license file that is also inside the subdir. It would be either a duplicate entry or a single role, and `role` allows only one value.
   - Duplicate declared license paths.
   - An empty subdir (zero files).
   - A missing subdir versus an empty one.
   - A subdir path that resolves to a symlink or gitlink rather than a tree.

3. **Sort order and normalization are ambiguous.** "Sorted by UTF-8 path" should read "bytewise on raw UTF-8 path bytes, no normalization". NFC is used only for collision rejection, never to rewrite stored paths. Say so, and state the allowed modes explicitly (100644 and 100755). Mode is digest-bound, so an executable-bit change changes the digest.

4. **Limits do not say "fail closed".** "Read at most 512 files / 8 MiB" could be implemented as truncation. Require rejection with no partial snapshot, with sizes checked before reading content (e.g. via `cat-file --batch-check`). Timeouts need a distinct, retryable error class so they are not confused with digest drift or malformed input. Also add max path length and depth, since none are stated.

5. **"No lazy network fetch" and "environment injection ignored" are not operationalized.** Specify the following:
   - Scrub `GIT_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_REPLACE_REF_BASE`, `GIT_CONFIG_*`, and `GIT_EXEC_PATH`.
   - Set `GIT_NO_REPLACE_OBJECTS`, `GIT_CONFIG_NOSYSTEM`, and global config to `/dev/null`.
   - Use `GIT_NO_LAZY_FETCH=1` plus a promisor-remote check, with a minimum Git version recorded. Lazy-fetch suppression is version-dependent.
   - Invoke Git by resolved absolute path and record it.
   - Use `--git-dir` explicitly so a non-bare mirror's worktree is never consulted.
   
   Add negative tests for promisor/partial clones, `objects/info/alternates`, and each injected variable.

6. **Provenance claim is weaker than the field names suggest.** `repository` is caller-asserted. A mirror may contain the commit via a fork or alternates, so the digest does not bind commit to repository. Add an explicit output flag, such as `repository_identity: 'caller_asserted'`. Likewise, when the optional expected content digest is absent, record that no drift check ran (e.g. `expected_digest_checked: false`), so first-use trust is visible downstream.

7. **Dependency on #273 is a moving target.** "J01 #273 fixed candidate" has no pinned head SHA. Per execution.md, the contract follows #273, and `content_sha256` feeds `sourceSnapshotDigest`. Pin the #273 head SHA in the ledger, require revalidation after retarget, and confirm #273 does not already assign `content_sha256` a different meaning. "Does not change sourceSnapshotDigest" is true of the function but not of its values.

**Advisory (non-blocking)**

8. **"Recomputed" scope.** Only blob and commit bytes are rehashed. Tree contents come from `ls-tree` and rely on the trusted store. The spec should say so, and also require that the commit's object format (SHA-1 or SHA-256) match the repository's, so a 64-hex commit in a SHA-1 repo is rejected.

9. **Path hygiene list.** Make it explicit: reject `.git` components in any case or NTFS variant, backslashes, NUL and control characters, empty, `.` or `..` components, and non-UTF-8 bytes. Symlinks or gitlinks anywhere inside the subdir fail the whole snapshot, and entries outside the subdir are ignored. Say that this is intentional.

10. **Missing tests.** Add:
    - license outside the subdir, license also inside the subdir, and duplicate license declarations
    - object-format mismatch
    - identical digest across loose versus packed objects and across clones
    - the wrapper-versus-bare-snapshot admission rule from item 1

**Handoff and authority**

11. **Single owner has no succession rule.** The owner is a session ID, and the doc itself disclaims recovery of that session. Add a named fallback or a "no owner, halt and escalate" state recorded in the ledger. "Firstmate completes existing batches" needs a frozen list (ids and head SHAs) recorded at handoff time, plus an acknowledgement entry. Otherwise "no new packages" is unenforceable. Also identify the A/B "integration candidate" by branch and SHA.

12. **Audit independence.** The Sonnet 5.5 CLI audit may be the same model family as the implementer. Record that, or require a different reviewer or a human gate for authority-affecting changes.

13. **Completion claims.** Add that a slice is "done" only at a merged SHA with CI on that SHA. A Draft stacked PR on unmerged #273 is "candidate" only. Add one line mapping J02a to the end-to-end journey it advances, since the doc forbids substituting infrastructure for journeys.

14. **Minor.**
    - The doc is dated 2026-10-27 while the current date is 2026-10-26.
    - "69" appears both as the original task count and as the future acceptance scenario count. Confirm this is not a conflation.
    - The pinned OSStack admin version is not named.

**Confirmed sound**

- Reading Git objects rather than the checkout.
- Treating the snapshot as data, not activation.
- Domain-separated, acyclic digest.
- License refs established as bytes, not legal permission.
- No DB, CLI, or scheduler in the slice.
- J02b deferral.
- Ledger-as-checkpoint rather than a second scheduler.
- GitHub as the source of truth in conflicts.

END_AUDIT
