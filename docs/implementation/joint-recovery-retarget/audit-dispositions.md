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
