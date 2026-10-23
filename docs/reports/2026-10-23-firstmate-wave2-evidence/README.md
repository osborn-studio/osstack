# Firstmate wave 2 evidence

Components: bounded run-event replay with migration42 and authority echo guards; scoped read-only worker state views; manual and scheduled daily Attention summary. All three are integrated into real daemon/CLI paths in this branch.

Component review evidence is verbatim. Requested Claude Code model is `claude-haiku-5-5`; modelUsage reports that identifier, while stderr includes an unrecognized-model warning. This is a recorded request/response identity, not independent attestation of model weights. Static audits did not execute tests.

Final root targeted run: 124 tests passed across six CLI suites. Earlier attempts are preserved: the new integration fixture first used a scratch symlink instead of the explicitly supported canonical stored repo path, then incorrectly expected encrypted view tokens to remain byte-identical when reissued. The final test checks the bound source semantics, cross-repository rejection, pagination, actual CLI envelope unwrapping and absence of execution/native transcript leakage. Manual daily verifies it leaves seen records unchanged; scheduled daily verifies disabled supervision remains unknown counts.

Run-event component: 80 focused tests passed, fourth audit no P0/P1. Replay never claims immutable retained history: complete=false, caught_up only current visible watermark. The database retains a gap after manual repair. Worker views explicitly exclude unbound runs and Graph; they show metadata, not terminal logs or liveness proof. Daily has bounded asynchronous waits; SQLite synchronous calls cannot be interrupted by a timer.

Full integration qualification and root audit are recorded after completion; component passes alone do not qualify the full PR. PR #238 exact-source final qualification is archived in the adjacent report directory.
