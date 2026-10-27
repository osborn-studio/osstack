# Independent bc25 small-diff supplement

Reviewed exact e8770e3c8dee5b2e57c5c3ca9a7d551607e1a59c → bc25b1cf1889f89178f29a309d7b8c6191d01d40 Git diff. No confirmed issue in this limited delta; no qualification expansion.

Recorded Git-byte check exited 0. SQL, held-orphan fixture and catalog are identical to both e877 and independently tested 858316. The complete manifest is identical after replacing only oracle_prefreeze.frozen_at with the exact original oracle string 2026-10-27T16:16:01.175077+00:00; original oracle bytes remain exact. Spec, schema_spec_digest, storage, qualification and dependency arrays are unchanged. Exactly the four expected fixture-helper/manifest/test/document files changed.

Read-only review: freeze.py now requires SQLite 3.38+ and probes actual JSON functions before executing candidate material. The test hashes Buffer bytes for DDL/fixture instead of first decoding strings; the timestamp assertion binds to the unchanged oracle. Two additional owner tests check the TypeScript SQLite capability and malformed JSON's generic SQLITE_ERROR with lease/history preserved. Existing predicate rejection helpers are not weakened. Documentation distinguishes historical grant material from future current-owner-fenced lease admission, and tells the future host to reject all SQLite insertion errors rather than accept non-constraint errors. These changes clarify or strengthen boundaries without introducing a production host or qualification.

Per main owner's narrow instruction, no Vitest or freeze helper was rerun here. The new owner-reported 91/core 1091 results are not asserted as independently executed. Original 35 SQL observations continue only through exact SQL-byte inheritance; e877's executed 13 cases and freeze check remain tied to e877. This report is not a new model verdict, gate pass, authenticated independent identity or runtime proof.

Evidence: byte-metadata-result.json and recorded command/stdout/stderr, candidate.diff and exact four changed-file snapshots. The 9c676a17... full archive and 190ae1b1... e877 supplement were rehashed unchanged; neither was overwritten. Future changed candidate bytes require another bounded comparison.
