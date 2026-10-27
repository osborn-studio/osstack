# JP-01c component regression — delivery

Base: `3192b424174e5eb977d640cc0418e67c6b1461d1` (#284 merged); initial candidate `e5e5b2980175258ca2f9d1742488f8a3dd35b0d6`; final code candidate `74ec436d28f3f134451d45e35536c5747a7f1cba`. Branch `codex/joint-contract-acceptance`. Four test assets only; product, reference-vectors, central gates and ledger unchanged.

## Scope and evidence

- JA59 regression: 20 registered domains × 20 legal raw JSON inputs, 43 malformed raw inputs (including duplicate keys, noncanonical numbers, Unicode surrogates and invalid UTF-8); 18 helper projections. Existing reference vectors are not rewritten. Source-content/source-inspection have generic domain hashing coverage; their J02 producer/adoption qualification is explicitly out of scope.
- JA70 regression: all 32 current union kinds, including 10 material bodies; 323 top-level required-field deletions, 10 optional/conditional entries (nine field removals and one existing-absence positive control) plus valid alternate-state controls; unknown fields, invalid kind/version, duplicate raw keys, wrong expected kind. Linked Binding/Proposal/Recipe identity substitutions (8) and all three roles × two role digest fields (6) use recomputed self-digests so structural self-integrity cannot mask missing association checks.
- Python is a separate standard-library implementation of strict wire parsing/canonicalization/digest projection. It does NOT duplicate Zod semantic validation. Python and TypeScript canonical bytes/hash are compared for all 32 valid component samples.
- Typed identity strings in fixtures are synthetic test inputs; schema acceptance is not authentication or host authority. Nested union state combinations and every external association consumer are not exhaustive.

## Validation

`validation.json` binds exact candidate, argv, start times, exit codes and stdout/stderr digests. 547 targeted tests and all 1,012 protocol tests (21 files) pass; protocol typecheck passes; Python `-I -O` passes; diff check passes. No full monorepo test was run by this agent; root owns the serial full-suite result attribution.

`mutation-results.json` records an unchanged positive control (535 new tests pass, 12 existing tests intentionally skipped by JA59/JA70 filter) and 20 isolated source mutations. Initial five checks include: skip expected-kind (32 failures), skip binding identity (8), skip role association (6), drop duplicate detection (35), drop domain separator (60). Actual failed test names and mutant source digests are retained. No mutation touches repository product files.

`mutation-attempt1` preserves initial harness failures: Vite could not resolve an external setup path, so 0 tests executed. Moving a copy of setup and its scratch helper into each isolated clone fixed the harness. `mutation-attempt2` preserves the first successful run before final import-only cleanup; mutation-v1-final retains the original committed-candidate run, final expanded mutations are rebound to 74ec436d. Initial fixture preparation also encountered a `$ref` resolution error before freeze; it was corrected before any candidate assertion or frozen expectation record.

## Gate disposition

`prefreeze.json` and explicit post-audit revisions `prefreeze-v2.json`/`prefreeze-v3.json` record UTC, fixture hash and identity limitations before candidate assertions. Expected wire outputs were authored from normative canonical rules, not sampled from TypeScript outputs. Inputs/schema required-field lists were selected from published base artifacts. The same model session authored test code and expectations; no independently authenticated author/custodian/reviewer principal exists. Therefore this artifact is component regression evidence only, not a qualified independent oracle.

`baseline-gates.json` captures exact base source hashes and O06/J01.contracts/JA59/JA70 records. O06 remains globally open; this task only rechecks the specified baseline and existing protocol APIs. J01.contracts remains `specified_not_run`; JA59/JA70 are not formally signed off. Formal qualification still requires the authoritative independent-principal/freeze custody/reviewer arrangement, complete gate binding identity tuple, reviewed applicable observation/error matrix and original traces on that exact candidate. JA01/JA02 real-host obligations remain separate and unchanged.

## Proposed PR paragraph

Expand protocol component regression coverage with a frozen strict-wire corpus, a separate Python canonical/digest implementation and a 32-kind decoder matrix. Verify malformed raw JSON rejection, digest domain separation, required fields and Binding/Proposal/Recipe associations; 20 isolated source mutations demonstrate the new assertions detect disabled safeguards. This changes test assets only and does not grant J01.contracts or host qualification.

Validation: 547 targeted tests, 1,012 complete protocol tests, protocol typecheck, optimized Python oracle, 20 mutation controls; actual Sonnet 5.5 round2 PASS for bounded component regression. Parent owns full-suite validation and combined ledger PR.

## Audit repair history

Actual Sonnet 5.5 round1 returned REVISE. Raw review and response retained under audit-round1. Confirmed gaps were fixed in 74ec436d: fixed component canonical hashes and fixture pin, honest applicability metadata, optional/conditional controls, sorting adversaries, and new Python corruption controls. Full finding dispositions are in audit-disposition.md. Expanded raw boundaries and mutation safeguards are documented there. The v2 declared-order assertion failed on a one-item fixture; the failure is preserved in revised-tests-attempt1.log, and v3 adds a second fixed requirement before the corrected test. This was a test-input defect, not a product bug. Round2 actual result is PASS for bounded component regression (exit 0, is_error false, canonical model claude-sonnet-5-5); full original report and ten non-blocking residual dispositions are retained.

Independent reviewer additionally passed 27 TS / 25 Python observations, resolved all 32 schema field sets and canonical hashes, passed 46 selected author tests and killed two targeted mutants with both author and independently selected inputs. Its own criteria were recorded after the candidate existed; it explicitly denies formal before-candidate oracle and principal authentication. Package integrity verified before archival.
