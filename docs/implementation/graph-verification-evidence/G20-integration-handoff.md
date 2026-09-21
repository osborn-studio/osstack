# G20 bounded verification integration handoff

Status: COMPLETE — final focused run **17/17 passed** (exit 0, 82.35 s); final CLI typecheck **passed** (exit 0, no diagnostics). Only repository file written by this actor: `packages/cli/src/graph-verification-join.test.ts`. The optional second file was unnecessary because the two real worker cases share the same real host fixture. No production edits, commits, delegation, or full suite.

## What is exercised

- Actual GraphVerificationJoinService, GraphActionBroker, GovernedExecution, G04 command/review invocation, GraphArtifactStore freeze/restore, G19 durable invocation evidence, and SQLite ledger/join journal.
- Confirmed changes_requested review plus valid negative command exit produces complete/repair_required at maxEpochs=2, in both completion orders. Missing predecessor blocks. Repeated evaluation uses the freshest actual run fence and returns created:false with the same single immutable journal row.
- Malformed structured review persists explicit retrySafe failure; host retryAuthorized allocates actual attempt 2. Host recomputation selects latest evidence and retains original action/token/branch/deadline accounting.
- Old-attempt evidence is rejected by the real envelope loader; SQLite independently rejects replacing an immutable settled outcome with that old receipt. Evidence bytes tampered after publication invalidate subsequent evaluation.
- Unknown reviewer stop remains reconcile-only with no retry. A new actual G04 action with lost persistence acknowledgment after an existing publication also forces reconcile and returns no cached publication.
- Stale fences, live revocation, held admissions, and changes during actual FileHandle.readFile of durable evidence reject publication. A real retained-admission release changes the snapshot without changing run revision, and the coordinator detects it.
- Original action, token, epoch, branch-attempt and elapsed deadline limits stop the route without resetting limits or counters.

## Real worker evidence

Two cases run actual GraphRuntime child processes, public Functional tasks, and the SQLite-backed remote saver:

1. Static program hashes before run creation, requests a registered real freeze action, receives candidate SHA, then invokes review/tests in parallel. The host pre-freezes the same known candidate/artifactId and prepares independent branch repositories. A real malformed review RETURN commits to SQLite while the tests broker response is held **after** real G04 execution/evidence/ledger settlement. The host observes SIGKILL exit and drains the held Promise before G15 takeover. Fresh host authority retries review to attempt 2. Resume replays the cached failed attempt-1 review RETURN and re-enters tests without repeating its command. The coordinator ignores worker claimedPass, publishes the actual latest attempt-2 negative join, then returns created:false on repeated evaluation. Assertions verify four total starts (freeze, review 1, tests 1, review 2), three charged tokens, two reviewer invocations, one command execution, one recovery decision, unchanged original spec and creation/deadline origin.
2. Unknown verification response throws **inside** the actual Functional task; no successful phase RETURN is cached. Host remains reconcile-only and preserves uncertain resources.

Recovery proof uses GraphRuntime.observedExit and the actual drained stop receipt, loaded G19 stopped-executor evidence, verified artifact and preserved restored repositories. No fabricated stopped-worker proof and no MemorySaver.

**Boundary:** verification PHASE only. The candidate is a synchronously committed known base with no implementation worker. This is not interrupted external-executor recovery, daemon restart, full C6 delivery, or G21/full-template/automatic epoch transition.

## Commands and archives

Final commands:
```sh
OSSTACK_HOME=/Volumes/AIMATE_WORK/tmp/gc6/home TMPDIR=/Volumes/AIMATE_WORK/tmp/gc6 G20_TEST_HOME=/Volumes/AIMATE_WORK/tmp/gc6/home pnpm --filter @osstack/cli exec vitest run src/graph-verification-join.test.ts
OSSTACK_HOME=/Volumes/AIMATE_WORK/tmp/gc6/home TMPDIR=/Volumes/AIMATE_WORK/tmp/gc6 G20_TEST_HOME=/Volumes/AIMATE_WORK/tmp/gc6/home pnpm --filter @osstack/cli exec tsc --noEmit
```

G20_TEST_HOME preserves the requested exact home after the package setup file applies its ordinary hermetic home. Fixture files use tmpdir(); ordinary future runs remain portable. All evidence is preserved under `/Volumes/AIMATE_WORK/tmp/gc6/g20-*`, including SQLite databases, artifacts, independent repositories, real worker stop and quiescence receipts. Uncertain resources are deliberately not deleted.

Archives in this directory:

| File | Observation |
| --- | --- |
| G20-red.log | Initial 7/11 passed; fixture expectations for release errors and budget-stop publication corrected. |
| G20-typecheck-red.log | Initial fixture narrowing/cleanup/unused worker imports; corrected. |
| G20-worker-red.log | Fresh-generation freeze registration and aggregated worker exception expectations corrected. |
| G20-worker-2.log | 2/2 real child/Functional/SQLite worker cases passed. |
| G20-race-red.log | 3/3 actual envelope read race cases passed on first run. |
| G20-red-2.log | 15/16 passed; adversarial fixture used nonexistent evidence_ref column, corrected to outcome_json. |
| G20-red-3.log | 16/17 passed; SQLite immutable-outcome trigger rejected substitution. Test now asserts that protection without disabling triggers. |
| G20-green.log | 17/17 passed, exit 0; total duration 82.35 s. |
| G20-typecheck-green.log | Final CLI tsc --noEmit output; successful invocation emits no diagnostics. |

No production defect is established by the archived fixture RED runs.

## Final retained evidence

Verified test file SHA256: `daf52ad1aae6304d9201238d5cb73236624af610279156f543fe66a7d42f9500`.

Latest successful real recovery fixture inspection:
```json
{
  "worker_fixture": "/Volumes/AIMATE_WORK/tmp/gc6/g20-Vy0zUX",
  "action_rows": [
    [
      "freeze",
      1,
      "confirmed"
    ],
    [
      "review",
      1,
      "failed"
    ],
    [
      "review",
      2,
      "confirmed"
    ],
    [
      "tests",
      1,
      "confirmed"
    ]
  ],
  "joins": 1,
  "recoveries": 1,
  "checkpoint_rows": 2
}
```

Actual exit receipt: `/Volumes/AIMATE_WORK/tmp/gc6/g20-Vy0zUX/actual-worker-stop.json`. Quiescence evidence: `/Volumes/AIMATE_WORK/tmp/gc6/g20-Vy0zUX/quiescence.json`. All uncertain fixtures remain retained. No repository files beyond the permitted test file were written by this actor.
