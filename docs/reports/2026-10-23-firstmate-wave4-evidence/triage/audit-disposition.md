# C bounded triage audit disposition

Requested CLI model: `claude-haiku-5-5`. Three raw contexts/results/stderr files are retained here. CLI stderr reports `unrecognized_model`; the model's actual underlying identity is not independently attested. Final static verdict: no confirmed P0/P1; six P2 boundary/design observations. No live-provider qualification was established: smoke returned `not_authenticated`, without changing credentials or provider.

## Fixed during challenge

- Added run/session/agent relational binding to avoid sending polluted cross-source snapshots.
- Added real SDK public spawn hook, fixed actual child env, observed native child exit, TERM/KILL fallback and cancellation check before delayed spawn. Promise settlement alone is insufficient; unconfirmed exit holds the ledger slot.
- Added bounded provider preflight, one pending initializer, stop cancellation, initialization retry after rejection, not-started reservation cleanup and distinct auth-routing failure.
- Bounded full prompt and retained output; required exact reported runtime model/init capabilities and usage. Invalid JSON never installs advice; valid outer usage survives JSON rejection.
- Added wall-clock rollback fail-closed budget, actual reservation wall deadline and same-process monotonic deadline, plus overall service deadline. Late result cannot become cached success.
- Fixed all scoped Biome diagnostics and preserved original pre-spawn errors.

## Final P2 review

1. Ledger finish trusts its host caller's completion lifecycle. Accurate boundary: this is internal DB authority, never caller RPC data; root must instantiate only the fixed provider. There is no external stopped boolean, no recovery reset RPC, and no automatic old-owner release. A cryptographic/host stop-receipt API for cross-process recovery remains pending; current service tests confirm no release on unconfirmed child stop. Do not expose ledger finish as a general RPC.
2. SDK args are supplied by the pinned version/executable, while actual command/cwd/environment and requested SDK policy are host-fixed. Upgrade qualification and immutable dependency trust remain requirements. The guide claims only those fixed spawn properties and init self-report, not an OS sandbox against compromised SDK/same-UID processes. No arbitrary user args enter this interface.
3. Per-scope five/hour plus global concurrency one matches this slice's specification. A global hourly spend cap is not implemented; the existing 100-scope registration cap is real. No claim of global five/hour is made. Aggregate financial policy is a separate enhancement.
4. Permanently hung initialization intentionally blocks further initialization; otherwise retries accumulate orphan operations. Status exposes provider_initialization_pending; stop/restart is required. No model was invoked and no budget was consumed in this state.
5. reported_model is explicitly local init self-report, not independent model-weight attestation. Its equality check prevents observed fallback models, not a lying backend. Guide and smoke evidence preserve this qualification limit.
6. Existing ControlledSessionAdapter child-exit behavior is outside this change (only helper exports changed). Forwarded to parent as a separate runtime-hardening observation, not silently represented as fixed by triage.

## Validation

Final focused tests: ledger 13; CLI 15; controlled provider 9 plus existing controlled-session 22 = 31. Existing DB 24 and graph-lineage 30 regressions passed before the final ledger/provider-only deadline refinements. Core and agents build; agents and CLI typecheck; scoped Biome and git diff --check pass. Exact source hashes are in source-manifest.json; final-command-results.json records final typecheck/Biome exit codes. Raw logs retained.

Parent owns central daemon/config/RPC/stop wiring and full integration checks. This delivery alone does not claim the production command is wired. No migration above 43 is modified.
