# Graph retained verification closeout — 2026-09-21

Status: proposed repair; G29 remains incomplete (29/30). This report does not authorize installation or claim the production canary passed.

## Observed failure

PR #227 was independently approved, merged as `45bac9abdb0841c4372d29a85904faae7642f285`, and installed with Graph admission disabled. PR and main CI passed. The subsequent single-repository canary produced seven confirmed actions and a review acceptance. Its tests returned exit 1 because the pilot acceptance fixture used the verification workspace, inside the reserved serving home, as its allowed-path positive control. The guard correctly refused that path.

The filesystem tests lease was acquired at 09:00:09Z with a 60-second TTL. Post-acquisition policy checking took approximately 41 seconds; the 20-second renewal interval started only afterwards. The first renewal missed the original expiry. The stopped tests command had a confirmed outcome, but lease release was retained and no join was produced. Public cancellation recorded cancel_pending, revision 37. One tests admission remains held; all seven original actions and 3,100 accounted tokens are preserved.

## Changes

- Start lease renewal immediately after filesystem acquisition, before the final asynchronous policy check. Await in-flight renewal, assert exact ownership and recheck cancellation before publishing admission. The TTL and renewal cadence stay at 60/20 seconds.
- Assert the returned lease again at the broker boundary before recording durable admission. If no executor started, cleanup releases only the exact acquired ownership; uncertain cleanup stays quarantined and reports both failures.
- Fix the pilot positive control to use an owned temporary directory outside the reserved serving home, while retaining the root and serving-home negative controls. The original production registration and failed evidence remain immutable until the old run is reconciled.
- Add an installed-host maintenance operation for one explicitly bounded recovery shape: v4, epoch 0, generation 1, exactly seven confirmed actions, one retained tests admission, registered ordinary POSIX command with authenticated process-group stop evidence, unchanged candidate and exact original owner. Other graph obligations, unknown actions, changed grants/programs/receipts/workspaces/locks, live owner or a daemon socket block apply.
- Reuse G15 decisions and guarded exact-owner lock release. The action ledger is unchanged. Recovery can only cancel, never mark ready, invent a passing test, produce a join or replay the writer. A lost release acknowledgement can retry only using the original preflight owner and matching durable decision proof.

## Review and validation

The actual Claude CLI model `claude-fable-5-1` reviewed the design and implementation with no mutation tools. Its first implementation review found malformed replacement-token test values; those were replaced with valid UUIDs and a same-token/different-expiry case. The proposed blanket SQLite readonly transaction failure was disproved with the installed better-sqlite3 dependency and an isolated read-only database; existing G15 immediate transactions remain intact. The maintenance fixture initially supplied the run directory as its home and was corrected.

Read-only preflight opens the control-plane database read-only and does not alter actions, decisions or locks. Existing artifact verification temporarily unbundles into its scratch directory and cleans up afterwards. The production evidence envelopes are 10,733 and 9,216 bytes, below the 65,536-byte receipt bound.

The second Fable implementation audit returned **APPROVE**. Its optional canonical-root and lock-reappearance guards were added and are receiving a final delta audit. Independent GitHub approval is still required.

Local validation:

- Full workspace build, CLI typecheck, lint and inventory freshness passed.
- Governed execution: 13 passed; broker: 35 passed; existing preparation recovery: 16 passed.
- New stopped-verification recovery: all 15 scenarios passed across the full negative matrix and focused reruns after fixing fixture defects. Positive cancellation and installed maintenance preserve original actions; lost ACK, replacement UUID, changed expiry, disappearance and reappearance are explicitly covered.
- Acceptance fixture: the old command rejects the valid candidate in a serving-home workspace; the corrected command passes it and still rejects the original root-guard defect. Production configuration was not modified.
- The local full run did **not** pass: 3 core tests hit their existing 5-second limits. A focused lower-concurrency run passed 35/36, with one remaining timeout. The broader CLI verification run also hit 22 existing 15-second limits under high host load. These are retained as failed results; per-test deadlines and production budgets were not increased. Final CI must pass on the exact pushed commit before approval/deployment.
- Local startup timing also exceeded budgets under host load; the clean-runner startup gate remains mandatory. No eager command-surface imports were added.

## Deployment gate

After approval and merge, install into a new release prefix without switching the old service. Run the installed read-only preflight, capture the original owner, confirm no other active or queued work, and shut down the old LaunchAgent normally. Apply the installed maintenance operation with the original owner/PID/revision and a fresh consistent backup. Require cancelled, unchanged actions and zero upgrade holds before normal deployment with admission disabled.

Only then update the pilot registration, enable the independent OSStack repository, and run a new bounded artifact-only canary. G29 requires actual passing tests, independent review, completed join and ready status; it is not complete at PR creation, approval, merge or installation.
