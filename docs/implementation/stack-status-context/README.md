> Historical validation below retains its original SHA. Current state: PR307 merged at de43f47c; PR308 targets main. Fresh 6d978973 validation passed 172 GitHub and 14 candidate CLI tests, lint/inventory/typecheck, 241 docs and 1 hygiene. Current-head CI is evaluated separately. See [actual-main record](../pr308-main-retarget/README.md).

# Preserve legacy GitHub status outcomes in stack ingestion

At main6c9a3e8f, the existing stack mapper parsed CheckRun conclusion/status but discarded StatusContext.state. Offline reproduction using the real compiled mapper and an injected forge runner showed SUCCESS, FAILURE and ERROR all mapped to pending. This is a current parser defect, separate from the new bounded snapshot tool. No live forge or DB write was used to reproduce it; downstream card storage effects are source inference, not a demonstrated DB incident.

The scoped repair is limited to stack.ts and its behavior tests, with root-owned release metadata and evidence. Preserve existing neutral/skipped CheckRun policy, failure precedence and graph topology; unrecognized StatusContext values must not become green. The independent criteria and36 vectors were frozen before author implementation. Original RED and same-path GREEN, production/source hashes, independent observations and actual Sonnet5.5 review will be bound to exact commits.

This contributes to PS18, supports PS17/J07, and uses J20 only as design context. It does not add a watcher, auto-approval, runtime activation or named method. Whole capabilities and formal milestones remain incomplete.

Upstream inspiration: pstack99b609a72323b70204eab407c622f436e858e112 watch-pr/github.ts distinguishes CheckRun and StatusContext; its local policy is not copied wholesale. pstack is by Lauren Tan under MIT, and OSStack retains attribution. Original source snapshots are retained with the independent freeze.

## Bounded execution and attribution

Author60495 changes stack.ts and stack.test.ts; root6f74 cherry-pick is byte-identical, rootbda adds a patch changeset. Same33 tests on old source produced12 failures/21 passes, then all33 passed after the fix; the original107-test GitHub package grew to125 for that branch. Root composition includes the previous candidate-snapshot tool, so root GitHub count170 is a different package population, not125 relabeled.

The independent36 frozen classification vectors had old27pass/9fail then new36pass. Undefined input is a separate control. A three-PR real API call with an injected read-only runner verifies success/failure/pending propagation, drift issue kinds, topology and exactlythree expected argv calls. No actual GitHub, stack CLI or database access occurred. Existing CheckRun neutral/skipped semantics remain unchanged; unknown or missing legacy states are pending.

Actual Sonnet5.5 static PASS confirms scoped logic and tests, with optional suggestions retained. Its known pre-existing CheckRun conclusion/status gaps are outside this fix and not claimed resolved. The author changed two source paths; root adds release metadata and evidence. The audit has no runtime authority and doesn't replace test receipts.

Downstream source inspection shows new CLI cards store ci_state and a provenance comment, and runbook displays stored CI. Existing cards are skipped, so this repair does not refresh historical cards. A card's initial ready column is separate from its CI checklist, which remains pending; no automatic merge/CI-green consequence is claimed. detectDrift semantics were exercised offline, but no production CLI caller was found by the bounded source search.


## Root integration

Root full run atbda3942a8d2b07c6af7c0ac4d64014b9f11cc3c5 passed7207 tests/5skip/0fail across22 unique packages. All8562 tracked file bytes were unchanged during execution; four freshly generated knowledge/dist files were initially dirty. This is not a clean committed-tree result. Later integration0e3a5553 incorporates PR307 lint repair24bed464, whose character acceptance was independently equivalent across278 inputs. New focused validation is separate from the earlier full run. Final published-head CI is evaluated independently.

Post-merge composition0e3a5553 passed172 GitHub tests,14 candidate CLI tests, full-repository lint, GitHub build and changeset coverage. The final documentation validation passed241 checks and hygiene passed1. These are separate receipts from the earlier bda full run. Original failures and optional static-review findings remain in evidence; CI on the eventual published candidate is not yet known.

Final evidence archive SHA25607dd50a68eae4329a24f60c49b741393da1ec8d4cb8fdbffda2d06f142add62b contains133 members (114 files,19 directories;3733395 file bytes). Root and independent verifier checked all names/types/modes/sizes/hashes against original scratch. Author worktrees and the earlier lint worktrees were clean and removed after handoff, branches retained.

After focused validation, parent PR307 required a generated PUBLIC_EXPORTS inventory sync; it changed documentation only in parent PR307 and is already part of actual main de43f47c; it is not a new export change in the PR308 main diff. A supplemental typecheck initially used restored old knowledge/dist and failed; exact previously saved fresh generated bytes yielded same-command exit0. Both logs and hashes are retained in the parent inventory-repair record. No extra product full is relabeled or claimed. The pre-existing line-oriented generator emits one `export {` line. Two original diff evidence files intentionally retain patch-context whitespace, which git diff --check flags; product/generated source whitespace is unchanged.
