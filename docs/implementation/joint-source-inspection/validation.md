# J02a validation

Code candidate: `32bd1bd287a7125fcc71c7312392ec5a3af2413b`. Final checks ended at `2026-10-27T07:24:09.550326+00:00`. No product code changed after the final Sonnet input or during this final verification sequence. Documentation/evidence commits follow separately.

- Full `pnpm build`, workspace typecheck, `pnpm lint`, inventory check and `pnpm test`: exit 0. Lint retains existing warnings; it is not warning-free.
- 22 package suites: **6161 passed, 5 conditionally skipped, 0 failed**. Counts and exact logs: evidence/test-summary.json and final-tests.log.gz.
- skill-registry: 31 tests (28 new inspection cases plus 3 manifest tests); protocol: 455 tests.
- CLI startup: version49ms/help123ms, below150ms/500ms budgets. Changeset coverage passed for both affected public packages.
- Python independently recomputes both source digests on SHA-1 and SHA-256 Git fixtures, including non-ASCII names. This is separate from the implementation's TypeScript encoder.
- Real upstream pins: pstack99b609a7, full pstack subtree200 files /4,007,689 bytes; Firstmateaf1c6817 harness-adapters scope21 files /142,640 bytes. Replayed with expected content digests. Dependency resolution remains not_performed.
- Sonnet5.5 final complete static review: PASS, no concrete P0/P1/P2; code hashes match audit-code-binding.json. Non-blocking P3 notes and original findings are preserved. Model output did not execute tests and is not runtime qualification.

## Failed and intermediate attempts

Initial test collection lacked built workspace dependencies; after building them, the missing implementation failed as expected. The first implementation test fixture forgot to await createScratchDir; the test harness was corrected. New domains initially triggered UNKNOWN_JOINT_DIGEST_DOMAIN and were explicitly registered with the catalog. The first full suite stopped at a corruption-test setup EACCES because Git loose objects are read-only; the disposable fixture now replaces its own loose object before injection. A macOS Unicode collision test initially normalized both names through Git; core.precomposeunicode=false makes the intended two distinct raw names explicit. These failed attempts are not counted as final passes.

Earlier broad runs and focused tests predate later audit corrections and are not used as the final-candidate claim. The final verification JSON binds the complete successful sequence above to the final code commit. Historical failed logs and all model inputs/outputs remain in evidence.

## Limits

No merged/deployed/default-enabled claim. No J02b dependency closure, behavior mapping completion, method registry admission, J12 recovery, complete J09 method journey, provider fault, process-tree containment, remote host, malicious same-UID or physical durability qualification. The Git binary/object store is trusted; the30s budget is subprocess scheduling, not a proof against kernel/filesystem hangs. PR CI remains a separate observation.
