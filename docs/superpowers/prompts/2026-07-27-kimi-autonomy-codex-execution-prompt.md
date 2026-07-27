# Codex Handoff — Final Audit, Then Execute Kimi Autonomy

Use this prompt after all referenced files are uploaded to
`docs/kimi-autonomy-plan`.

## Authority profile

This invocation authorizes:

- read-only audit of the repository and remote branch;
- amendment of planning documents;
- implementation worktrees and branches;
- tests, builds, fixtures, local commits, and evidence reports;
- opening phase pull requests.

Unless the Owner adds explicit grants below, it does not authorize merge of
trust-kernel changes, machine-wide configuration, production activation, or
public package/release publication.

```text
OWNER-GO-MERGE: not granted
OWNER-GO-MACHINE: not granted
OWNER-GO-PROD: not granted
OWNER-GO-PUBLISH: not granted
```

The Owner may change any line to `granted` before sending this prompt.

## Task

Audit the Kimi autonomy plan one final time, apply the required plan corrections,
and—if and only if the audit passes—begin Phase A implementation immediately in
the same task.

Read in this order:

1. `docs/superpowers/specs/2026-07-27-kimi-code-mac-mini-autonomous-development-design.md`
2. `docs/superpowers/plans/2026-07-27-kimi-code-mac-mini-autonomy.md`
3. `docs/superpowers/plans/2026-07-27-kimi-code-mac-mini-autonomy.v2.md`
4. `docs/superpowers/audits/2026-07-27-kimi-autonomy-plan-audit-by-fable5.md`
5. `docs/superpowers/audits/2026-07-27-kimi-autonomy-audit-appendix-full-reports.md`
6. `docs/superpowers/plans/2026-07-27-kimi-autonomy-execution-control-v3.md`
7. `docs/superpowers/audits/2026-07-27-kimi-autonomy-audit-closure-ledger.md`
8. the five phase implementation plans A through E
9. `docs/runbooks/2026-07-27-kimi-autonomy-validation-deployment-release.md`

Pinned audit commit:

```text
49813780b4712953a3a8c34b890f7f34c4aa2865
```

## Final audit rules

1. Verify the pinned remote commit and current `origin/main`.
2. Run the planned-path baseline drift audit.
3. Prove or disprove every original Critical/High finding and every X finding
   in the closure ledger. Do not answer with general agreement.
4. Apply accepted corrections to the actual master, design errata, and five
   phase plans. The ledger alone is not a substitute for correcting the plan.
5. Do not change KD-01 through KD-08 or frozen Q decisions. If a correction
   would change one, stop only that item and request an Owner decision.
6. A linked Git worktree does not close reviewer isolation.
7. TTY alone does not authenticate a production human decision.
8. Zero checks, ambiguous protection, stale hashes, missing evidence, and
   unavailable identity all fail closed.
9. Record the final audit at
   `docs/reports/kimi-autonomy/final-audit-verdict.md`.

End the report with exactly:

```text
FINAL_AUDIT_VERDICT: PASS
```

or:

```text
FINAL_AUDIT_VERDICT: BLOCKED
```

## Continuation rule

If the verdict is `PASS`:

1. commit the corrected document suite;
2. fetch current `origin/main`;
3. create `feat/kimi-adapter-verifier` in a clean parameterized worktree;
4. isolate `OSSTACK_HOME` and `OSSTACK_SOCKET`;
5. record the Phase A base SHA;
6. begin A0 with the first failing test/probe contract;
7. continue task-by-task under the execution controller.

Do not stop after saying the plan is good. Do not ask whether to begin Phase A.

If the verdict is `BLOCKED`, do not edit production code. Report:

- unresolved finding IDs;
- exact evidence;
- why no safe default exists;
- the smallest Owner decision required.

## Implementation rules

- One phase, branch, and PR at a time.
- Every task is red → green → package gate → focused commit.
- Build before CLI smoke; never test stale `dist`.
- Use an isolated control-plane home for all development CLI invocations.
- Keep Builder/Evaluator/deploy child environments minimal; never forward owner
  approval or notification secrets.
- Update the ledger to `VERIFIED` only with linked tests/evidence.
- Preserve unrelated worktree changes.
- Never weaken a gate to make progress.
- Pause only at an ungranted named authority gate or a genuine design blocker.

## Expected first handoff

The first meaningful handoff after execution starts must include:

- final audit verdict and amended planning commit;
- current main and Phase A base SHAs;
- closed and still-open ledger IDs;
- Phase A worktree/branch;
- first failing test or real-probe blocker;
- exact commands run;
- next legal task.
