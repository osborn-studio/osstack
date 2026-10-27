# Sonnet 5.5 retarget audit dispositions

Round 1 is preserved without edits. Host validation and final static review are separate from runtime qualification.

1. Historical round-1 position (superseded by Round 2 batching): no promised 512-file SLA: 512 is a rejection ceiling, not guaranteed completion on arbitrary hardware. The real test completed in about 7 seconds; a slower host may return typed retryable SOURCE_TIMEOUT by design. Clarified scheduling deadline vs kernel/filesystem wall-clock bounds and host-dependent capacity. Batch I/O is a future optimization, not necessary for this bounded opt-in inspector's correctness.
2. Explicitly narrowed independent verification to commit and blob bytes; tree mapping remains trusted, including corruption. The original README already declared tree/store trust. No claim of independently authenticated commit-to-tree provenance or materialization is made.
3. Both domains were already registered in digest-catalog.json. Independent Python checks run on actual SHA1/SHA256 source output, including Unicode and license role; they are not merely same-implementation vectors. Catalog, public index and historical validations now supplied in review. Six protocol constructor vectors are not claimed to cover every domain.
4. Added exact error assertions for missing/malformed objects and subdirs; hostile raw-tree path, byte/depth, invalid UTF-8 and oversized-commit tests; injected GIT_CONFIG_COUNT/PARAMETERS included. Existing source tests cover format mismatch, gitlink/symlink, duplicate license, blob/aggregate/file caps and normalized collisions. Full branch evidence records the actual supported cases, not an exhaustive fuzz or platform certification.
5. Added child-Node public export test: opt-in subpath resolves, declaration file exists, root does not export inspector. Build precedes tests.
6. Fresh test/audit/replay outputs are collected separately and must pass before Ready. Historical Git vendor observations are not current candidate CI qualification. Final report will identify exact code/base and local versus GitHub status.
7. Conservative non-retryable store error remains intentional; provisioning/binary failures do not automatically schedule retries. No source result is returned on errors. Host installation checks and mirror lifecycle are outside this API.
8. Repository is an opaque host-asserted identity, not a normalized remote URL. Distinct exact spellings intentionally produce distinct digests. J02b authenticates/canonicalizes identity before adoption; this inspector must not infer equivalence.
9. Realpath is the trusted executable selected by this API's contract. Host PATH is trusted provisioning context; no hook/filter/protocol is executed. Changing multicall-wrapper semantics or global PATH policy is not justified by a concrete supported-Git counterexample.
10. Materialization aliases remain J02b/future writer obligations. No files are written by inspection.

## Round 2

- P1-1: clarified that the linked report records validation status; Draft/pending is explicit until actual results are archived. Historical evidence files already exist, though not all were pasted into the tool-less prompt. Missing prompt context was not missing repository evidence.
- P2-1: no IPC consumer exists in J02a. Documented mutable evidence and mandatory J02b receiving-boundary parse/digest verification. Adding a new public verifier without its consumer is a separate API design, not necessary to this producer's scope.
- P2-2: conservative whole-tree UTF-8/output caps are deliberate support-profile rejection, already disclosed. No availability SLA for arbitrary upstream repositories. Retained, not silently broadened to materialization/adoption.
- P2-3: documented producer-specific sha256 license refs versus generic SourcePin fixtures and added derivation assertion; J02b maps/validates the convention.
- P2-4: accepted batching improvement. Replaced per-blob subprocesses with bounded batch-check + batch reads; validates all sizes before reading bytes, verifies framing, exact Git IDs and raw byte hashes. Added binary/NUL/newline, empty-object and duplicate-object tests.
- P2-5: build-before-test is the monorepo workflow, not unique to this PR. Lockfile/direct public protocol dependency already updated; package/publish checks will be archived. No unrelated turbo/pretest pipeline changes.
- P2-6: tightened collision/missing/duplicate errors; added relative host paths and real >2 MiB tree-output test; corrected file-count negative to exactly 513. Batch timing still uses bounded subprocess deadline; no arbitrary host SLA.
- P3-1 through P3-10: clarified exact promisor keys, whole commit size, POSIX scope, existing wildcard exports, sanitized opaque repository identity, trusted-tree and independent-digest limits. Shared Ref/collision checks remain required; nonretryable store errors intentionally require host/provisioning review.

## Round 3 closeout

Sonnet returned PASS (no P0/P1) with one P2 hardening suggestion and P3 notes. Accepted P2: repository identity now rejects control bytes and URL userinfo before Git/file access, with negative tests. Identity remains opaque; no URL normalization or equivalence is inferred. Historical round-1 performance disposition is explicitly superseded by batching; current 512-file fixture measured 134 ms on this host (not a portable SLA). Published-package dry run verifies both exports/declarations, excludes compiled tests, and rewrites protocol/core workspace dependencies to 0.22.0. P3 error taxonomy/optional regression cases remain non-blocking; no runtime/qualification claim added.

## Round 4 closeout

Sonnet PASS confirms identity hardening; accepted residual P2 test weakness: removed the nonexistent-binary override from both hygiene and malformed Unicode cases, so valid fixture infrastructure cannot mask a missing identity check. A guard-removal mutation must now fail the test. Strict userinfo rejection includes ssh://git@host; callers must supply a sanitized userinfo-free identifier. Other optional P3 additions remain non-blocking and unchanged.
