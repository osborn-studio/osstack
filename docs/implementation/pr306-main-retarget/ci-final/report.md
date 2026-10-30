# PR306 final CI read-only verification

Run **40920378111**, attempt1, completed **success**: five jobs success and the paid DeepSeek job skipped. Expected head `958eb72295937b96ee8affc32fa87910bbdde512`; run API base `main` at `e79fc92687c144969ad91242a979d904f2b2acdf`.

**Actual checkout differs in ancestry from API base label:** CI checked out synthetic merge `057f32d4620d71bec8d26a4fe0f074cc9e921855`, parents `b0ea4e7836dd4be640b4f7c140befba73977837d` and `958eb72295937b96ee8affc32fa87910bbdde512` (log lines3718/3721; Git commit API retained). Its tree `356296e4949c15e08a65696f6d7d5ced796a2693` exactly equals head958e. Base b0 and actual main e79 both have tree `31a72ebdb5777ce7d90e54a501bd4ad52083b10e`. Thus tested source tree matches, but the actual checkout is not relabeled as a synthetic e79 merge.

- Exact check/Test: **22 unique packages, 7142 passed /7 skipped /0 failed**. Matrix and standalone suites excluded from this total.
- Exporter **94 total=93 passed+1 skipped** (global Codex home absent, line8455). Maintenance24, projector88, journey43 and reader14 each all pass without skips/failures.
- Actual default journey product exits0/1; actual full journey0/1/2/1/0. Every driver exit0, each fixture recorded removed; full descendant termination remains not_attested.
- Both actual default/full projection and check steps succeed with matching logged packet hashes. Check explicitly reports original_evidence_revalidated=false. No artifact downloaded or independently rehashed.
- New actual `pnpm smoke:skills-map` ran the production runJourney path: consistent/exit0, all five rows match, real product exits0/1/2/1/0 and driver0. Map before/after SHA both `c1ab436209c3857822b74aebadf914761524f9de645177b20f502cac560e96d8`, unchanged=true; receipt_matches_returned=true. Raw record begins line10346. This CI step verifies the correct map; local deliberately wrong-map RED→corrected-map GREEN remains separate local evidence, not a second CI operation.

Read-only interpretation of saved CI output, not independent test reexecution. Numeric maintenance exit0 is in receipt; other command success is supported by successful bash-e steps and result records. Finite scenario agreement does not establish source-review completeness, runtime qualification, authenticated provenance or model understanding. No PR mutation or rerun/cancel performed.

Original complete log retained as lossless gzip and uncompressed bytes: 2,181,963 bytes, SHA256 `c6d31c0368d571938bc2d8b0aad799fc3f05416c6595326b71da07779172f66f`. ANSI stripping only occurred in parser memory. No parser failure occurred. Full run/jobs/PR JSON and Git ancestry bindings retained; poll snapshots remain in scratch.
