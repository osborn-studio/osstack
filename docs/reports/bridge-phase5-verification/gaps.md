# Phase 5 verification gap matrix

Baseline: `5602b901`. The baseline/local tables below preserve their historical scope; no real GitHub writes were made for those local checks. The later real fourth-run result is recorded at the end.

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

## Local gate verdicts (historical scope)

| Gate | Verdict | Evidence |
|---|---|---|
| Invariants 1–4 and exact range invariant 6, 10,000 generated live interleavings | pass | linked-range property log, seed 51007; includes explicit rejected push, cancel, expiry and 930 multi-commit revisions |
| Invariant 5 constructor, 10,000 generated root specs/reviews | pass | spec-property log, seed 51007 |
| All 19 required implementation mutants | pass across integration graph | 18 local kills plus parent production-baseline omission kill; source-mutants.json |
| Positive extra_repair on a stopped same-child round | pass | isolated real-ledger runner case passes; removing acknowledgeAdvance kills that same assertion; extra-repair-evidence.json |
| Real second owner takeover during publication | pass | independent SQLite connection calls claimOwner before W13 release; registered row stays unreleased |
| Readback retry exhaustion, HTTP 503 and HTTP 429 after push | pass | 3 cases; one push, uncertain receipt; bounded retry count |
| Loop process fixture failures | pass | reproduced 2 failures; 116/116 final suite; actual Docker Linux marker-capacity probe |
| Core/CLI types, targeted lint, docs audit, inventory, changeset and startup | pass | evidence.json; startup 58ms version / 178ms help |
| Full live Spec under smaller declared bounds | pass | exhaustive TLC 303,148 distinct, depth 23, queue empty |
| Shadow Spec | pass | exhaustive TLC 11,897 distinct, depth 13, queue empty |
| Fourteen model guard mutants | pass | each yields its expected safety invariant counterexample with final model |
| Broad two-reviewer main | pass | 69,290,566 distinct states, depth 48, queue empty, process exit 0; includes the documented scheduling suspension |
| Three-review full rounds | pass | 95,121,536 distinct states, depth 46, empty queue, process exit 0; same preserved search after scheduling suspension |
| Model fidelity limits | explicit residual assumptions | one modeled commit per push and assumed root baseline; exact close cleanup and R2 stop reasons abstracted; TS tests cover actual ranges and grant behavior |
| Real 5-G sandbox A/B, permission and timeline checks | not run here | parent owns sandbox driver and any authorized external run; Docker/fake service cannot prove GitHub rulesets/App identity |

Phase 5 is not declared complete. The earlier table records the baseline, not a claim that its test-exists rows independently establish every live acceptance scenario.

## Current 5-G acceptance (2026-11-08 Asia/Shanghai)

The tables above preserve their historical baseline/local scope. **Attempt 4 passed v2 `LIVE_5G_ONLY`, 13/13, `qualified:true`, exit 0**; [fourth-run evidence](fourth-run-v2.md) binds benign/mixed model work, controlled patch-only hostile T2, independent real W13 revocation and exact final timeline. Independent readback made 68 successful GETs and matched eleven confirmed heads, eleven App B success checks and eleven App A activities. The driver observed open heads before cleanup; the six owned PRs are now closed/unmerged.

Attempts 1–3 remain failed/unqualified; the third-run report remains 7/13. The cold case still cancels before the first executor tick and does not establish parent shutdown or in-flight executor recovery. The single predeclared mixed case is bounded evidence. Historical mutation/model assumptions are unchanged. All 69 host journals are stopped and all 14 mission stop obligations are zero, but two decision reservations/missions/claims remain; `ledger_settled:false` is expected and no rows were manipulated to clear them.

