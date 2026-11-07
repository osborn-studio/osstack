# Final bridge verification integration

Latest controller evidence and remaining acceptance gates are recorded in [Bridge controller acceptance — 2026-11-07](2026-11-07-bridge-controller-acceptance.md). The historical integration facts below are preserved as recorded.

This node assembles independently reviewed runtime and verification work on
`codex/bridge-final-verification`, based on main `9e2eaf9c`. It does not deploy,
execute the real sandbox, change Bot configuration, or open a serving database.
The normal production acceptance gate remains closed.

## Composition

Main was fast-forwarded to N9 `88fa686b` (runtime source `1503f6ac`), then merged
N13a `f28f3c1a`, then guardfix `b5133e53`. These merges were clean. Phase evidence
`d3498aa8`, extra-repair positive/mutant coverage `9db4ad02`, and independent
production-ledger properties `5699e884` were selected as `d082de5b`, `d4b1d843`,
and `63e6bc47`. Source at the start of the checks below was `63e6bc47`.

The driver branch already contains activity evidence, readiness, cold child-process
restart, publication hooks, installed-runtime selection, the nine-file CI offline
job and actual-product fixtures; these were not duplicated. Historical source
extraction/VM adversarial tests from `71ba6c17` are absent. No `.agents` or
`.cursor` net change was introduced, including no reversal of the existing
verification skill. Bot handoff documents remain a separate node.

## Runtime preservation

[The runtime manifest](bridge-phase5-verification/integrated-runtime-manifest.json)
compares all 607 tracked non-test package source TypeScript files against N9
`88fa686b`, excluding test/fixture/testkit files: zero byte differences. The only
package deltas beyond N9 are tests and the fast-check development dependency.
Runtime files added by N9 remain present; no new non-test package source appears
in the verification delta. CLI entrypoints and package index import surfaces
have no verification-node delta. This manifest proves equality, not runtime
acceptance or full test coverage.

## Executed deterministic checks

All commands below completed locally on the integrated source. No full monorepo
test was run; that remains the parent controller's freeze-and-test step.

| Check | Result |
|---|---|
| `pnpm install --offline --frozen-lockfile --ignore-scripts` | pass; cached dependencies, no lock delta |
| `pnpm --filter @osstack/cli... build` | pass for CLI and its dependency closure |
| `pnpm --filter @osstack/cli... typecheck` | pass for that closure |
| Nine exact offline Node files from the CI job | 218/218 pass, 0 skipped; no network or sandbox execute |
| CLI production-ledger property and spec-constructor property files, maxWorkers1 | 8/8 pass (six ledger properties at24 generated cases each; constructor default1000), 0 skipped |
| `node scripts/generate-inventory.mjs --check` | inventory fresh |
| `node scripts/check-changeset-coverage.mjs --base 9e2eaf9c` | pass, two release-sensitive packages covered |
| Biome on changed package TypeScript paths | 34 processed, 0 errors; one existing optional-chain style warning in check retry |
| Local documentation links across changed Markdown | 23 links resolved before this report; final audit repeated at handoff |
| `node --check` on every changed mjs script | 20/20 pass |

The saved final-property10k evidence remains bound to its original launch head
`f7f0615a` and source hashes. Current CLI/core property sources match those hashes
(`10a75a3047c03685e2b94ab45a78bf5c4704d27e097f3724a264d3c17601ac4f`
and `add72f411d69aab16eba40258289a7e6635cb8b12b22f82b8a4d92ff918d7cf8`).
This integration did not re-run or relabel the historical10k campaigns, source
mutation campaign or TLC processes. N9's publication149 and real cross-process
SQLite lock regression were run on N9 source1503 and preserved byte-for-byte;
they are historical evidence here, not a claim of a new full suite run.

The actual-product47 fixture cases recorded by the driver owner are separate
from the218 offline Node cases and were not re-executed here. They require an
explicit inactive installed runtime prefix; silently falling back to this dev
checkout would not be equivalent.

## Publication handoff

PR base must be main. While the independent nodes are open, the body must contain
`merge after #421` and `merge after #422`; remove each edge if it is already
merged before publication. The parent owns final GLM review, the frozen full
suite, push and PR creation. Prepared integration is not authorization to execute
GitHub sandbox mutations or deploy.

## Final documentation closure and freeze

Phase owner's single final docs commit `2bc45ac3` was selected as `6182966d`.
Only the progress page conflicted with newer integration history. The resolution
keeps the newer runtime/PR state, adds completed TLC/property/mutation facts and
updates next steps; it does not restore old missing report links or obsolete
pending TLC instructions. No source, model or test changed after `63e6bc47`.
The final audit resolves24 relative documentation links and reconfirms all607
runtime SHA256 entries. `git diff --check origin/main...HEAD` passes.

Recorded completed broad TLC runs are main69,290,566 distinct/depth48 and
rounds95,121,536 distinct/depth46, queue0/exit0. They were not rerun here. The
phase owner's source-bound two10k property campaigns,19 source mutants and14
model mutants remain separate records. Completing those local gates does not
complete Phase5: real5-G sandbox acceptance is still pending. The final driver's
new GLM reviews and the frozen-tree full monorepo suite belong to the parent;
this report does not predict their verdicts.

Final PR remains main-base with merge after #421 and merge after #422 while
those PRs are open. The runtime manifest binds N9 exactly; this document closure
adds no production capability or approval.
