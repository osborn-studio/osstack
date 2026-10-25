# F3 final r5 handoff (audit pending)

Production/test scope frozen before final whole-loop run; no commits by this agent.

- Every verifier adapter receives pre/post raw integrity snapshots. Non-Git fails before invoke. Kimi-specific structured payload remains only a format boundary.
- Read-only snapshot failures and detected mutation block retries/commit and preserve host containment; later adapters stop immediately on integrity/physical-stop uncertainty.
- Any invoked but unfinished iterator, including next rejection, is stop-unconfirmed. Returned return() is not proof. Verification command and artifact-command unknown stop abort all later effects.
- Git snapshot only enumerates through sanitized ls-files/rev-parse; raw tracked metadata/bytes + index defeats assume-unchanged/skip-worktree/EOL/filter normalization. Snapshot never executes clean filters. Relevant refs/config/hooks/info/worktree metadata and untracked raw bytes/ignored metadata covered.
- All inherited GIT_* stripped for snapshot/boundary/helper; artifact shell uses inheritEnv:false so executor cannot reintroduce poison.
- F1 containment belongs to other agent; latest host-root fixed canonical workspace scope, not old .git plan. Different workspace/root are different authorization objects, no sandbox promise against malicious same-UID host state deletion. Sameworkspace state changes/gitinit and same-instance contamination have regressions.
- Evaluation-spec and engine review fixtures use real Git baseline, reviewer output no longer mutates candidate. A owner separately fixing production ds-review default output external to candidate.

Validation: F3-r3-focused.log 55pass; F3-r3-loop-package.log 30files/484pass; build/tsc/Biome exits0. F3-r3-validation.json binds current11source hashes. Haiku r3 actual run evidence reaudit-F3-r3-* pending; do not call global PR/real-provider validation passed from scoped unit evidence.

Old fullQA negative triage: stuck-post-snapshot test budget consumed by initial actual Git work now precomputed before timing window; explicit generic failclosed required Git baseline for evaluation semantic fixtures. A owner fixed reader16/128/64caps. Old candidate-policy baseline and governed-execution release-timeout exact causes remain unestablished historical negatives, with later focused and whole-loop passing evidence, not fabricated root causes. Intermediate alias-root failure had run started before F1 hostroot code landed and test files changed during execution; retained original negative, current frozen all484pass replaces it.


R4 supersedes earlier r3 validation: 30files/495tests pass in F3-r4-loop-package.log; 75 focused and54 candidate/boundary tests pass; tsc/Biome/build exit0. R4 adds pre-probe baseline and post-probe observation, authoritative GIT_WORK_TREE and core.bare pin, hidden index-flag refusal in unsupplied review and candidate freeze. Keep supplied raw review support. The full loop run includes current A context/output summary fix and F1 root/evidence fixes, but their specialized Haiku reviews remain separately required. F3-r4-validation.json records14source hashes. Haiku r4 prompt has direct instructions and uses ASD-STE100 clarity principles without a formal-certification claim.

Real repository snapshot benchmark: 5378trackedfiles,65,341,375bytes; 3.195/3.357/3.259s per raw snapshot. Scope is this machine/repository only. The current preprobe+postprobe+postinvoke scheme has three observations. All share one adapter deadline. Failclosed remains mandatory if the final proof is unavailable.

Accepted residual: completed streams depend on trusted adapter completion semantics. The actual ds-review adapter waits for direct child close before completed. This is not all-descendant process-group proof. Generic contract cannot prove that a malicious adapter did not leave a detached child. Snapshot-to-commit is a finite window, not continuous monitoring. Known unfinished streams, rejected probes, and command unknownstops block. This is not a sandbox for hostile same-UID OS processes or arbitrary destruction of host containment storage.


R5 source is frozen. New invoke-attempt flag closes synchronous invoke/iterator-construction throws after a child launch. Verifier42 tests pass. Isolation/boundary/candidate75 tests pass. Engine owner49 tests pass. Typecheck and Biome exit0. R5 includes execution/verifier role separation, prepush/final mutation refusal, and ordinary legacy hidden-index refusal before publish/commit. Hidden candidates retain bytes, worktree, and containment. Same-instance and restart attempts do not rerun.

R5 audit input includes root accepted boundary report, full scratch helper and Vitest config, final source/test files, host validation, real full-invocation timing with ignored count. See reaudit-F3-r5-manifest.json and F3-r5-validation.json. The model review is pending. Parent full QA/CI still determines overall readiness.
