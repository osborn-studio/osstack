# CI cost controls: first-version task plan

Status snapshot: source implemented; local code integration and review complete; final documentation and draft publication in progress, 2026-10-06. Current publication/CI status is recorded in the resulting draft PR; the source snapshot is not a live acceptance ledger. These changes are draft candidates. No measured saving, production rollout or product acceptance is claimed.

## Approved scope and boundaries

The approved first version contains exactly three changes: platform/toolchain/lock-scoped dependency download caches; explicit local validation → candidate commit → complete final verification stages with bounded related batches; and evidence reuse only when the current repository, commit, base, environment, policy and test fingerprints match, with fresh mandatory CI checks.

Preserve the organization's Actions $100 budget and usage-prevention setting. Do not change branch protection, permissions or security review. Do not merge these cost PRs, publish a new osstack version or switch Wiki's fixed runtime in this task. Do not operate the Vox development checkout. OSVox cost metadata informed diagnosis; it does not authorize editing that product.

Wiki development remains active at 13 accepted units out of 77. Cost controls neither sign task receipts nor qualify Provider, WB02, native platforms, G0 or production deployment.

## Ownership and working branches

All three tasks are integrated by the existing Wiki development session (`/root`). No separate execution chat was created. Subagents are bounded implementation/review workers, not independent release controllers.

