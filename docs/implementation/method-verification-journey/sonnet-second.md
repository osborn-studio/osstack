Original audit text (unchanged inside the text fence):

````text
## Verdict: REVISE (narrow: test and wiring items only)

This is a static read. I executed nothing and treat the 24-test and real-pair results as unverified author claims. I found no defect in the verifier or wrapper logic, and F1-F9 are closed in code. The remaining items are one weakened test, one CI-flake risk, and one unrelated diff change.

## F1-F9 closure

| # | Status | Basis |
|---|---|---|
| F1 | Closed | `fixture_origin` pins origin to `pathToFileURL(fixture/origin)`. `environment.json` is now required and compared to `fixtureEnvironment(...)`. `run.commands` labels, records, exit codes, raw hashes and the `command_incomplete` flags are all cross-checked. `git-00`, `git-03` and `git-05` SHAs are reconciled with `git_head` and `current_sha`, and `git-03` must differ from `git-05`. |
| F2 | Closed | The Evidence column comes from `evidence_state` (`sealed`, `unsealed`, `not_created`, `unreadable:*`), and only `sealed` prints a manifest path. A test asserts the failed-doctor map has no manifest link. |
| F3 | Closed | `retainedState` hashes any existing manifest as `{case_id, sha256, verified}` and records shallow `cases/` and `scratch/` listings. A test covers the driver-exit-1 sealed case. |
| F4 | Closed | SIGTERM, then SIGKILL after the grace period, then a bounded 2 s pipe closeout. The record keeps `timed_out`, `interrupted`, `output_limited`, `signals_sent` and `direct_child_exit_confirmed`. Throws map to distinct failures (`*_timeout`, `*_output_limit`, `interrupted`), and the raw files are written before the throw. |
| F5 | Closed, one gap | See N1. |
| F6 | Closed | `scratch_residue` requires `readdir(scratch) == ['smoke']` and an empty `smoke`, with a test. |
| F7 | Closed | A UUID is required, and `product_exit` now comes from `observed.actual_exit`. The all-undefined-IDs test fails at `run_id_required`. |
| F8 | Closed by rewording plus a wider hash set | `scratch.mjs` is added to `tool_files`. The README and the `limitations` array now say the wrapper does not rehash source/build files after closeout. |
| F9 | Closed | Each row carries `journey_status`, and a failed verification with a retained exit shows `reported:N (unverified)`. |

I checked `invokeDriver` for the usual hazards and found none:
- The `escalation` and `done` guards work.
- Timers are cleared in `finish`.
- An async spawn error with no pid finishes immediately.
- If the child has exited but a grandchild holds the pipes, the 2 s closeout still ends the call with `direct_child_exit_confirmed` true.
- An unconfirmed exit stays false and fails the later check conservatively.

The tests for pre-aborted signals, the output cap and spawn errors are absent but not required.

## Blocking items

**B1. The foreign-cleanup test no longer tests `cleanup_ownership`.** This is `scripts/method-verification-journey.test.mjs`, "foreign cleanup path…".
- The test rewrites `cleanup.fixture_path` to `/outside/...` but leaves `expectations.json` and the input origin unchanged.
- `fixture_origin` now fires first, so the path never reaches `cleanup_ownership`.
- The assertion was loosened to `/cleanup_ownership|fixture_origin/`, which hides the change. The ownership predicate, which was an original-audit guard, is now untested.
- Fix: parameterize `evidenceFixture` with a fixture path (for example `scratch/other/skills-check-x`, or `scratch/smoke/not-owned`). Derive the origin, command cwd and environment from it and assert `/cleanup_ownership/` exactly.
- The same loosening pattern appears in the `command_record_required|command_raw_required` and `required_evidence` assertions. Those are fine because each mutation maps to one of the listed checks.

**B2. The "ignored TERM escalates" test can flake on CI, which now gates on it.**
- It uses a 250 ms timeout. If child startup exceeds that on a loaded runner, SIGTERM arrives before the handler is installed.
- The child then dies by SIGTERM, `signals_sent` is `['SIGTERM']`, and both the `signal` and `signals_sent` assertions fail.
- Fix: raise the timeout to at least 2 s (a 50 ms grace keeps the test fast), or have the child print a readiness marker and trigger an abort from it.
- The plain-TERM and abort tests are not sensitive to this.