All five Sol CLI scope reviews now PASS; GLM-5.3 post-run review returned SCOPED PASS with no unresolved material findings for static projection/artifact consistency only; it executed nothing and does not prove authenticity or full-project completion. Reporter provenance fix `05eb6600` passed 12/12 targeted tests; parent fifteen-file Node run passed 484/484 (zero failures/skips, exit 0). Actual external Grok capability and [Watcher failure/local repair intake](acceptance-v2.md#product-closure-still-missing) remain open, as do production admission and five production chains. Reviewer remains paused/excluded and the counted human main gate remains unchanged. Production is **CLOSED**; no fifth real run is authorized. See [current status](current-v2-status.md).

## 2026-11-25 rerun on current main

Base main `091b9cd5`, evidence head `f8569028`. Rows marked "rerun required" in the first table are updated as follows.

| Item | 2026-11-25 status |
|---|---|
| 19 §5.6 source mutants | pass: 19/19 killed on current main, re-bound to new source hashes ([evidence](2026-11-25-source-mutants.json)); the 5-G v2 protected-path mutant also killed |
| 10,000 live interleavings (invariants 1–4, 6) | pass, seed 51007 ([evidence](2026-11-25-property-runs.json)) |
| Invariant 5 constructor, 10,000 specs | pass, seed 51007 (same file) |
| F1 duplicate cycles / concurrent reconcilers | targeted rerun pass (4 CLI tests, plus the 10k `race` property). Limit: no test runs two live reconciler instances; one-child-per-head is asserted at the store and cycle level |
| F2 concurrent review around the second read | closed: `defers a concurrent approval until the next cycle stops for reviewer conflict`; mutant `second-read-uses-first` killed |
| F3 outsider push, three boundaries | closed: A `refuses an outsider head at precheck…` (mutant `precheck-ignores-remote` killed); B existing lease cases `stale`/`lease_rejected`/`lease_ancestor` (mutant `no-lease` killed in node 1); C `keeps a successful push uncertain when an outsider moves the remote before readback` (mutant `readback-ignores-remote` killed) |
| F4 head regression | targeted rerun pass (publication refusal plus cancellation; core decision tests). Limit: no live-reconciler test produces `head_regressed`; the property `regress` op is not coverage-gated |
| F6 PR closed | targeted rerun pass. Limit: the publication refusal cases do not separately assert zero git invocations (they refuse before the intent exists) |
| F8 crash between `host.recover()` and `revisionRecovery()` | closed: `confirms a pending push on restart after shutdown between recovery phases` (real ledger; first start leaves it pending with no push, second start confirms with no push); mutant `start-skips-revision-recovery` killed. K1–K6 and transaction-crash reruns pass |
| F9 token revoked 403 | targeted rerun pass, **with a deviation from the §5.6 wording**: a revoked token before release gives `failed`, but a released push failing with HTTP 403 and no structured pre-update proof stays `uncertain` (conservative). Owner decision M3 in `2026-11-25-bridge-5f-model-coverage.md` |
| TLA coverage of local-failure route and version 2 grant renewal | evidenced (bounded model): see [TLA model coverage](#2026-11-25-tla-model-coverage-5-f) below |

Node 2 evidence: [`2026-11-25-fault-injection.json`](2026-11-25-fault-injection.json) (head `613b51b5`). The two changed test files pass in full (201/201), and the CLI typecheck passes.

## 2026-11-25 TLA model coverage (5-F)

| Item | Status | Evidence |
|---|---|---|
| Live TLA model has no TLC counterexample, including the local-failure writer | evidenced on model `ee445be9` | `2026-11-25-model-checks.json`: bounded, main, local, rounds and shadow all pass with an empty queue |
| V2 grant renewal while a local repair is approved or unsettled | evidenced (model) | `RenewalSafety` holds; `renewal-skips-busy` mutant counterexample |
| Finding 10 (close keeps reason and reservations) | closed | close clears `stopReason` and voids reservations; `ClosedCleanup` holds |
| Model mutants | 19/19 counterexamples | five new: `local-overlaps-review`, `local-skips-round-cap`, `renewal-skips-busy`, `local-no-lease`, `local-fence-skips-close` |
| Limit | open | Bounded check only (`MaxLocalRepairs = 1`, two reviewers, two rounds). The race between the pre-intent PR read and the local push is modelled the same as on the review route. |
