# Sonnet 5.5 retarget audit dispositions

Original round 1 report remains unchanged in evidence; model severity is advisory. Host dispositions:

1. Re-frozen manifest on explicit reviewed base 69859eec; full source catalog matched already (initial 13 tests passed), so the stale original provenance was not a demonstrated P0/schema corruption. New SQL guards change target catalog/DDL digests and the independent Python schema vector. Test pins base. freeze.mjs now accepts an explicit full SHA and rejects differing migration/db source against that ancestor; build before freezing is required.
2. Terminal sealing was already correct (the report acknowledges this), and broker receipts are already rejected. Accepted defense-in-depth phase/decision matrix checks in SQL. New 40-combination test exercises every local phase/resolution/decision, including invalid/broker phases. This is not proof authorization.
3. Added internal home equality and types in SQL; negative + guard-removal mutant checks added. Actual serving-home identity remains host responsibility; equality of two claims is not authority.
4. Clarified journal ordering-only scope. J12 must authenticate evidence and bind exact ledger revisions/current hold clearance before verified/installed transitions. Empty JSON in storage tests is explicitly inadmissible as J12 runtime evidence.
5. Duplicate BEFORE INSERT guard intentionally prevents IGNORE/REPLACE/upsert bypass and is tested with recursive triggers OFF. No redundant-removal fix is appropriate.
6. Not a storage defect: (principal_ref,request_id) is already the primary lookup key and input_digest stores conflict identity. Replay/conflict and current authority are J12 host behavior; historical receipts need not match a new owner generation. No fake runtime replay implementation added to J11.
7. Added valid different-home envelope/proof pair rejection through subject/content join.
8. Explicitly set dispatch_committed in containment tests. Original fixture already used dispatch_committed; new test passed before this clarification. Full fixtures supplied in the second review.
9. Matrix now labels all persisted consequences as J12 obligations, not J11 implementation.
10. Explicit base argument replaces mutable origin/main inference (see 1).
11. Existing *.sql and manifest -text attributes cover both SQL files byte-for-byte. Windows runtime support is not claimed by these macOS in-memory checks.
12. Model audit remains an independent advisory static check, separate from host test evidence, GitHub approval and runtime qualification.
13. Documented future active-pointer/goal state transition enforcement as J08/J10/J13 implementation work; structural templates do not install that runtime.
14. Existing CHECK deliberately allows stopped resolution from dispatch_committed or observed. Documented; no evidence supports narrowing observed away. The host's actual transition/containment invariants remain required.

## Round 2

- P1-1: reserved → committed between two preserve/resolve observations is not itself invalid. Added explicit J12 live cross-row continuity/regression obligations; no invented SQL-only phase authority.
- P1-2: accepted clarity fix. SQL tests now explicitly name only Attention phase/decision predicates. Complete proof/cardinality/type and effect identity validation remains mandatory protocol parsing plus trusted join before INSERT; SQL is not a full admission boundary.
- P1-3: report acknowledges the resolution predicate is correct. Clarified 40-combination Attention-only scope; effect identity is separately covered in protocol tests, not claimed by this SQL test.
- P2-1: expanded freeze base comparison to the entire state implementation (including DDL helpers, excluding tests), force-build core before dynamically importing its runner. This closes the real stale-build/helper-source gap.
- P2-2/P3-1: explicitly document bootstrap raw DDL, fixture and future template pins and the template's exclusion from schema_spec_digest.
- P2-3: explicitly name recoveryRequestInputDigest replay/conflict and authority-change cases in J12 acceptance; no fake runtime implementation solely to satisfy a test-local suggestion.
- P2-4: already ordering-only, as the audit acknowledges. Arbitrary JSON keys would not authenticate hold clearance; J12's typed/current evidence gate remains mandatory.
- P3-2/P3-3: cosmetic/trusted-fixture suggestions do not change correctness; no unrelated reformat.

## Round 3

- P2-1/P2-2: documented why authority/current source joins intentionally belong to J12's fenced state-owner transaction. daemon_owner alone is not exclusive recovery ownership. Canonical subject digest does not authenticate an Attention tuple; J12 must load and match mission/action/message facts and cannot create an alternate tuple to bypass sealing. No misleading SQL-only ownership guarantee added.
- P2-3: fixed test illustration to populate DDL/fixture/target-schema/candidate from the pinned manifest; added five mismatch cases before persistence. This is fixture-spec admission, not candidate build/provider qualification. J12 obligations now name these fields explicitly.
- P2-4: renamed mutation test to accurately describe comparison-oracle sensitivity. First test separately proves actual bootstrap original-row/catalog preservation.
- P3-1: clarified implicit PK/UNIQUE indexes and future J12 statement allowlist.
- P3-2: tests cover default recursive-triggers-OFF conflict behavior. ON variant is not claimed; BEFORE INSERT abort remains independent of delete-trigger settings.
- P3-3/P3-4: cross-row live phase and exclusive maintenance operation requirements remain explicit J12 obligations.
- P3-5/P3-6: force-build protocol as well as core before dynamic imports; clarify catalog scope and base-label versus build provenance.

## Round 4 closeout

- P1-1: explicit terminal-sealing condition and same-subject forged-digest rejection added to the illustrative verifier-to-storage test. The shared parser already rejected this; J11 now pins that obligation at its consumer boundary.
- P1-2: explicit SQL duplicate/conflict equivalence assertion plus stored input-digest lookup; doc requires host lookup/comparison rather than interpreting SQL errors as replay semantics.
- P2-1/P2-2: named exact completion provenance for abandoned_unknown and in-memory rollback test scope.
- P2-3: freeze rejects untracked non-test state source files before compilation. Modified tracked implementations already fail the base diff. This developer guard remains a source/catalog check, not a hermetic build attestation.
- P2-4/P3: confirmed intended pins/transitions and documented future owner serialization; no new production features.

## Round 5 closeout

- P2-1: all freeze Git/build calls now use the repository root derived from the script path, validated against Git's actual top level. Relative caller cwd cannot vacuously bypass pathspec guards. Untracked scanning includes ignored files as well as ordinary untracked state sources.
- P2-2: corrected illustrative candidate identity: it is an explicit synthetic trusted-build input deliberately distinct from manifest.base_commit; J12 authenticates the real build/candidate. MigrationSpec equality covers DDL/fixture/target-schema/schema-spec only. The negative candidate case now checks the independent trusted input.
- P3-1: SQL's forged-digest limitation remains explicit and the required verifier rejection is tested; adding an acceptance-of-forgery test is not necessary for this spec boundary.
