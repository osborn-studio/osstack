# v2 protected-path source mutation evidence

> **Historical evidence snapshot.** This report records the first targeted mutant at source `20b7b9d7`. Its attempt-3 and review status below apply only to that snapshot. See [current v2 status](current-v2-status.md) for the later source-`7f657613` mutant rerun, final static reviews, preserved third live failure (**7/13, `qualified:false`**) and fourth live `LIVE_5G_ONLY` pass (**13/13**).

**One new targeted mutant validly killed**, first targeted attempt, on source HEAD `20b7b9d7187260d0599a263ecd55e4400422d543` in the isolated mutation-proof worktree. This is `offline_source_mutation`, with `executor_lifecycle_source=offline_scripted` and `proposal_source=fixture`. It does not establish real Codex lifecycle, actual git commit, GitHub, Docker, W13 release or live v2 sandbox acceptance. Attempts 1–2 remain failed/unqualified; attempt 3 **NOT YET RUN**; production **CLOSED**. The [local failure-intake product gap](acceptance-v2.md#product-closure-still-missing) remains open. GLM mutation static review is **running, not passed** at this evidence snapshot.

`pnpm build` exited 0 before mutation. The strict harness invocation was:

```sh
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack \
  node scripts/verify-bridge-phase5-mutations.mjs no-adversarial-protected-path-finding
```

It ran only `no-adversarial-protected-path-finding`, exited 0, and restored source. Baseline and mutant used the same oracle command:

```sh
pnpm --filter @osstack/cli test src/contained-mission-adversarial.test.ts \
  --maxWorkers=1 -t 'offline protected workflow proposal halts before local application'
```

Baseline exited 0; mutant exited 1 with exactly the designated `AssertionError: PROTECTED_WORKFLOW_MUST_HALT_BEFORE_APPLY`, no signal or spawn error. Compilation/runtime/network failures, timeouts or alternate denials did not count as kills. Only the matching protected-path finding generation was removed; protected-set definition/digest and runner T2 branch stayed intact.

| Observation | Baseline | Mutant |
|---|---|---|
| Actual source classifier | `T2/PROTECTED_PATH` | `T0`, no reasons/findings |
| Actual runner state | `awaiting_decision`, `halted/tier_escalated` | `candidate_ready`, no halt |
| Offline read/commit calls | 0/0 | 1/1 |
| Ledger ending | `halted` | `t0_intent`, `candidate_committed` |
| Verify/publish calls | 0/0 | 0/0 |

The commit port materialized fixture bytes under scratch; its candidate head/commit identity are scripted offline values. The same valid fixture, caps, `adversarial_fixture` allowed paths `[".github/workflows/**"]`, spec digest and protected-set digest were used. Independent evidence audit passed hash comparisons, operation-ID/revision recomputation, ordered mission-bound events, actual runner progression, designated assertion and source restoration; the worktree was clean afterward.

| Binding | SHA256 |
|---|---|
| Classifier baseline/restored | `a9b33c327f12365ea7bd7cd01debb1e2f7bfa416fb8bfc05ca18326a512ef2eb` |
| Classifier mutant/observed | `c861fb828ac794f43832afb7195c2fd04b5ca30a0edb921198bbd515306479fc` |
| Unchanged oracle | `d766d6140c6680dcd19d2ae6834cf045fcc8bb1cee4d4f7e3dd8e45eb85cc5a2` |
| Fixture | `7bacda559078462266b7e070140b84d3a89cf3456b2f0d1cdfe6cbb21cc47af9` |
| Baseline log | `0b31e791c4504ee017af295d8ec6150deaf3e1ed39cacd8890126f30d372d904` |
| Mutant log | `f718af4504b40af621dbd41e817f881fd96de030c4157f6eb30ec1b6324312c9` |

Raw evidence remains outside the repository: `/Volumes/AIMATE_WORK/tmp/osstack/smoke/bridge-phase5-mutants-PObdl3/{results.json,baseline-0.log,no-adversarial-protected-path-finding.log}`. Execution summary and independent audit are `/Volumes/AIMATE_WORK/tmp/osstack/runtime/bridge-v2-implementation-5OTtJx/protected-mutant-execution.md` and `protected-mutant-audit.json` in that same directory. Raw artifacts are not committed.

The existing nineteen historical mutation results remain separately scoped evidence; they were **not rerun** here. This report records one new targeted baseline/mutant execution, not twenty new runs, a full-suite rerun, static review approval or live acceptance.
