# Audit presentation CI repair evidence

PR292 run40666085535 failed the repository knowledge-hygiene test because two raw audit example links were interpreted as links relative to this documentation directory. The same two findings reproduced locally before editing (one test failed). No scanner or exclusion changed.

Four original audit files retain their names and their complete original payloads byte-for-byte inside eight-backtick text fences. These are quoted reports, not navigation instructions. The preservation verifier checks against the original Git objects and also verifies the historical archive and manifest remain unchanged. See the parent audit-presentation.json for offsets, lengths and original/presentation hashes.

After the presentation fix: two governance test files, six tests passed; joint document checks241passed. Original CI failure and local RED/GREEN outputs are retained. This was not a full-suite rerun and did not revise any audit opinion. Commands and log hashes are recorded here; metadata was assembled after execution, without invented timestamps.

Run the nonmutating verifier from any location with Python3 and the original Git commit available: `python3 docs/implementation/osstack-method-entrypoints/presentation-evidence/verify-preservation.py` from the repository root.

Raw command and original CI logs are stored losslessly in `raw-logs.tar.gz`, under its `raw-logs/` member directory. The manifest records each original member hash. This retains original trailing blank lines without treating log bytes as editable prose.
