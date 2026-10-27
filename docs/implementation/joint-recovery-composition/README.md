# Home and broker recovery composition investigation

Base: `3192b424174e5eb977d640cc0418e67c6b1461d1`. Frozen test/spec candidate: `6ea2cebc8420a1f26b7aff820f7997c0cbba61ad`. This is investigation material for JA20/JA47, not formal J01/J11/J17 acceptance or a runtime recovery implementation.

## What changed

The existing home47 catalog and held Attention action are instantiated alongside the separate broker orphan fixture. Required producer edges cover home bootstrap, broker qualification and legacy recovery. Every required edge has a deletion counterexample. Broker manifest dependencies are compared with the real graph; cyclic and acyclic recovery-to-activation dependencies are rejected. Raw contract/catalog artifacts are distinct from formal gate completion.

Receipt tests remove required fields through the actual decoder, distinguish absent values from allowed nulls, and exercise FK-valid live-row association failures through the same illustrative validation-and-write path. SQL and fixtures are unchanged. A raw home SQL bypass control demonstrates why live association remains a host obligation.

## Validation and audit

- Exact candidate targeted: 224 operator + 91 broker tests = 315 passed; 4 protocol tests and 1 document-hygiene test passed. Protocol/core build, core typecheck, scoped Biome, changeset coverage and inventory check passed. Final core full package: 1,301 passed, 0 skipped, 0 failed.
- Full build and knowledge export smoke passed at the run start; the full `pnpm test` mixed-working-tree observation completed: 22 packages, 6588 passed, 5 skipped, 0 failed. Raw commands, exits and SHA bindings are in [verification.json](verification.json).
- Actual tool-less Claude CLI `claude-sonnet-5-5`: round 1 REVISE, round 2 PASS, then a small P2 closure round 3 PASS on the final candidate. Full input, raw response and report are losslessly archived; [audit binding](audit-code-binding.json) binds all three review rounds. The reviewer did not execute the tests.
- Independent evidence: original 64 raw/catalog observations on the first candidate are inherited only by verified unchanged fixture bytes. New candidate composition was actually re-executed: 204 passed and 14 pre-existing tests deliberately skipped on 5a2a; final6ea independently re-executed 12 selected tests (212 deliberately skipped) plus 1 manifest positive control. Three legacy acyclic mutations and both graph/manifest missing-edge directions were rejected. The [45-payload final supplement](recovery-independent-6ea-supplement.tar.gz) is separate from the original package; its complete manifest was verified. The previously escaping J17.recovery → J12.scoped deletion now fails with the exact missing-edge diagnostic. All 127 independent payload hashes were verified before copying the [complete independent archive](recovery-independent-evidence.tar.gz), including initial false-negative evidence, later fix and harness errors.

## Confirmed issues and disposition

Round 1 and independent review found that traversal order could conceal a missing prerequisite. Explicit edges and deletion tests now close that gap. The review also identified incomplete home association coverage and potentially vacuous omission assertions; these are replaced by real row perturbations, shared illustrative persistence, preconstructed mutants and Zod-specific failures. See the complete [raw index](raw-index.json), including the original audit and every historical run. The first authoring failure used an incorrect `resolution` SQL column; it was corrected to the actual `disposition`. It is retained as test-author error, not a product defect. Earlier green snapshots are historical and do not replace current evidence. During the full run, core1295 had finished before the final test/doc refinements were written; exact write-time bounds and the diff are retained in full-run-working-tree-caveat.json. The full run is a mixed-working-tree observation, not a fixed5a or final6ea full-suite proof. Final core/targeted/hygiene checks independently bind the final candidate. One later authoring assertion expected a cycle trace prefix that expanded roots legitimately changed; it now checks category and the exact injected edge, with the failed run preserved.

## Remaining limits and next step

The Git comparison from the historical home fixture base `69859eecfcc84af9d6eff755ed41243ca5f51f95` to reviewed main changes only test files under `packages/core/src/state`; migration implementation and source catalog remain identical. O03 is still open: home48 and broker0→1 are unreserved candidates. O06 has a scoped author baseline check only; future main must be checked again. J01.contracts has not formally passed.

Home association examples are bounded to the committed abandoned-unknown Attention fixture. Owner7, tenant, grant, candidate/build and proof inputs are synthetic; they do not establish authority. Effect coverage is structural only. No process-crash, operator authentication, proof provenance, live CAS, cross-database atomicity or completion/release implementation is claimed. Formal oracle custody, exact qualified recovery builds and remaining gate prerequisites are still required. No central acceptance ledger or runtime registration was changed.

## Reproduce and inspect evidence

Use Node22 with explicit scratch `OSSTACK_HOME` and unset outer `OSSTACK_SOCKET`. Build first; retain generated knowledge dist until tests finish. Targeted command: `pnpm --filter @osstack/core exec vitest run src/state/operator-recovery-spec.test.ts src/state/broker-recovery-spec.test.ts`. Full commands/environment are preserved in raw verification records. Each raw payload is gzip-compressed without rewriting its bytes; `raw-index.json` records uncompressed and compressed SHA256. `manifest.json` covers every archive file except this README and the manifest itself. Historical timestamps and paths are provenance, not instructions to access a default DB.
