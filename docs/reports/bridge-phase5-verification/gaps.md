# Phase 5 verification gap matrix

Baseline: `5602b901`. This report separates existing tests from completed acceptance evidence. No real GitHub writes were made.

| Design requirement | Baseline evidence | Fulfilled versus required |
|---|---|---|
| Duplicate cycles and concurrent reconcilers | core property `race`; live test dispatches one child and coalesces scans | Test exists; rerun required |
| Concurrent review / second read | live stable second read and snapshot change tests | Test exists; reviewer conflict interleaving mutation still required |
| Outsider push at all publication boundaries | publication local lease scenarios, readback mismatch, stale precheck | Test exists; exact 3-boundary mutation mapping required |
| Head regression | publication `head_regressed`; core randomized regress | Test exists; rerun required |
| Base movement during child and publication | live base change; publication base_changed_before_release and readback | Test exists; rerun required |
| Closed PR during execution / prepush | live close and runner cancellation; publication closed scenario | Test exists; rerun required |
| Read 5xx / limits / uncertain readback | startup transient reads and live backoff; publication readback mismatch | Partial: retry exhaustion and transport faults must be mapped separately |
| Crash intent, spawn, confirm, check, dispatch, startup boundary | publication K1–K6 and rollback tests; property crash transaction | Partial: exact startup between host/revision recovery boundary needs independent assertion |
| Token revoked 403 | publication stopped auth failure push_rejected | Test exists; rerun required |
| Grant expiry / write scope revoked | runner release fence and await revocation matrix | Test exists; randomized live grant event absent |
| One-round budget | property rounds 1/2; store caps | Test exists; store and SQL CHECK mutants separately required |
| Cancel and restart | K crash tests; release child_cancelled | Partial: randomized cancellation absent |
| Owner takeover during publication | stale owner fence and startup owner loss | Test exists; rerun required |
| Invariant 5 immutable revision scope | revision spec constructor tests | Separate test exists; property must reference actual constructor |
| Invariant 6 exact root baseline + ordered push ranges | property checks head membership; publication checks per-intent ranges | Missing exact concatenation baseline property; production live reconciliation also lacked this check at baseline (reported to production owner) |
| All §5.6 source mutants fail | TLA guard configs only | Missing full TypeScript source mutation runner and evidence; model mutants are not implementation mutants |
| 10,000 live interleavings | baseline property supports OSSTACK_PROPERTY_RUNS | Running baseline with seed 51007; strengthened run required |
| Exhaustive live TLC | historical README reports 34,915,194 distinct states | Historical evidence; README lists missing crash/recovery paths, so insufficient for revised model |
| TLC mutants / resume outcome | historical configs first fail ResumeSafety | Need -continue or dedicated outcome-only configs; not simulation |
| 5-G A two rounds then approve | only older shadow sandbox script exists | Missing Phase 5 script and live end-to-end evidence |
| 5-G B third review stops | no Phase 5 script | Missing |
| 5-G ruleset / App A force push / outsider reviewer / workflow injection / cancel restart / scope revoke | unit coverage for most local behavior | Real sandbox ruleset and App identity checks require authorized external write run; fake GitHub cannot establish these |
| 5-G timeline vs ledger exact commits and check runs | older shadow recording only | Missing live timeline comparison |

Local Docker with a fake GitHub server can validate execution, denial injection, ledger ordering and retry behavior without external writes. It cannot validate GitHub rulesets, actual App actor attribution, installation permissions, or real review/check timeline behavior. A local fake run must be labelled rehearsal, not §5.7 completion.

## Initial environment

`docker` is installed. Initial `docker info` failed because `/Users/osborn/.docker/run/docker.sock` was absent. Parent owns daemon startup. TLC v1.7.4 jar exists at the documented path. Fresh worktree dependencies were absent; frozen pnpm install and build were started. Every test uses `OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack`; no default control-plane home is opened.

## Current gate verdicts

| Gate | Verdict | Evidence |
|---|---|---|
| Invariants 1–4 and exact range invariant 6, 10,000 generated live interleavings | pass | linked-range property log, seed 51007; includes explicit rejected push, cancel, expiry and 930 multi-commit revisions |
| Invariant 5 constructor, 10,000 generated root specs/reviews | pass | spec-property log, seed 51007 |
| All 19 required implementation mutants | pass across integration graph | 18 local kills plus parent production-baseline omission kill; source-mutants.json |
| Real second owner takeover during publication | pass | independent SQLite connection calls claimOwner before W13 release; registered row stays unreleased |
| Readback retry exhaustion, HTTP 503 and HTTP 429 after push | pass | 3 cases; one push, uncertain receipt; bounded retry count |
| Loop process fixture failures | pass | reproduced 2 failures; 116/116 final suite; actual Docker Linux marker-capacity probe |
| Core/CLI types, targeted lint, docs audit, inventory, changeset and startup | pass | evidence.json; startup 58ms version / 178ms help |
| Full live Spec under smaller declared bounds | pass | exhaustive TLC 303,148 distinct, depth 23, queue empty |
| Shadow Spec | pass | exhaustive TLC 11,897 distinct, depth 13, queue empty |
| Fourteen model guard mutants | pass | each yields its expected safety invariant counterexample with final model |
| Broad two-reviewer main and three-review full rounds | pending | exhaustive processes still running; no pass claimed from progress counts |
| Model fidelity limits | explicit residual assumptions | one modeled commit per push and assumed root baseline; exact close cleanup and R2 stop reasons abstracted; TS tests cover actual ranges and grant behavior |
| Real 5-G sandbox A/B, permission and timeline checks | not run here | parent owns sandbox driver and any authorized external run; Docker/fake service cannot prove GitHub rulesets/App identity |

Phase 5 is not declared complete. The earlier table records the baseline, not a claim that its test-exists rows independently establish every live acceptance scenario.
