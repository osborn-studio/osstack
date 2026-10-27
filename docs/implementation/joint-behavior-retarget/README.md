# Behavior registry retarget validation

PR #282 is validated against main `28d116f3f8c15f64bebb314308adf320d8380b2b`.
Product code: `85e19da85a734fad6f53dc061b5cbcd28e1bbf02`. Later documentation commits do not replace this code binding.

Local full validation: **6269 passed, 5 skipped, 0 failed**, across 22 packages.
Build, strict typecheck, lint and inventory check passed. Exact commands, times and log hashes are in the archived verification JSON.
Claude CLI actually used `claude-sonnet-5-5`; final static verdict PASS. Raw prompts, JSON responses, earlier objections and host dispositions are retained.
Independent subagent tests supplement the full suite. They do not replace GitHub CI, human approval, real provider qualification or runtime acceptance.

The current patch and exact reviewed base are bound above; prior retarget observations are historical. Audit corrections are described in dispositions.md.
Archive manifest hashes cover the stored files and original uncompressed bytes. Gzip files are preserved execution inputs/outputs, not runtime inputs.
GitHub current-head status is observed separately in the joint execution ledger. The owner gilberthello approves and merges.
