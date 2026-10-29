# Bounded material delivery for existing host workflows

The prior Claude exporter repair completed the actual RED/fix/GREEN loop, but read only 60 of 64 evidence-reference lines. This slice adds a readonly checkout script that makes the remaining range explicit and requires the first page's full-file digest on later pages. It updates host usage with complete-page continuation and literal command guidance, and bug-fix instructions with behavior-test RED before source edits and the same controlled test/inputs for GREEN; the method count remains fourteen.

`node scripts/read-method-material.mjs --file PATH` returns a bounded JSON page with source hash, content-line count, original selected text, EOF and next start. Continue with `--start NEXT --sha256 FIRST_HASH`. If a supplied digest no longer matches the current bytes, the request fails before any page text is emitted. Terminal symlinks, nonregular files, invalid UTF8 and size/range violations fail explicitly. The helper writes no files and uses no daemon, credentials or network. It runs with the invoking user’s OS permissions, has no path allowlist and does not apply host file-tool read policies. Task authorization still limits which files may be requested.

The helper is a source-checkout script, not an installed host command or part of the exported skill payload. Raw page generation does not establish model-visible delivery, reading, understanding, native discovery or formal runtime qualification. Host tool output can still be truncated. Parent paths resolve normally; this helper is not an OS sandbox or a concurrent-writer fence.

Authors worked in separate boundaries: reader+tests; two existing references; independent test fixtures. Root owns package/CI wiring, ledger, full regression, audit and PR. All original failure records and the previous LIMITED trial remain unchanged. No model-host experiment is rerun here.

## Validation

Validation completed on the stated snapshots; published-head CI remains a separate check. A's initial missing-module/reader REDs are new-feature TDD preparation, not a reproduced historical reader defect. Independent criteria were frozen before that verifier inspected the candidate, not before the author began implementation.


- Reader plus export contracts: 108/108 passed (14 reader, 94 exporter). After the audit permission-wording correction, 94/94 exporter checks passed again.
- Independent MR validation: 233 real commands, including 231 reader calls and two exports. Both host exports contained 88 payload files; paging reassembled every file to its original bytes. This is tool verification, not host model consumption.
- Full package regression: 7,144 passed, 5 skipped, zero failed across 22 packages. Started at `14853ad61ebb396141a10f69a614cb59f27fa19b` on Node 22.22.1 with four fresh generated knowledge/dist files retained and unchanged hashes. During the run root added ledger/report records and committed one host-usage permission sentence at `969da2df`; package source trees did not change. This is not an immutable final whole-tree run.
- First actual Claude CLI `claude-sonnet-5-5` audit: REVISE. B1 confirmed that the helper does not inherit host Read-tool allow/deny rules; that false guarantee was removed. B2 requested this finished validation record and a precise description of the bug-fix instruction change. The second actual audit returned limited PASS for B1/B2 textual closure; it did not rerun runtime behavior. No new host experiment was performed.

Retained failures include author TDD preparation, two independent harness errors (syntax and log-name collision), and root's mistyped `test:methods-export` script name. The valid root script is `test:method-export`; these are not product defects. The first audit and all optional suggestions remain unedited. Independent review also corrected its initial overbroad permission-wording assessment. Optional stat precision, metadata ordering, portability and injected filesystem failure coverage remain future improvements; no support for Windows or permission isolation is established here.

Archive: `evidence/raw-verification.tar.gz`, SHA256 `a1b6273be4017a4966e9c5403a2a478335f00c6900d8a161d7a415a461151467`; 1,421 members and 8,410,216 file bytes verified against manifest hashes, lengths and modes. Original logs, both actual audit prompts/responses/bindings, all initial failures and frozen criteria are retained. Final source bindings are in the archive.
