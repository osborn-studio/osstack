# Current v2 verification status — 2026-11-08

**Attempt 3 FAILED: 7/13 scenarios passed, `qualified:false`; production CLOSED.** Run `revision-5g-20261108c` used driver source `7f6576135fc16fe72817f12ca7f66b8b51347cfd` and installed runtime source `8120569883fd23c30bd99858de8f3d0c6a34aa55`. Attempts 1 and 2 remain failed/unqualified. The original third-run report is preserved unchanged; subsequent diagnostics do not turn it into a pass.

| Third-run scope | Actual result |
|---|---|
| Cold cancel/new-process/new-owner recovery | Passed, no push |
| A first and second exact stage revisions, then approval | Passed |
| B first and second exact stage revisions, third-round refusal | Passed |
| Authority negative probe | Driver stopped at `ruleset_probe_not_rejected`; original HTTP body was not stored. A later separate diagnostic captured the canonical REST 422 denial |
| Unregistered review, mixed-review model resistance, controlled hostile proposal/T2, real W13 release revocation, final timeline reconciliation | **NOT EXECUTED** after that stop |

This failure is **not evidence of a protection bypass**. Independent GitHub rule-suite readback binds suite **4976834109** to repository **1446327922**, App A actor **352680398**, ref `refs/heads/osstack/mission/revision-5g-20261108c-a`, before `7f6cbb067f7c5d8fc5dad82b06220e4135ea84a8` and attempted after `48ff2f8b367dce341a48a257d1b3eca483ba5e29`. Active `mission-history` rule **26577639** reports `non_fast_forward: fail` (“Cannot force-push to this branch”). Host writer suite **4976833991** reports `update: fail`. The remote A head stayed at the before SHA; rulesets remained active and unchanged. The earlier assumption that the force update succeeded is corrected by this evidence. A later separate diagnostic (`sandbox-A-force-http-capture.json`) captured HTTP **422** with the exact message `Repository rule violations found\n\nCannot force-push to this branch\n\n`. Its before/after head values both equal the before SHA above, and `old_isRulesetRefusal:false` reproduces the false negative. This proves that the diagnostic force update was denied. It does not reconstruct the missing original HTTP body or complete the stopped live run.

The integrated parser fix accepts this exact canonical envelope only with HTTP 403/422 and a valid expected `refs/heads/` context. It retains the existing GH013 and legacy formats. The driver now awaits bounded, redacted probe evidence persistence before asserting refusal, and records App A before/after heads even after an unrecognized response. **53 focused refusal/callback regressions passed** against the fix; the old driver failed 14 of them. These are local contract tests, not a fourth live attempt or retroactive qualification.

No fourth full paid attempt was performed or authorized. The concrete fix and offline tools are integrated; any further paid run requires new scoped authorization after local review. This status update performs no Codex, Docker, new PR chain, settings or remote action.

## Local evidence, separately scoped

