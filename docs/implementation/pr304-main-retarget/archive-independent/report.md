# PR304 retarget archive independent check

PASS within archive consistency scope. All 375 payload files (25,001,395 bytes) match the internal manifest by SHA-256, byte length and mode; no extra/duplicate or unsafe members. Archive and manifest hashes match the published receipt.

Raw Sonnet response is static PASS, exact report text and prompt/response/modelUsage bindings match. Actual default2/full5 raw commands and journey rows confirm product exits 0/1 and 0/1/2/1/0, all driver exits zero. Default projection/check succeeds; full projection returns fixed_case_set, with recorded absent-output assertion and unchanged 75/183 retained members. Focused logs support 43+49+94+14 tests, 241 docs and 1 hygiene. Initial Python parse failure remains archived.

Read-only Git checks confirm both tree equalities, main ancestor of 7ef051ff, exact 18-path binary diff equality, all six supplied source hashes and the filtered audit diff. README is consistent with these records. No confirmed issue.

This review did not rerun tests/models, query live CI/PR or attest producer identity. Historic no-output/cleanup are retained observations, not reconstructed live absence; CI pending language is historical and does not report current status.
