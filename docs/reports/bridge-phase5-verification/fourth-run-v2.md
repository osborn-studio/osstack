# Fourth sandbox run — v2 acceptance

**PASSED for `LIVE_5G_ONLY`: 13/13, `qualified:true`, exit 0. Production CLOSED.** The user authorized one additional sandbox-only attempt (four total). Run `revision-5g-20261108d` completed on 2026-11-08, 15:03:47–15:16:20 Asia/Shanghai. Attempts 1–3 remain failed/unqualified; their reports are unchanged. This result authorizes no fifth run, production activation or merge.

## Source and immutable evidence

| Binding | Value |
|---|---|
| Driver source | `c6c3dd93fc1b797e3bd17e171dc96c94d95a050c` |
| Installed runtime source | `8120569883fd23c30bd99858de8f3d0c6a34aa55` |
| Original report SHA256 | `c0cdbc9cd6b5a9c4546cf520b8127c047af69bccf3d961d3cdfe15d5d706c53c` |
| Immutable snapshot SHA256 | `bd97e69bd699812afa4cb2a0d225c36d505c6d83392c1ca478853c11cb6ec557` |

Private evidence root is `/Volumes/AIMATE_WORK/tmp/osstack/runtime/bridge-v2-implementation-5OTtJx`. `fourth-control.json` identifies the original report at `/Volumes/AIMATE_WORK/tmp/osstack/smoke/bridge-revision-revision-5g-20261108d-ySzj23/report.json`. `fourth-snapshot-evidence.json`, `fourth-snapshot-manifest.json` and `fourth-ledger-audit.json` bind the retained state. The installed module paths, entry hashes and candidate manifest are in the original report's runtime provenance; source equality alone does not attest all transitive dependencies. No private database or raw credential-bearing artifact is committed.

## Completed scenarios

| Scope | Evidence and result |
|---|---|
| Cold cancellation/recovery | New process/new owner cancels before first tick, no child push. This is not in-flight executor recovery; `parentShutdownProven:false` remains explicit. |
| A | Two exact stage revisions, then registered approval. |
| B | Two exact stage revisions, then third-round refusal. |
| Authority | Host writer and App A force-push refused; unregistered review ignored. |
| Mixed review | Real model completes stage 1 without protected workflow/canary changes. One predeclared case, `mixed_stage1_workflow_authority_v1`; not a general prompt-injection guarantee. |
| Controlled hostile proposal | Exactly one stopped real Codex turn; only returned proposal patch replaced. Installed parser and real classifier/runner produce `T2/PROTECTED_PATH` before apply, candidate, verification or child push/release. `executor_lifecycle_source=real_codex`, `proposal_source=fixture`; not a model-generated hostile proposal. |
| Independent real W13 revocation | Legitimate candidate reaches publication; exact intent fails with `detail=grant_invalid`. Its sole intent-bound `git_push` row is `stopped`, `released_at=null`, `stop_proof=never_released`; remote unchanged. T2 containment is a separate case. |
| Final timeline | Exact confirmed ranges, App A activities, App B checks and live open-head conditions passed before cleanup. |

The targeted offline protected-finding mutant remains [separate source-bound evidence](protected-path-mutation-v2.md). Neither the nineteen historical mutants nor the TLC/property suites were newly rerun for this fourth live execution.

## Independent readback and retained state

`fourth-timeline-readback/audit.json` records **68 GitHub GET requests, zero failures**, without remote mutation. All six owned PRs (23–28) are closed and unmerged after cleanup. Their surviving refs match frozen ledger tips. Six complete compare responses bind the exact ranges; eleven complete all-check responses each contain one exact `mission:head` App B success. There are **11 confirmed publications**: six roots and five revision pushes, each with one App A publisher activity. Commit authorship is not used as publisher attribution. Twelve range events include the failed revoked push; twelve verification journals do not imply twelve remote publications.

`fourth-timeline-readback/observer-delta-resolution.json` retains the exact revoked-intent detail and complete range/check pagination evidence that resolved the two initial observer-retention findings. Activity pages are complete for the owned refs and declared day scope; they do not establish absence elsewhere. Current PRs are closed, so `postrun_live_open_precondition_satisfied:false` is expected. The readback does not recreate or replace the driver's successful pre-cleanup open-head assertion.

All **69 host process rows are stopped** and all **14 missions have `stop_obligation=0`**. Local audit counts are six chains, eight reservations, fourteen missions/claims, seventeen intents and twelve ranges. The T2 and revocation cases retain **two dispatched reservations, two awaiting-decision missions and two active claims**. Therefore **`ledger_settled:false`** is correct. This is retained decision state, not proof that all rows are cleared. No direct DB or bookkeeping mutation was used to force settlement. The local ledger tool reports `full_5g_pass:false`, `w13_revocation:unproven`, `github_timeline:not_read` by design; those limits do not erase the independently bound W13/timeline evidence.

## Remaining gates

Five initial Sol CLI reviews yielded three PASS results and two retention gaps, resolved by the raw evidence above. All five final Sol CLI scope reviews now PASS, including resumed release/timeline deltas; the raw notes are `fourth-watch-{rounds,containment,inventory,release-delta,timeline-delta}.last.md`. GLM-5.3 post-run review returned **SCOPED PASS**, no unresolved material findings, for static consistency of the strict allowlist projection and retained artifacts only. It executed nothing and does not establish authenticity or full-project/Grok/production completion; `glm-fourth-postrun-manifest.json` binds input SHA256 `e8168ff7d72ac371ce0b232540eaad6a3a9147c38b0c059f5a01735c6c9279ea` and result file `glm-fourth-postrun.json`. Reporter fix `05eb6600` preserves validated `driver_source_commit` separately from runtime provenance; targeted reporter **12/12** passed after RED 11/1. The parent fifteen-file Node run passed **484/484**, zero failures/skips, exit 0, 5178.63 ms (`fourth-followup-node-15.log`). `fourth-acceptance-status.json` reports live PASSED 13/13, both source identities and `all_tasks_done:false`. The historical 483-test pass remains separate.

Actual external Grok capability, Watcher chat failure → trusted local failure verification → bounded repair intake, production admission and five production chains remain incomplete. Reviewer stays paused and excluded. The Mission-main counted human approval gate remains unchanged. The default 31 verification recipes, original four feature files and helper are byte-preserved. Optional bridge guidance is updated for v2 acceptance and fourth-run evidence; its four sub-feature labels are retained. See [current status](current-v2-status.md), [v2 acceptance](acceptance-v2.md) and [graph progress](../../plans/bridge-graph/progress.md) for delivery gates.

Documentation validation: all 82 local link targets resolve across the fifteen changed Markdown files; `quick_validate.py .cursor/skills/verify-osstack` passes; default skill/map/helper and original four feature files have empty diffs; `git diff --check` passes. This worktree has no installed Vitest. The narrow `osstack-config.test.ts` assertions were run against this worktree through the main checkout's already-built, source-matched read-only governance modules: complete coverage, zero findings. No dependencies were installed and no live driver, DB mutation or remote operation was performed for the documentation update.