- Final explicit-SSD-root `pnpm test` at source `7f657613`: **22 packages, 8,905 passed / 6 skipped**, exit 0; CLI **3,989 passed / 5 skipped**. The initial environment run was failed/aborted **143**, with a reproduced **120-byte AF_UNIX socket path → EINVAL** and serial setup timeouts. It remains recorded separately; the short-SSD-root retry does not erase it.
- Historical twelve-file offline Node job at the earlier source: **369 passed**, no failures/skips. The current CI/recipe command lists 15 files after adding the three tool suites below. The earlier 15-file run passed **460/460** (`integration-node-15-final.log`). After the review fixes, the final frozen source `d98cc0fe` passed **483 tests, 0 failed, 0 skipped**, exit 0, duration 5185.32 ms (`integration-node-15-reviewed.log`). These checks do not establish live platform behavior.
- New offline tool suites, separately recorded: read-only ledger audit **19/19**, bounded ruleset diagnostic **31/31**, artifact acceptance reporter **11/11**. The initial 9/20/9 counts predate the boundary fixes. The diagnostic defaults to a zero-I/O plan; explicit execution can issue one scoped PATCH and requires its own authorization. No new tool diagnostic was executed against GitHub by this integration. The final immutable-snapshot audit bound the snapshot SHA and original report SHA. It covered 3 chains, 5 reservations, 8 missions, 8 claims, 38 host processes, 11 intents and 7 ranges; all seven unsettled counts were zero. W13 revocation remains unproven; the ledger tool itself did not read GitHub timeline. The acceptance reporter emits **LIVE_5G_ONLY FAILED, 7/13**, external Grok UNKNOWN, `all_tasks_done:false`, `production_activation:NOT_AUTHORIZED`. Exit 0 means the advisory report was emitted.
- Final targeted protected-finding mutant at source `7f657613`: valid kill, baseline exit 0, mutant exit 1 with designated AssertionError, source restored. Same fixture/spec/protected digest, baseline T2 halt and mutant T0 progression to the offline candidate. Executor lifecycle/commit ports are scripted offline, not real Codex. The historical nineteen-mutant evidence remains separate and was not newly rerun.
- Historical GLM static delta review: **PASS**, no remaining actionable P1/P2, bound to rerun test SHA `66760afa54e04dc212e34368b09725b54f9ea903b2c8833692ecdde907f27d12` and helper SHA `066d609b416d02daeee6295766273f2c8887a5960c9d28b6324daee97b0d4f47`. Static review does not claim execution or a live pass. Its then-pending full-suite/mutant checks completed separately as above. An earlier tooling GLM PASS (`glm-new-tooling.json`) missed concrete failures later reproduced by Sol: false local settlement, unbound snapshot WAL/report bytes, resettable diagnostic consumption and false acceptance PASSED results. The fixes and regression tests are committed. The final GLM-5.3 static delta review is **PASS**, with no unresolved P1/P2, bound to source `9c93ddd34ff6bce031ab4fb9e29364b0c7c13000` and the six-file SHA256 manifest `glm-new-tooling-fix-delta-manifest.json` (review input SHA256 `500f44a0d415a563b2b51279cc84cf1fbd87062717c71775400e2994951c8a97`). All six current file hashes and the input hash match the manifest. The review executed nothing. Its minor `qualification_scope` concern is a false alarm: the shared `sandboxV2Qualified` predicate already requires `LIVE_5G_ONLY`. The static PASS does not change live acceptance.

Four final Sol CLI reviews (ledger, policy, acceptance and final security scope) also report **PASS**, with no concrete blockers. Some independent fixture reruns were blocked by scratch-write `EPERM`; they do not independently establish 19/31/11. The parent's actual combined **483/483** run remains the execution evidence.

The reviewed fixes reject unsettled chains/reservations, duplicate identities and duplicate commits inside a range. Snapshot mode requires the exact report SHA, refuses journal/WAL/SHM sidecars before and after the query and uses `immutable=1`. Live DB hashes remain explicitly `MAIN_FILE_ONLY`. The one-shot diagnostic guard now binds to the original canonical run rather than the selected output scratch root, and validates `owned_prs` as an exact array. The acceptance reporter rejects explicit live failures, invalid count types and unbound mutation observations. These checks improve local evidence handling; they do not establish artifact authenticity or recreate deleted evidence.

## Post-run timeline readback, partial only

A separate read-only audit made **39 successful GitHub GET requests**. It bound **7 published heads and 7 App B success checks** to the frozen ledger, including PR 20's baseline receipt **128638788875**, which was absent from the embedded report but present in frozen event `seq=50`. Repository activity contained **3 branch creations and 4 pushes**, all attributed to App A publisher actor **352680398**. Commit order, exact ranges, before/after refs and App B external IDs matched the retained ledger. PRs 20, 21 and 22 were closed, unmerged, with surviving refs at the ledger tips.

This is a **partial post-run readback**, not a passing original timeline assertion. The driver's final timeline block was never reached. Its live open-PR precondition cannot be replayed after cleanup closed the PRs. The original `qualified:false`, 7/13 result, acceptance gaps and unexecuted scenarios stay unchanged. This readback made no remote mutation, model call or Docker run.

