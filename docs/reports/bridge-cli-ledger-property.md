# Production ledger auditor property evidence

Date: 2026-11-07. Worker: `gpt-6.1-sol`. Source baseline: `75c007667eccd0b24384338cf4f4d4d12848d2de`.

## Scope and result

Added `packages/cli/src/contained-mission-bridge-ledger.property.test.ts` and this report only. The focused suite passes: **6 tests, 144 generated cases**, seed `61107`, one worker. Final test execution took 5.188 seconds; total Vitest duration was 6.14 seconds. No runtime or existing test file changed.

The suite invokes production `verifyBridgeLedger`, `recoverBridgeLedgers`, and `compareBridgeLedgerRange`. The rig uses real SQLite databases, migrations, `RevisionChainStore`, `ContainedMissionStore`, and `HostProcessStore`. Remote reads are injected in memory. No GitHub, credentials, git push, daemon, service, or default control-plane home is used.

## Oracle and bounds

Generate a chronological history before creating receipts. Partition that history into one to three nonempty ranges, each with three to six commits. Give receipts a generated storage permutation. Commit identifiers use either 40 or 64 hexadecimal characters and a bounded numeric offset. The remote oracle retains the original history; it never reconstructs expectations by concatenating stored ranges or by following the auditor's ancestry walk.

The pagination property generates 101–205 commits to require two or three pages. Each of the six properties runs 24 cases. Iterations cannot increase through a global environment variable. `OSSTACK_LEDGER_PROPERTY_SEED` accepts an explicit signed 32-bit seed for replay. The default is `61107`. Fast-check reports the seed, shrink path, and counterexample on failure.

The fixture computes receipt digests only to encode valid input. No assertion checks a digest against a duplicate implementation. A stored foreign range is checked both with a corrupt binding and with a recomputed, internally consistent binding. Both must fail against the independent remote history.

## Covered contracts

| Property | Required result |
| --- | --- |
| Valid ancestry with shuffled receipt insertion order | `matched` |
| Adjacent commit reorder, replacement by a foreign commit, foreign insertion, omission, or duplication with the original tip retained | `external_write` |
| Correct history with a different remote tip | `external_write` |
| Pending, failed, uncertain, or missing baseline receipt | `external_write` |
| Corrupt or internally consistent foreign stored range, broken old-head links, or missing range event | `external_write` |
| Pending or uncertain receipt whose proposed head is the remote tip | `reconciliation_incomplete` |
| Unreleased unsettled receipt at a different head, beside an otherwise complete audit | `matched` |
| Released pending or uncertain receipt | `reconciliation_incomplete`, before either remote read |
| Startup recovery with that released receipt | Preserve the prior chain row and `grant_expired` reason; do not cancel a child |
| Chain revision or receipt fingerprint changes during the compare read | `stale` |
| Complete generated two/three-page range | `matched` |
| Truncated second page or read outage during audit and startup recovery | Throw the read error; preserve the chain row |

Deferred receipts are asserted with exact `reconciliation_incomplete` equality. They are not counted as a successful audit. Throwing read/cancel dependencies ensure the released-receipt branch does not perform those actions.

## Fixture boundary

These are restored/corrupt snapshot tests, not publication-write tests. Fixture setup drops six named guards **only in each disposable SQLite database**: `engineering_intent_insert`, `engineering_intent_push_binding`, `engineering_intent_fixed`, `engineering_intent_transition`, `engineering_intent_no_delete`, and `engineering_chain_events_no_delete`. This permits shuffled historical receipts, missing evidence, immutable-field corruption, and receipt-state mutations. Remaining constraints and all auditor reads use the production schema/store. The suite does not prove that these adversarial rows can pass the production publication fences.

Host-process journal creation, registration, and release use the real store with a separately authorized nonterminal child Mission. They record synthetic process metadata and start no process. Every property closes its rig in `finally`; fixture-construction errors also close an acquired rig.

## Checks and preserved failures

No full-monorepo build, test, or typecheck ran. Full acceptance belongs to the parent workflow.

