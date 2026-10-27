# JP-17a broker offline specification evidence

Base `d3fa7ef681efc79a5fb2dff92172ef1be0978774`; frozen source/test/document candidate `bc25b1cf1889f89178f29a309d7b8c6191d01d40`. This archive is an additive evidence commit; it does not change that tested candidate.

The candidate chooses a proposed dedicated SQLite namespace, with an unreserved 0→1 schema and executable held-orphan fixture. It does not register a runtime broker, allocate a deployed schema, open production state or satisfy J11/J17 gates.

## Verification

- Full `pnpm test` at earlier `812080ae697e82362e74e43df5c67e55c921d38b`: 22 packages, 6369 passed, 5 skipped, 0 failed. This full run was not rerun or rebound to the final snapshot. Final complete core suite at `bc25b1cf1889f89178f29a309d7b8c6191d01d40`: 1091 passed, 0 skipped, 0 failed. Raw output is `validation/test-full.log.gz`; exact commands, times, exit codes and hashes are in `full-8120-verification.json` and `verification.json`. The final delta changes only test coverage, freeze-helper capability checks, metadata declarations and documentation; SQL/fixture/catalog/spec digest and runtime product source remain unchanged. The parent explicitly authorized affected validation for this delta. The intermediate e877 core1089 result is separately retained in e877-verification.json; final-closure.diff captures the exact e877-to-final changes.
- Build passed on812080. Final core typecheck, lint, inventory, changeset coverage, freeze check and documentation hygiene passed. Lint exits0 with21 existing warnings, unchanged from earlier candidate. Focused tests: 91 broker plus 14 home cases. Thirty-five mutation instances execute single-predicate SQLite mutants and confirm the same rejected input is wrongly admitted when that predicate is removed. This is bounded mutation coverage, not exhaustive SQL proof.
- Real Claude CLI `claude-sonnet-5-5`, tool-less review: round4 full review PASS on e877; round5 small-delta closure PASS on the final candidate. Complete earlier REVISE opinions, raw inputs/responses, final source hashes and dispositions remain in `audit/` and `audit-code-binding.json`.
- Independently selected SQLite checks: 35 cases on858316, followed by exact Git-byte equivalence for c454,812080 ande877. They were not rerun on later equivalent SQL. The independent agent also reran the 13 new author-written tests on e877 (13 passed,76 skipped), with raw command logs; final bc25 received only a read-only byte/metadata check, not another independent SQL or freeze execution; this is independent execution, not independently authored cases. This is process-role separation, not authenticated principal qualification.

## Confirmed finding and remaining boundaries

The initial candidate allowed `INSERT OR REPLACE` to evict an existing held resource when recursive triggers were disabled. A BEFORE INSERT occupied-resource guard fixes it. The original failed counterexamples, independent SQL traces and repaired results remain in `historical/` and `independent/`. Later audits led to precise SQLite exception assertions, strict-protocol composition tests, byte-exact freeze, oracle retention and isolated predicate tests.

Future runtime work still owns current-authority verification, proof provenance, canonical input and strict parsing, idempotent replay lookup, file-backed WAL/crash behavior, old-writer fencing, physical invocation containment and real deployment registration. SQL receipts are synthetic structural fixtures. See the specification at `docs/design/broker-recovery-schema.md`.

`manifest.json` hashes every archive file except itself and this README, with compressed and original byte hashes. Decompress `.gz` files losslessly. Historical partial/failed checks remain labelled in `history.json`; only final command records support final results.
