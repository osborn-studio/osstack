# Session start cleanup retarget validation

PR #278 is validated against main `8fed83136611948ee068801ab5cc1fd471f90078`.
Product code: `39c5df28cea120630f39a8267235c2f7ff5985b4`. Later documentation commits do not replace this code binding.

Local full validation: **6214 passed, 5 skipped, 0 failed**, across 22 packages.
Build, strict typecheck, lint and inventory check passed. Exact commands, times and log hashes are in the archived verification JSON.
Claude CLI actually used `claude-sonnet-5-5`; final static verdict PASS. Raw prompts, JSON responses, earlier objections and host dispositions are retained.
Independent subagent tests supplement the full suite. They do not replace GitHub CI, human approval, real provider qualification or runtime acceptance.

The original retarget patch was byte-identical to the former stacked patch. Audit corrections are described in dispositions.md.
Archive manifest hashes cover the stored files and original uncompressed bytes. Gzip files are preserved execution inputs/outputs, not runtime inputs.
GitHub current-head status is observed separately in the joint execution ledger. The owner gilberthello approves and merges.
