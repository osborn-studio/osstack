# Candidate validation and limitations

Code candidate: `4f6c3c8fd21778798bdf22c12c0f4adfda28807a`; base main `64b203c32d245d5ad9a76914253ca18cbb54a073`.

- Fresh frozen install/build passed; generated knowledge/dist changes were kept during execution and are not product changes.
- Initial candidate a0be527a: 21 focused tests passed. Independent execution and actual Claude Sonnet5.5 review both found the symlink-entry silent success defect. Original observations retained.
- Required review findings R1–R3 were repaired: actual entry canonicalization, allocation/cleanup ownership, and string-valued interrupt failure. 25 focused tests and the complete `pnpm smoke:skills-check` command passed on the revised script.
- Actual Sonnet5.5 limited closure PASS; it reviewed supplied source/diff and did not execute tests. Original REVISE and optional hardening suggestions remain preserved.
- Independent replay used the original failing `/Users/...` entry; five real cases returned product exits 0/1/2/1/0, with retained evidence and cleanup. Read-only preflight, invalid/existing target refusal, missing build rejection, bad-output mutant and exit-only mutant all passed their checks. The exit-only mutant preserved real output and changed only exit1→0; the sole behavioral error was `exit_mismatch`.
- One full package regression completed 7,138 passed, 5 skipped, exit0. It started at a0be527a; while package suites ran, only standalone scripts/design docs were revised. Package source remained unchanged; this is not relabeled as a final whole-tree run. Revised script-specific checks and later published-head CI are separate.
- 241 existing document checks passed before final evidence additions. Repository Biome ignores these `.mjs` paths; its no-files-processed attempt is preserved as not applicable, not a pass. Three node syntax checks passed.

All cases use local file Git sources. No live provider, autonomous host executor, authenticated oracle or J01/J11 gate has passed. Source/build digests bind observed files, not independent build provenance. Normal direct child exits and fixture absence were observed; descendant termination is not globally attested. The 90-second budget covers the subprocess sequence, not unbounded filesystem operations. Parent interpretation requires a parseable matching receipt, expected cases, evidence hashes and observed cleanup, not merely process exit0.

Optional audit hardening was not represented as completed: exhaustive exact stdout comparison, absolute PATH normalization, separate before/after full lists, failure artifact upload from CI, and additional timeout/interrupt integration coverage. Retained evidence directories are intentionally durable; callers may remove their own evidence after exporting required records. Never clean the entire shared scratch root to reclaim one run.

Archives: `code-evidence.tar.gz` (434 records plus manifest), `host-use-evidence.tar.gz` (276 records plus manifest), and `final-checks.tar.gz`. Adjacent SHA-256 files anchor each archive. [Original review](audit-original.md), [required closure](audit-closure.md), [host experiment](host-use.md), [host criteria results](host-assessment.json).
