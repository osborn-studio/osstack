# First executable example: engineering decision journey

The repository already supplies `scripts/smoke-engineering-decision.mjs`. It uses the compiled CLI, an independent daemon bundled from the current source, and a deterministic unpaid adapter. Both source and build bytes are recorded; matching digests during a run do not prove that old compiled outputs were rebuilt from the current source. Read the actual script in the candidate before executing it; this file describes the supported journey and does not certify a run.

From the repository root, after dependencies and builds are available:

```sh
node scripts/smoke-engineering-decision.mjs --doctor
node scripts/smoke-engineering-decision.mjs --dry-run
node scripts/smoke-engineering-decision.mjs
```

Use the repository's `pnpm build` when the compiled outputs are missing or stale; building is a separate operation and its success is not a verification result. The script allocates an isolated smoke directory through the OSStack scratch API. Its child environment uses fixture-only HOME, OSSTACK_HOME, credentials, containment root and a short socket, avoiding the default control-plane DB. Set `OSSTACK_SCRATCH_ROOT` to the intended absolute scratch root before the run; do not replace it with the project or volume root.

`--doctor` and `--dry-run` only read prerequisites and report a plan; they do not build, create directories or start a daemon. A failed prerequisite returns failure. Normal execution allocates a separate private evidence directory under the scratch root and reports its path. To choose a destination, pass `--evidence-dir /absolute/path/to/new-directory`; its parent must already exist and the destination must not exist. These options apply to this candidate, not older versions of the script.

## Map of this one journey

| Feature observation | Actual drive | Expected observation |
| --- | --- | --- |
| Adopt and defer a waiting reply | attention watch → engineering adopt → observe → defer → observe | A scope and mission exist; one pending wait is observed before the explicit choice |
| Answer and reconcile | engineering decide → bounded observe → reconcile query_action | Mission reaches completed with `observed_turn`; action receipt is applied |
| Replay and clean shutdown | Same action key replay → invocation log → daemon.drain and health → shutdown | Replay is true, adapter invocation count is one, drain/health holds and active runs are zero, child exits cleanly |

These are observations along one fixture scenario, not complete coverage of cancellation, races or recovery. Inspect the stdout receipt and exit status together. Preserve the command's stdout/stderr outside disposable fixture state, with candidate/build identity and hashes; use only the actual supported retention interface if available. The run deletes owned fixture state on successful cleanup but retains a separate evidence directory. Read `receipt.json`, `run.json`, `observations.ndjson`, `cleanup.json` and `manifest.json` there; recompute each listed SHA-256 before relying on the bundle. On failure, preserve the reported diagnostics and resource disposition. The directory is private engineering evidence, not a publication artifact or authenticated oracle.

## Failures and boundaries

- Missing or stale builds block meaningful execution. They do not prove a product defect.
- A command/startup timeout identifies a failed stage; final application behavior may be unknown. Read the retained diagnostic record and cleanup state before retrying.
- A good application observation followed by unconfirmed/forced/abnormal shutdown is not a clean run. Preserve the observation and cleanup failure separately.
- Never repair a run by killing similarly named user processes or removing unrelated scratch homes.
- `observed_turn` is the measured completion level. This is not task `local_verified`, code delivery or a joint gate pass.
- The script explicitly does not qualify a live provider. Real Codex/Claude adapters, physical power loss, hostile same-user isolation, process-domain termination, nondefault tenant and remote host remain unverified by this journey.

Use the [common evidence record](evidence.md) for each actual run. The owner of the verification script and its map must keep commands aligned in future changes.
