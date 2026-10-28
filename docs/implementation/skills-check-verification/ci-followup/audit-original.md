# Verdict: PASS, with no blockers

I reviewed the diff against prior head 7228af77 (candidate ff6bfeb) and the supplied sources only. I ran nothing, so the candidate head's CI status and the lint result are unverified.

## What I checked

**Correction (`packages/skill-registry/src/watcher.ts:58`)**
- Switching `exit` to `close` is the right fix. Node documents that `exit` can fire while stdio is still open or unread, and `close` fires only after the process ended and both streams closed.
- The root cause of the historical CI failure is inferred, not proven, but the signature fits. The mixed case runs three concurrent `ls-remote` calls via `Promise.all`. A drift source parsed from empty stdout becomes `no_matching_ref`, which gives `failed=2, drifted=0`. That yields exactly `summary_mismatch` plus `source_output_mismatch:drift`, with no `exit_mismatch` because the mixed case expects exit 1 anyway. This is a scheduling race, so it also explains why the 25 driver tests passed and only the later smoke step failed.

**Deadline, child and pipe semantics**
- `clearTimeout(t)` now runs at `close`, so the original 20s deadline covers the exited-but-not-closed window. It is neither restarted nor extended.
- The spawn-failure path is still correct. `error` resolves first, and the trailing `close(-2)` resolves a settled promise as a no-op.
- A late `close` after a timeout is harmless for the same reason.
- `kill('SIGTERM')` on an already-exited child is a no-op, so there is no PID-reuse risk.

**Test strength**
- If `close` is reverted to `exit`, tests 1 through 4 all fail, so the tests do detect regression of this fix.
- Tests 5 and 6 cover the spawn-failure and ordinary-completion paths.

**Scope**
- The diff touches only the watcher, its new test, a changeset and the CI step.
- Nothing under `scripts/` changed, so no driver predicate, case selection or timing was weakened.

**Artifact safety**
- Evidence is written outside the fixture root, and `assertOwnedFixture` still excludes it.
- Each command's env comes from `fixtureEnvironment`'s fixed allowlist rather than inherited, so `GITHUB_TOKEN` and similar secrets cannot land in `*.command.json`.
- `bindings.json` holds only paths and hashes.
- The artifact name is unique per run attempt, the retention is bounded, and the upload runs on failure via `always()`.
- Two parts of the CI wiring would not break the driver:
  - `mkdir -p …/runtime` leaves the evidence parent writable and the destination new, as preflight requires.
  - `pnpm smoke:skills-check --evidence-dir …` forwards the flag, assuming the script is a plain `node scripts/smoke-skills-check.mjs`.

## Optional improvements

| # | Sev | Path | Trigger | Fix |
|---|---|---|---|---|
| 1 | Low | `watcher.ts:49-52` timeout handler | Git exits but a descendant holds the pipe. The timeout resolves, but SIGTERM hits nothing and the open pipe handles can keep the CLI loop alive. This already existed before the PR. | After `p.kill`, call `p.stdout.destroy(); p.stderr.destroy()` and assert it in the timeout test. |
| 2 | Low | `watcher.test.ts` tests 1 and 2 | The tests emit `close` synchronously after `write`. They pass only because `PassThrough` (a Transform) delivers `data` synchronously, which is an internal detail. The mock also never models real stream end. | `await` a `setImmediate`, or call `stdout.end()`, before emitting `close`. |
| 3 | Low | `watcher.test.ts` test 4 | The final `resolves…timeout` assertion is vacuous because a settled promise cannot change. Emitting `exit` at t=0 also cannot distinguish "preserved" from "restarted" deadlines. | Emit `exit` at t=10000, assert still pending at 19_999 and timed out at 20_000, and drop the trailing assertion. |
| 4 | Low | New test file, not in the diff | Your real-Git reproduction is not a permanent test, and a single green CI is weak evidence for a race fix. | Add a POSIX-only test with a stub `git` on PATH, e.g. `(sleep 0.3; printf '<sha>\trefs/heads/main\n') & exit 0`. This is deterministic: it fails on `exit` and passes on `close`. |
| 5 | Info | `watcher.ts` | A daemonizing helper that keeps stdout or stderr open after a complete `ls-remote` now produces a 20s `timeout` where it previously succeeded. | This is fail-closed and bounded, so accept it. Optionally use a distinct reason such as `output_not_drained`. |
| 6 | Info | `ci.yml` | `always()` keeps artifacts from passing runs too. The action SHA is pinned with a loose `# v4` comment. | Once the cause is confirmed, consider `failure()`. Confirm the SHA matches the intended v4.x tag. I recall it as v4.6.2 but could not check it. |

## Confirm before merge

- The candidate head's CI is green, including `pnpm lint` on the new test file. Its single quotes and one-line multi-statement style differ from `watcher.ts`.
- If `@osstack/cli` bundles `skill-registry`, check whether the CLI also needs a patch changeset for the fix to ship. I couldn't see the build config.
- Describe the change as closing a demonstrated race consistent with the incident, not as the confirmed root cause. The first run with the uploaded `mixed.stdout` will settle that.