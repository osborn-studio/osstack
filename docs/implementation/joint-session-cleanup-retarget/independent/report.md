# PR #278 independent fault regression

Verdict: PASS for the scoped cleanup change; no confirmed P0/P1/P2 introduced by this patch.

Candidate: `39c5df28cea120630f39a8267235c2f7ff5985b4`.

## Method

Read the exact daemon change, Session start persistence/replay path, `GovernedExecution`, `confirmAdapterStopped`, and `SupervisionService.requestScan`. Created only scratch test files; no product/worktree edits, Git mutations, PR writes, or additional Claude calls. The isolated Vitest fixture imports the candidate's actual source and builds on its real local socket RPC, SQLite, writer lock, and daemon implementation. Each fixture uses an explicit disposable OSSTACK_HOME through the repository scratch setup. Test-owned physical lock cleanup is not a product recovery mechanism.

## Additional execution

Command (cwd is this evidence directory):

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack /Users/osborn/Developer/CodeX/.worktrees/osstack/joint-cleanup-ready/node_modules/.bin/vitest run --config vitest.config.mts
```

Result: 1 file, 3 tests passed; 0 failures; exit 0; duration 4.12 seconds. Raw output is `extra-tests.log`.

- Rejecting `requestScan("session.start.settled")` after physical cleanup fails preserves committed idle/version-3 RPC result, clears active marker, retains one execution lease hold, and does not reinvoke on exact request replay.
- A permanently pending stop confirmation reaches the real one-second bound. Failed start remains agent_failed; no physical release is attempted; active marker clears and admission remains held. A fresh request ID cannot invoke an adapter in the quarantined repository; exact replay reads stored failed state.
- `stopped: true` with blank evidence is rejected as a stop proof and produces the same fail-closed hold/fresh-start/replay behavior.

## Source review conclusions

The nested finally cleanup guards marker deletion by exact controller identity. `release` sets retention/quarantine before diagnostics can throw; the outer cleanup catch preserves the bounded RPC receipt, and its diagnostic writer also tolerates stderr failure. `confirmAdapterStopped` already converts throws, absent/blank proof, and timeout into false. The current concrete `requestScan` implementation returns rejected Promises on stopped state and catches scan work; a synthetic monkeypatch that synchronously throws would be a hypothetical contract change, not an evidenced current regression. This harness exercises its real rejection contract.

Privacy conclusions are scoped: the new structured session_cleanup_failed diagnostic contains event/session/run IDs only, and the existing candidate regression asserts no prompt or native ID in that diagnostic. This is not a claim that every existing GovernedExecution error log is globally sanitized.

## Remaining scope

PR #279 adds successful terminal-event fencing. #278 still accepts a naturally exhausted start stream with a native ID and no terminal event; that is pre-existing and deliberately assigned to #279, not resolved by cleanup containment. DEBT02/J11/J12 owns durable cross-process visibility and authenticated reconciliation of retained obligations. These tests do not qualify restart across OS processes, live providers, process containment, authenticated recovery, or runtime-wide acceptance.

The primary verifier was running concurrently. Its generated tracked knowledge dist outputs and a changeset update were visible at final inspection; this worker did not touch them. Product source hashes and candidate SHA are captured in manifest.json. These three tests supplement the parent's full validation, not replace it.
