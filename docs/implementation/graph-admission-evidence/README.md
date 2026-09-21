# C3 evidence index

Authoritative result: [admission.json](admission.json). Final source: [source-hashes.json](source-hashes.json). Scope and operational limits: [recovery-boundary.md](recovery-boundary.md).

## Actual execution

[acceptance.mjs.txt](acceptance.mjs.txt) invokes the built OSStack LoopEngine with one explicit task, isolated HOME, no automatic worktree/commit and exact workspace policy. [acceptance-command.mjs.txt](acceptance-command.mjs.txt) runs deterministic validation commands. [acceptance-result.json](acceptance-result.json) records the successful second attempt; its [state](acceptance-LOOP-STATE.json) preserves the first escalated attempt too.

- [Full workspace tests](accepted-full-tests.txt): 2,737 passed in 22 packages.
- [Typecheck](accepted-typecheck.txt), [schemas](accepted-schemas.txt), [kernel probe](accepted-kernel.txt), [Functional probe](accepted-functional.txt), [startup](accepted-startup.txt).
- [Post-review Loop lifecycle](loop-lease-final.txt), [admission](governed-lease-final.txt), [typecheck](post-review-typecheck.txt): validate the final small release-ordering and engine-reuse hardening after the full-suite snapshot. The new tenth Loop test is not counted as part of the earlier 2,737.
- [Scope and real producer tests](scope-semantics.txt), [CLI contention](local-contention.txt), [renewal-fault hardening](admission-hardening.txt).
- [First failed acceptance](first-acceptance-result.json) and [its full log](first-accepted-full-tests.txt) are retained. It exposed a test's unjustified ordering assumption before Git identity resolution; the final assertion checks bounded concurrency and unique execution without requiring concurrent socket requests to finish resolution in submission order.

The `G08/G09/G10-executor.md` files are historical OSStack/Codex actor handoffs. Their original system-temp logs disappeared before archiving. They are not presented as independently inspectable raw proof. Parent reruns above establish the final acceptance; no original logs were reconstructed or fabricated.

## Claude Fable 5.1 review and adjudication

[Design challenge](claude-design-review.md), [implementation review](claude-implementation.md), [second review](claude-final.md), [closure](claude-closure.md). Raw JSON records identify the actual `claude-fable-5-1` model. Review was read-only from provided snapshots; Claude did not run tests.

| Finding | Disposition |
|---|---|
| No production registration for direct writes | Added trusted `serve --workspace` and embedding registrations; writes without scope fail closed. |
| Canonical root bypass through subdirectory/worktree | Inherit primary checkout policy, then current checkout/path restrictions; tests reject observe/invalid primary policy. |
| Cross-HOME and legacy invocation bypass | Canonical lock shared by daemon, local Loop, guarded delivery/resume and session/collaborator paths. Client finalizer flags that are not daemon-owned explicitly refuse. |
| Unconfirmed cancellation and occupied capacity | Deliberately retain real unknown work and file lock. Rejected suggestion to treat post-abort iterator exhaustion as proof; it conflicts with the existing AgentAdapter contract and C2 counterexample. Actual child-exit tests distinguish confirmed and unknown cases. |
| `runCycles` nested acquisition | Initial review inferred a nonexistent call. Actual code calls private `runCycle` directly, and finite-cycle integration tests pass. No nested `runOnce` acquisition exists. |
| Hard-link filesystem dependence | Changed publication to guard-serialized atomic rename; actual multiprocess lock tests passed. |
| Abandoned guard / dead owner | C3 remains fail-closed; documented quiescent offline recovery. No blind force-unlock RPC; automated reconciliation stays G14/G15. |
| Validation typo quarantines an idle engine | Track whether effects started; release on pre-effect failure. Added validation-error and sequential-reuse tests. |
| Reads redirected to serving workspace | Preserve read target; reject a mismatched write target before invocation. Both branches tested. |
| One renewal failure blocks all reads | Quarantine per repository, preserve consumed capacity, keep unrelated reads and remaining capacity available. |
| Guarded result status ambiguity | Verified the actual three-member union and use positive completed/needs_approval checks at every relevant callsite. |
| Release while renewal is in flight | Recheck retained after waiting for renewal; preserve unknown ownership. |

Claude's final closure approves the four P1 fixes. Two subsequent hardening suggestions were applied and checked locally; no claim that Claude independently executed or re-reviewed those exact final bytes is made.