1. `pnpm install --offline --frozen-lockfile --ignore-scripts` — failed with `ERR_PNPM_NO_OFFLINE_TARBALL` for `@edgeone/pages-blob@0.0.12`.
2. `pnpm --filter @osstack/cli... install --offline --frozen-lockfile --ignore-scripts` — passed; 17 of 23 workspace projects selected.
3. Standard focused command below — failed before collection because this clean worktree has no built `@osstack/core` entrypoint. Zero tests ran. No package build was started.
4. Focused command with the temporary source-alias config — collected six tests, all failed at fixture setup because the SQLite native binding was missing. Seed `61107`; minimal range counterexample was `sizes=[3], offset=1, width=40, order=[0]`; pagination shrank to `[101,40]`.
5. Native dependency setup: root `pnpm rebuild better-sqlite3` commands returned without producing the binding; the attempted `--ignore-scripts=false` rebuild option was rejected as unknown. The corrected package-scoped command below completed the dependency install step. It warned that the unrelated unbuilt `osstack-loop` bin target was absent.
6. After dependency setup, all six properties failed at fixture insertion with `intent_insert_denied`. The restored-snapshot fixture was corrected to explicitly remove the six scratch guards listed above.
7. Next focused run — five passed; the deferred property failed with `host_process_launch_denied`, seed `61107`, path `0:0:0:0`, on a pending receipt with the minimal range above. The fixture had attached the journal to the terminal root Mission. The fixture was corrected to authorize a separate child Mission.
8. First complete passing run — **6 passed, 0 failed**, 24 generated cases per property, seed `61107`, 4.824 seconds in tests. Review then found that the compare test double ignored its input target. The fixture now rejects unexpected compare targets; the paging property forwards the auditor's actual arguments to the production range reader and checks the requested endpoint. The final run of that change also passed all six tests (5.188 seconds). The suite assertions were retained; no timeout was increased and no test was skipped.
9. `pnpm exec biome check packages/cli/src/contained-mission-bridge-ledger.property.test.ts` — passed, one file, no fixes.
10. `git diff --check` — passed.

Standard focused command, for an environment with built workspace entrypoints:

```sh
env OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack \
  OSSTACK_HOME=/Volumes/AIMATE_WORK/tmp/osstack/ledger-property-home \
  pnpm --filter @osstack/cli exec vitest run \
  src/contained-mission-bridge-ledger.property.test.ts --maxWorkers=1
```

Native dependency setup command used cached headers and a single compiler job:

```sh
env npm_config_build_from_source=true \
  npm_config_nodedir=/Users/osborn/Library/Caches/node-gyp/26.5.0 \
  npm_config_jobs=1 pnpm --filter @osstack/cli \
  --config.ignore-scripts=false rebuild better-sqlite3
```

The final run used the standard focused command plus:

```text
--config /Volumes/AIMATE_WORK/tmp/osstack/bridge-cli-ledger-property/vitest.config.mjs
```

That temporary config imports this worktree's existing CLI Vitest config, preserves its setup files and timeout, and maps exact workspace package names to this worktree's `src/index.ts` files. It does not replace auditor/store implementations. Config and passing-run evidence are retained under `/Volumes/AIMATE_WORK/tmp/osstack/bridge-cli-ledger-property/` (`vitest.config.mjs`, first passing output `focused-test.log`, final command/result summary `focused-test-final.log`). They are scratch artifacts, not repository changes. Runtime was Node `v26.5.0`, Vitest `3.2.6`, fast-check `4.10.2`.

## Limits and findings

No production P1/P2 was discovered. The recorded failures were dependency/setup failures and two fixture errors, with repro details above. Bounded generation is not exhaustive verification. This suite does not cover live GitHub compare behavior, credentials, publication dispatch, process survival, all pagination limits, or every malformed schema. It does not establish CLI startup, typecheck, model-review, CI, sandbox end-to-end, or full acceptance gates.

The canonical `.cursor/skills/verify-osstack` excludes contained Mission bridge publication internals; no duplicate verification skill was added. The production gate remains CLOSED. Shared cloud Bots and the paused PR Reviewer gain no capability evidence from this suite. No publishing, deployment, remote messages, GitHub settings changes, or PR action occurred.