**B3. `package.json` has unrelated churn.** The description's `—` became a literal `\u2014`.
- The parsed value is identical, so this is not a behavior bug.
- It indicates the file was re-serialized with ASCII escaping, so please confirm nothing else in the file changed.
- Revert it so the package diff contains only the two script lines.

## Non-blocking observations

**N1. A late signal can still end in `passed`.**
- `throwIfAborted()` runs only at the start of each case, and `invokeDriver` observes the abort during the child's run.
- A SIGINT or SIGTERM that arrives during the final `verifyCaseEvidence`, the tool-hash check, or the gap between doctor and drive can leave `status:'passed'` with exit 0.
- The evidence is still verified, so the result is honest, but the interrupt is swallowed.
- One-line fix: call `controller.signal.throwIfAborted()` just before `result.status = 'passed'`. Optionally also check before each phase spawn, so a driver is not started only to be killed.

**N2. `stop()` can record a signal that was never delivered.** If the direct child has already exited but a grandchild holds the pipes open until the 180 s deadline, `signals_sent` gets `SIGTERM` and `killed` is set, although `child.kill` is a no-op. The failure is conservative (`timed_out`), but the record over-claims. Guard on `direct_child_exit_confirmed` before pushing the signal, or record the boolean return of `kill()`.

**N3. A throw inside `retainedState` leaves `journey.json` at `running`.** `absent` rethrows non-ENOENT errors, and `lstat` or `readdir` can fail after a descendant races. This is low risk. A try/catch that records `retained_error` would keep the "always finalizes" property.

**N4. Offline coverage that remains.** There is no seamed success run of `runJourney`, no test of the `interrupted`/`*_timeout` mapping through the wrapper, and no tamper tests for `expected_exit` or `descendant_termination`. The CI real-journey step and the author's real-pair claim cover the success path, so I do not require these.

## Package and CI wiring

- The `test:method-journey` and `smoke:method-journey` scripts match the README commands.
- `pnpm smoke:method-journey --output X` passes the arguments through to the script.
- `runner.temp` in step-level `env` and in `with.path` is valid.
- The upload step's condition (`always() && outcome != 'skipped'`) correctly skips upload when the contract-test step fails and uploads evidence when the journey fails. `if-no-files-found: warn` covers pre-journey refusals.
- The environment passed to the driver is minimal (PATH and HOME), so the artifact should not carry secrets. Raw command records do contain runner paths and PATH.
- Items I cannot confirm from the supplied scope, which the user should check before merging:
  1. The step must come after a build that produced `core`, `skill-registry` and `cli` `dist`. The startup-budget step below it suggests the build happened earlier.
  2. The `upload-artifact` SHA should match the one already used elsewhere in the file.
  3. If this job is matrixed, `method-journey-evidence-${run_id}-${run_attempt}` collides across legs under artifact v4. Add a matrix discriminator in that case.
  4. The git fixture setup should tolerate the runner's git version and global config. The driver builds its own `setup-home`, which should cover this, but only the real CI run will show it.

## README and scope honesty

The README now matches the code on the points it states:
- SIGTERM, then SIGKILL after 5 s, then a 2 s closeout.
- The tool-hash set.
- Scratch emptiness checked on success.
- Unverified failed-case digests and snapshot-only listings.
- `descendant_termination: not_attested` and no oracle or J03 claim.

One tightening: the README's exit-1 line could say that pre-journey refusals also exit 1 and create no artifacts. The "Refusal before acquiring…" sentence nearly covers this.

## Evidence binding for the replay

- The author record is bound to `code_sha 4ad0832…` and ran `node scripts/method-verification-journey.mjs` directly.
- The candidate is `17c5c82…`, which adds CI, `package.json` and README changes. The replay should confirm the candidate's `scripts/` bytes equal `4ad0832`, or rerun against `17c5c82`.
- The `pnpm` wiring and CI steps were not exercised by that record.
- The "default scratch… precommit same source bytes" claim should be checked by hash, not trusted.
- The retained failure evidence for the original `bfa4b432` should stay unchanged.

Resolve B1-B3 and the verifier/wrapper logic is a PASS for this scope. N1 is a recommended one-line addition. As agreed, the user alone approves and merges.
````
