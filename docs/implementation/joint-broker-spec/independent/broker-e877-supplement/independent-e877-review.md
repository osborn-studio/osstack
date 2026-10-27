# Independent broker e877 supplement

Candidate: e8770e3c8dee5b2e57c5c3ca9a7d551607e1a59c. Prior frozen independent candidate: 812080ae697e82362e74e43df5c67e55c921d38b. Main used for the dependency comparison: d3fa7ef681efc79a5fb2dff92172ef1be0978774.

No confirmed remaining issue in this bounded review. Read the actual owner round3-raw.md and the exact Git candidate diff; both are retained. This supplement does not replace or rewrite the immutable earlier independent archive.

## Exact byte and dependency checks

schema.sql, held-orphan.sql and catalog.json equal both 812080ae and the actually independently tested 858316 SQL candidate byte for byte. Its 35 SQLite observations are inherited for these identical bytes; they were not rerun. The entire manifest equals 812080ae after exactly one metadata change: dependencies.runtime_storage_requires now equals the original main J17.scoped requires array [J14.scoped, J12.scoped, J17.recovery]. Spec, schema_spec_digest, storage and qualification declarations remain unchanged. The freeze helper makes exactly that dependency edit. Actual python3 -I .../freeze.py --check exited 0 on e877. No schema number, live DB, runtime or gate was enabled.

## Review and focused execution of the newly added owner tests

Executed only the 13 new selected tests in broker-recovery-spec.test.ts; Vitest reports 13 passed, 76 skipped, exit 0. These are independently executed implementation-owner tests, not 13 independently authored oracle cases. The full 89 or the original independent 35 were not rerun here. Exact command/environment/source hashes, output and exit are retained.

The round3 P1 coverage requests are addressed in the actual code and this focused run:

- Existing lease identity: each of INSERT, INSERT OR IGNORE, INSERT OR REPLACE, REPLACE, ON CONFLICT DO NOTHING and ON CONFLICT(lease_id) DO UPDATE is exercised with a changed resource key, for both held_orphan and resolved_stopped, with foreign keys ON and OFF. Each must raise a SQLite constraint error; row and decision history remain unchanged. Thus ordinary conflict-ignore success cannot count as a guard rejection.
- Existing-id mutant: the exact lease_id predicate occurs once and is removed alone. The same REPLACE input is rejected on the candidate and admitted on the mutant, including a stopped lease becoming held_orphan/revision zero. This actually tests the terminal resurrection concern rather than inferring it from a new-ID resource conflict.
- Two stop cardinality predicates: duplicate proofs and duplicate proof_refs are separately rejected on the candidate and admitted to resolved_stopped when only the corresponding array-length conjunct is removed.
- Six integer predicates: raw receipt JSON deliberately carries quoted zero/two or decimal 1.0/2.0 so serialization cannot normalize away the bad type. Each exact json_type predicate occurs once; removing only it makes the identical input persist and resolve the lease. The successful mutant rules out a mere syntax-error rejection as proof of coverage.
- NULL generation and immutable broker-id checks run with foreign keys OFF, checking owner/lease/history unchanged. They cover decision owner_generation and lease grant_generation NULL as well as owner update. Redundant lease-update conjuncts are explicitly documented as not independently mutation-killed, rather than overstating exhaustiveness.

The host documentation now requires comparing receipt schema/DDL/fixture/candidate/build digests against the pinned qualified tuple, not merely mutually matching envelope values. Its SQLite-version recording claim correctly points to owner verification evidence; this review does not certify that evidence. Chronology is described as a recorded process claim and principal independence remains unasserted. The shared registry prose correction is parent-owned and outside this broker-only supplement.

## Limits

No new independent principal identity, real containment, file-backed recovery, live operator authorization, process crash, provider execution or runtime qualification is established. SQL was unchanged; this is bounded mutation-test coverage and metadata verification. The model round4 verdict belongs to the owner's separate archive and is not presumed here.

Evidence: byte-metadata-result.json; byte-metadata.command.json/.stdout/.stderr; freeze-check.command.json/.stdout/.stderr; new-focused-cases.command.json/.stdout/.stderr; exact snapshots, candidate.diff and owner round3 review. The original archive SHA256 remains 9c676a17abbb0d0855f6e14235f4ddaad1d64842ddecb49d84f8db5d2db30b95.
