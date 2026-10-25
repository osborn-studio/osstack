# Root component evidence, 2026-10-24

This directory preserves actual local checks and requested Claude Code CLI Haiku 5.5 static reviews. It is not a completed final integrated audit or external-platform qualification.

- Paired rounds 1–3 returned findings; fixed incomplete-subset comparison, API model identity, cache cost, missing spawn evidence, runtime-error fail-stop, wire-hash leakage checks, bounded abort drain, and persistent repeated-signal handlers. Round 4 returned `is_error:true`: OAuth session expired. No final post-fix approval is claimed.
- Viewer rounds 1–2 returned findings; fixed capability exposure using one-use private handoffs, pin ancestor ownership, streaming hashes, stale handoff bounds, exact response identity, and cautious unknown-state wording. Added separate host-approved persisted assistant-text access. Round 3 returned `is_error:true`: OAuth expired. New output-reader code and final corrections still require independent post-fix challenge.
- `unrecognized_model` diagnostics are retained. The requested/reported model string is not weights attestation; these are static CLI reviews, not executed runtime qualification.
- Initial real CLI/daemon tests failed because private-config paths received an OS home alias. Canonical host-home resolution fixed both paths; the second run passed 15 tests. Both logs retained.
- A focused default-5-second test run timed out loading the real provider module under concurrent development load. The same suite with the repository qualification's explicit 20-second test budget passed 34 tests; product call deadlines were not increased. Other targeted runs and failures remain preserved.
- Final source-wide checks, native Loop task receipts and PR CI will be recorded separately after all parallel code is integrated. Prior component checks do not substitute for that final run.
- Real model calls, actual tmux/cmux windows, a live remote SSH host, public GitHub sends and user launchd installations have not been exercised. No user production home was upgraded.