| Task | Implementation owner | Independent reviewer | Branch and current status |
| --- | --- | --- | --- |
| Dependency caches | Wiki integrator `/root` | `/root/acceptance_schema`, actual Claude CLI Sonnet 5.5 | Wiki `codex/ci-dependency-cache-reviewed`, commit `87baa1a818bb0131329ed4cb158d5090ed5d33e8`, [draft PR #34](https://github.com/osborn-studio/osborn-wiki/pull/34). Documentation is included at PR34 head `e6ee6063a58190b449ec277964b770b19a276ea0`; required exact-head CI pending completion. |
| Stages and bounded batches | `/root/next_tasks` | `/root/provenance_check`, integrator; actual Sonnet 5.5 code v2 approved | osstack delivery `codex/ci-candidate-cost-controls-reviewed`, baseline `8b2419a45b17cfdc2f85c9c3416f92b11fcfa201`; seven-file repair candidate passed 434 author tests on Node 26.5.0; final main-range scope and truncated-list/batch-state defects repaired; independent Node24.21 qualification passed 434/434, and actual Sonnet5.5 code v2 approved. Integrated code commit `27c21488ddd2367057310ee6a095655033be0b0d`; draft publication pending. |
| Exact-bound evidence reuse | `/root/provenance_check` | `/root/acceptance_schema`, integrator; actual Sonnet 5.5 code v2 approved | Same osstack branch; four-file source candidate implemented. Fresh main-based author verification: 78 GitHub tests (38 delivery tests) passed with Node 24.21.0 and type checks; independent final review and actual Sonnet5.5 code v2 approved. Same integrated code commit; draft publication pending. |

The osstack source worktree started at local `b476bcc3` but is being migrated to freshly verified main `8b2419a`, preserving its lifecycle lease, contained executor and unconfirmed-execution guards. The original audit rejection and failed-attempt logs are retained; they cannot qualify the repaired candidate. Source checkout and installed runtime are distinct. Wiki still uses the fixed e28927d / 0.19.0 release; these new APIs are not active there.

## Task 1: dependency download caches

Modify only Wiki `.github/workflows/ci.yml` in the current code slice. Keep setup-node automatic package-manager caching disabled because the project uses Yarn 4 and automatic probing previously interfered with it. Explicitly cache only npm `_cacache`, not installed trees, logs, credential files, PnP/install state or build products. No Yarn cache is enabled in this first version.

The key includes runner OS and architecture, actual Node/npm versions and four frozen lockfile hashes. No restore-prefix keys or cross-OS archives are configured. GitHub's own primary-key prefix semantics still apply; the full fixed-length hashes prevent this workflow's different-lock keys from being prefixes of one another. Every `npm ci`, immutable Yarn install and test continues to execute. Unsafe/unavailable cache metadata disables caching; cache-action errors cannot suppress the installation or tests.

Acceptance for this code change: unchanged original job graph, triggers, timeouts, concurrency and test commands; metadata positive/negative behavior; all four required CI checks on the exact candidate. A draft is not an acceptance receipt.

Evidence obtained: controller's 20 local semantic/actual Node24 checks, independent metadata/path review, actual Sonnet 5.5 candidate and publication review, and actual isolated osstack 0.19 apply/verify/commit cycle. Warm cache hits, actual Windows caching behavior and cost savings remain to be measured. This task retains all required CI: verify, windows-distribution, journal-native, web-admission.

## Task 2: validation stages and bounded batches

Implement opt-in LoopEngine candidate policy with persistent records. Defaults must preserve the existing flow. Tasks in one batch must share explicit scope/branch/batch identity and environment/policy/test bindings, stay within a configured task bound, and each pass local commands and all configured structured evaluations and independent review before isolated commit/integration. The generic API preserves configured gates; it does not itself require every caller to configure an independent reviewer or prove that supplied final commands cover a repository's complete gate. A controller must define complete final commands, require structured evaluations and independent review, and compute current fingerprints independently. These values are supplied controller bindings, not independently discovered environment attestations or signed receipts. Wiki continues to require actual Sonnet auditing separately. Validate the complete discovered batch; do not declare a filtered subset complete.

Check the task-start-to-candidate committed range as well as dirty/untracked changes, so an executor cannot hide an out-of-scope file by committing it first. Freeze final HEAD/tree/branch, run prepush and full final local verification, and reject any source mutation or missing/failed artifact evaluation. Each batch ID is a durable one-shot claim, including failures; different task tuples cannot share its state. Recovery requires controller reconciliation and a new approved batch identity, not automatic replay or deleting a claim. Keep records in private owner-controlled storage; records must not be credentials or acceptance receipts. The first opt-in API is programmatic LoopRunOptions; the current installed Wiki CLI is not switched or newly wired. Private state ownership is currently qualified for POSIX owner checks, not Windows ACLs. Final local preflight explicitly reports remote CI pending. Mandatory remote CI must still qualify the actual final commit.

Acceptance: meaningful default-compatibility, stage ordering, batch/tuple/scope bounds, committed-range mutation, private storage, stale HEAD, failed/missing evaluation and final-source mutation tests; package/type checks and original lifecycle regressions; independent Sonnet review. Do not weaken fixtures or timeouts to make the new policy pass.

## Task 3: exact-bound evidence reuse

Implement paired candidate evidence and independently current controller context. Bind repository, head/base SHA, environment/policy/tests fingerprints, required-check policy and bounded observation age. The hint is neither a signed receipt nor proof of cached CI success.

Matching hints may omit redundant push/watch only after fresh remote and PR identity checks. Actual current protection and every required CI result must still be read; missing, pending, failed, cancelled, duplicate, stale or mismatched results reject. Recheck scope and remote bindings before the existing SHA-bound merge operation. Tests intercept external delivery commands; this implementation task does not invoke a real automatic merge.

Acceptance: unchanged default delivery behavior; correct same-binding behavior; rejection of different SHA/base/environment/policy/test fingerprints, missing evidence, stale timestamp, changed protection and remote/PR races; full package/type checks and independent Sonnet review. Loop and GitHub evidence schemas are separate types; callers must not treat one as the other or infer a conversion. Repeated configured reviews may increase local/model cost; no savings are claimed. The controller must supply independently computed current fingerprints; copying an old hint into both arguments does not establish their provenance.

## Remaining delivery and verification

1. Complete: main-based scope/batch/lifecycle fixes, exact code freeze, independent review, actual Sonnet v2 audit and isolated osstack code integration.
2. Complete: consistent private dependencies, all non-Loop workspace suites (3,939 passed, 3 existing skipped) and full Loop suite (434 passed), Node24.21 build/type checks, plus isolated build/GitHub/Loop/type checks. Preserve failed attempts; no single initial parallel whole-suite success is claimed.
3. Code review and actual `claude-sonnet-5-5` code audit complete. Review this updated Markdown and publication materials before publishing the draft.
4. Create an osstack draft PR containing the finite implementation, tests, changeset and this plan. Record its exact commit and CI; do not merge or publish a release.
5. Observe Wiki draft PR34's exact-head required CI. Cache hits and baseline-versus-candidate timings are separate future measurement, not assumed savings.
6. Resume the existing Wiki backend packaging, initialization/lifecycle binding and finite local SDK work. PR32 and PR33 have all four exact-head CI checks successful; both remain draft, and source-only limitations remain.

Node24.21 full-workspace build and type checks passed. Workspace suites were qualified as non-Loop suites plus the full repaired Loop suite: 4,373 passed and 3 existing skipped. Initial parallel/package-serial attempts had unchanged process-lifecycle/controlled-session timing failures; failed logs are retained. Final serial runs preserved every assertion and timeout. The isolated reviewed-code integration separately passed build, GitHub 78, Loop 434 and all workspace type checks. CLI startup medians were 28ms for version and 92ms for help against unchanged 150/500ms local budgets; incremental new-module imports after existing Zod loaded measured 6.1/0.7ms. No savings or target-platform acceptance follows from these results.

Some early diagnostic errors may retain the claim without writing a failed-stage record or state file; they reject ready and require controller reconciliation. Do not claim every exception produced a terminal diagnostic.

The plan and PR status must be updated with actual results after they occur. Pending tests, audits, PRs, runtime cutover and savings must never be marked complete in advance.
