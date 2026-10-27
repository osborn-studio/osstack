# J01/J11 validation record

Base rechecked: main `ce543535be9b1ef96a8c4fb14d13ea8483444051`. #271 is merged at that commit. Its diff from the original `daad404e` implementation base contains documentation only; schema remains 47. No production migration or default runtime feature was enabled.

## Deterministic verification

- Workspace build passed. Final workspace TypeScript checks passed (`pnpm typecheck:check`).
- All 22 package suites have passing results: **6,145 passed, 5 skipped** in the combined final coverage. Details: [test-summary.json](evidence/test-summary.json).
- Final protocol package: 455 passed. Final core package: 943 passed, including 12 executable recovery-spec tests. Final full CLI: 2,721 passed, 5 skipped.
- Existing and new JSON Schema drift checks passed. Generated body schemas remain shape-only; semantic refinements run through the decoder.
- Biome passed for all changed TypeScript files. Independent Python verification passed for six typed digest constructors and exact SQL/source/target catalog hashes.

Commands used after selecting Node 22:

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
export OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack
pnpm -r --workspace-concurrency=1 --no-bail test
pnpm --filter @osstack/knowledge exec tsc -b --force
pnpm --filter @osstack/cli test
pnpm --filter @osstack/protocol test
pnpm --filter @osstack/core test
pnpm typecheck:check
node packages/protocol/scripts/generate-schemas.mjs --check
node packages/protocol/scripts/generate-joint-schemas.mjs --check
python3 packages/protocol/scripts/joint-reference-vectors.py --check --recovery-root packages/core/fixtures/operator-recovery
```

The full workspace was not one uninterrupted all-green invocation. Earlier runs are retained:

1. Default Node 26.5.0 rejected an existing GitHub test's `stripTypeScriptTypes({mode:'transform'})`. Switching to CI's Node 22 resolved this.
2. A concurrent workspace run timed out in an existing Loop test. The individual retry and all 515 Loop tests passed with reduced package concurrency.
3. The first serial CLI run used restored tracked `knowledge/dist` files that lacked exports present in source, and the default macOS temporary root failed canonical-path checks. Forced knowledge rebuild and explicit canonical SSD scratch root fixed the environment. The entire CLI suite was rerun, not just selected failing tests. No unrelated product code was changed to hide these failures.

The final protocol/core reruns cover the audit revisions. Other package suites use unchanged product code. Hosted CI must validate the final PR commits in a clean checkout before merge.

## Audit and remaining limits

Sonnet 5.5 round 1 returned REVISE. Original opinions and exact inputs are preserved under [evidence](evidence/), with host dispositions in [audit-disposition.md](audit-disposition.md). The fourth, complete focused review returned PASS. Round 2 was incomplete and was not accepted as approval; round 3 required additional safety-negative coverage. All raw responses and model metadata are preserved. Product code was unchanged after the final review; the host added the missing OR IGNORE/DO NOTHING variants for the future templates (the model had overgeneralized that coverage) and reran the SQL suite.

No synthetic test proves provider qualification, independent human identity, real process containment or production crash durability. J12 still owns authenticated proof loading, maintenance ownership, original subject/accounting CAS, actual WAL/FULL process-kill tests and deployment fencing. J17 owns the broker ledger and broker orphan recovery. Five live/qualification tests remain skipped by their existing opt-in guards.

J11 pins a candidate schema/DDL, not a deployed recovery build. Any source schema, catalog, DDL, fixture, candidate or build change invalidates the applicable recovery evidence. PRs remain subject to CI and dependency ordering; this record does not authorize merge or enablement.

Submitted PRs: #272 (`91147f7a`, codec), #273 (`fad0dd45`, contracts), and #274 (recovery specification/evidence). They form a stack; hosted CI and ordered review remain required before merge. No PR was merged by this task.