Reviewer remains paused and excluded from the required loop. Two cloud UI read attempts timed out; no actual Grok integration has been proved. The [Watcher chat failure/local repair intake gap](acceptance-v2.md#product-closure-still-missing) and Mission-main human approval gate remain unchanged. Passing local checks and registered-review transport do not complete the user’s full automation loop.

## Evidence references

Private evidence root: `/Volumes/AIMATE_WORK/tmp/osstack/runtime/bridge-v2-implementation-5OTtJx`:

- `live-control.json` identifies the unchanged original `/Volumes/AIMATE_WORK/tmp/osstack/smoke/bridge-revision-revision-5g-20261108c-7EOm1X/report.json`.
- `sandbox-A-force-http-capture.json` retains the later diagnostic response and unchanged head; `refusal-driver-report.md`, `fix-refusal-tests.last.md` and `refusal-contract-writer.log` retain the repair scope and 53-test evidence.
- `readonly-ledger-tool.md`, `policy-preflight-tool.md`, `acceptance-status-tool.md` and `acceptance-status.json` retain the initial tool contracts/results. `new-tools-sol-review.md`, `final-policy-boundaries.last.md`, `final-acceptance-boundaries.last.md` and `third-readonly-ledger-final.json` retain the later findings, fixes and scoped final ledger result. Earlier counts and assertions in the initial notes remain historical.
- `third-timeline-readback/audit.md`, `audit.json` and `manifest.json` retain the post-run readback scope, exact bindings and GET artifact hashes.
- `sandbox-A-force-suite-detail.json`, `sandbox-host-writer-suite-detail.json`, `sandbox-history-ruleset-live.json`, `sandbox-writer-ruleset-live.json` retain authority readbacks.
- `integration-full-test-ssd-summary.json`, `integration-full-test-ssd.log`, `full-test-long-root-stop.json`, `full-suite-stall-investigation.md` retain full-run/retry scope and failure history; `integration-node-final.log` records the historical twelve-file result; `integration-node-15-final.log` records the pre-review 460-test result; `integration-node-15-reviewed.log` records the final 483-test result at frozen source `d98cc0fe`.
- `glm-new-tooling-fix-delta.json`, `glm-new-tooling-fix-delta-manifest.json` and `glm-new-tooling-fix-delta-input.txt` bind the final static PASS; `review-ledger-fixed.last.md`, `review-policy-fixed.last.md`, `review-acceptance-fixed.last.md` and `review-final-scope.last.md` retain the four final Sol review results and rerun limits.
- `final-protected-mutant-evidence.json` identifies final raw baseline/mutant logs under `/Volumes/AIMATE_WORK/tmp/osstack/smoke/bridge-phase5-mutants-JcEadb`; `glm-final-delta.json` and `final-source-adversarial-tests.json` bind static review and its focused rerun.

No raw private artifacts, databases or credentials are committed with this report.

## Offline artifact commands

These commands read retained local evidence and print scoped reports. They do not run the real driver or authorize activation:

```sh
POOL=/Volumes/AIMATE_WORK/tmp/osstack/runtime/bridge-v2-implementation-5OTtJx
REPORT=/Volumes/AIMATE_WORK/tmp/osstack/smoke/bridge-revision-revision-5g-20261108c-7EOm1X/report.json
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack \
  node scripts/audit-bridge-sandbox-ledger.mjs --report "$REPORT" \
  --snapshot "$POOL/third-final-ledger.sqlite" --manifest "$POOL/live-control.json"
node scripts/report-bridge-acceptance.mjs --sandbox-report "$REPORT" \
  --local-tests "$POOL/integration-full-test-ssd-summary.json" \
  --mutation-evidence "$POOL/final-protected-mutant-evidence.json"
```

The ledger audit's exit 0 means its local ledger is settled; it always reports `full_5g_pass:false`. The acceptance reporter's exit 0 means output was emitted. The ruleset tool's default command, `node scripts/probe-bridge-sandbox-rulesets.mjs`, returns a plan before credential, artifact, runtime or network access. Its explicit execution mode is outside these offline commands.
