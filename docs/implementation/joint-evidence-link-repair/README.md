# PR282 CI evidence-bundle repair

CI run40497961466 at head6929cb4d failed the existing governance documentation check:19 relative links in four copied terminal reports had no adjacent target. The owner reproduced that failure in an isolated worktree. The earlier local hygiene check ran before final checkpoint copying, so it did not cover the published document tree.

The repair adds139 missing files from fixed source commit fd14a6be1ced7b7b257b0b095023bd9f4fddd8da, completing the original37-file bundle in each of four historical snapshots. Each directory also retains its own pre-existing code-to-head diff. These are FOUR COPIES OF ONE VALIDATION RUN, not four independent test runs. No original report, audit binding, ledger or runtime source is rewritten.

The repair script verifies all original tracked bytes, each compressed/raw manifest hash, exact bundle file closure, inline relative links, code identity and6276/5/0 plus90-focused counts. The source count comparison only checks archive consistency; it does not rerun those historical tests.

New validation: governance301 tests passed, checkpoint128 tests passed. The final staged documentation check and checkpoint test are recorded in the final logs. Full current-head GitHub CI must still pass; this local documentation repair is not a new full runtime validation or a changed runtime qualification.

Claude CLI actually used claude-sonnet-5-5 twice. Both rounds returned PASS; raw opinions are preserved. Named P2 follow-ups added idempotent writes, measured provenance/count checks and relative-target checks. After closure review, an explicit four-bundle guard and clearer byte-equality result replaced the cosmetic count proxy. The inline-link checker is deliberately scoped to these fixed reports, not a general Markdown validator; the repository hygiene test remains authoritative.

Operating rules now require copying complete attachment bundles and running hygiene/checkpoint checks after the final evidence tree is staged. User approval and merge remain separate.
