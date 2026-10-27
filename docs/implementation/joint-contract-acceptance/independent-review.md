# JP-01c independent bounded review

Candidate `74ec436d28f3f134451d45e35536c5747a7f1cba`; base `3192b424174e5eb977d640cc0418e67c6b1461d1`. No confirmed candidate defect in this bounded review.

## Actual evidence

- Reviewer criteria were byte-recorded before reading the four candidate assets. The candidate already existed: this is **not** a formal before-candidate oracle and proves no authenticated independent principal.
- **27 independently selected TypeScript tests passed**, including literal canonical bytes/hash for ASCII ordering, escaped ASCII keys, Unicode values/surrogate pairs/control escapes, safe integers, empty nesting vs scalar depth boundaries; strict duplicate/number/key/surrogate/trailing/BOM/UTF-8 rejection; exact 1 MiB/+1 limit; actual expected-kind and self-consistent wrong-task binding rejection.
- The candidate Python implementation passed **25 corresponding raw/canonical/UTF-8/size observations**, under `-I -O` with explicit reviewer checks retained. It is a separate wire/hash implementation, not an independent semantic/schema or authorization implementation. Its direct `canonical` helper is used after strict wire decoding; this review does not grant it a standalone arbitrary-Python-value API contract.
- Independently resolved the published JSON Schema's local `$ref` pointers and matched all **32** matrix rows to an applicable branch's exact required/optional fields. Recomputed each fixed sample's canonical SHA-256. The `oracle_lifecycle` sample covers its executed branch, not every lifecycle state; the matrix is explicitly top-level structural coverage, not nested semantic completeness.
- **46 selected candidate tests passed**: wrong expected-kind across 32 kinds and 14 binding/proposal/role identity substitutions. Did not rerun the author's entire 547-test batch or repository suite.
- Two actual source mutants were constructed only in scratch: removal of both expected-kind guards; removal only of binding.task_id versus proposal.task_id comparison. The unchanged candidate tests killed them (32 wrong-kind failures and one identity failure). Independently chosen inputs also killed each mutant (one failure each after a valid positive control). Failures are assertion failures because invalid inputs were accepted, not setup, syntax, import or unsupported-type errors.

## Fixed expectations and applicability

The JSON fixture carries literal expected bytes/hashes and each component hash; the candidate test also pins the whole fixture byte hash. The Python checker computes comparisons without importing/executing TypeScript product output. This prevents expectations changing merely because the code under test changed. It does not prove historically independent authorship: metadata explicitly says same author, baseline role/subject constants retained, post-audit revisions. This review did not inspect an earlier authoring environment and cannot authenticate how every historical expected constant was first chosen.

Metadata correctly limits cross-record association coverage to binding/proposal/recipe and roles to binding/recipe; context_receipt/gate_evidence/other records do not claim their external joins are verified. Source-content/source-inspection helper behavior is explicitly left to J02; their domain primitive is covered here. Tests do not convert structural success into host authorization or a gate result.

## Reproduction and limits

Every runtime source and candidate test input used was exported from the exact Git object into scratch. `candidate-files.json` binds the exported files; source mutants are separate directories. Only dependency resolution uses the worker's existing node_modules. Explicit scratch OSSTACK_HOME and unset socket were used; no OSStack CLI, live provider, product mutation, ledger update or full suite ran.

Original command argv/exit/raw output hashes are retained. Two reviewer harness mistakes are retained and excluded: the first Python invocation used reviewer `assert` under `-O` (corrected to explicit `require`, then rerun); the first schema comparison omitted `$ref` resolution and falsely reported oracle_lifecycle mismatch (corrected to actual reference resolution, then all32 matched). Neither was a candidate defect.

Formal JA59/JA70/J01.contracts status remains unchanged. Root may archive this as technical regression evidence, not a qualification certificate.
