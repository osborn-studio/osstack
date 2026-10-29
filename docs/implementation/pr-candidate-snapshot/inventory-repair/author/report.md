# PR307 inventory freshness repair

**Only `docs/inventory/PUBLIC_EXPORTS.md` needs synchronization for the confirmed failure.** At head `24bed464c321c5396f59adecaf72c116569ca768`, CI40928407347 passed Lint and Build, then `node scripts/generate-inventory.mjs --check` reported exactly that one stale file and exited1. Later checks were not run.

The GitHub barrel adds a multiline public export block. The generator has not changed: it selects only source lines beginning `export `. Therefore its exact expected change is one added `export {` line under the GitHub section. The scratch diff reproduces that filter against the fixed Git objects. This is a known limitation of the existing inventory format, not a reason to hand-edit a different symbol list or expand this repair into a generator rewrite.

Run in root's already-built candidate checkout with Node22 and an explicit scratch `OSSTACK_HOME` (the generator calls built CLI `--help`):

```sh
node scripts/generate-inventory.mjs
git diff -- docs/inventory
node scripts/generate-inventory.mjs --check
```

The command computes all three inventories; it has no single-file generation flag. It writes only changed contents. Expect only PUBLIC_EXPORTS.md to differ; PACKAGE_GRAPH.md and CLI_COMMANDS.md should be unchanged. Confirm the actual diff and check result, then commit only the generated file. No source/CI/package modifications or full-suite rerun are needed for this one-file synchronization; remote CI still must finish on the new head.

This report ran no generator, build, tests, models or live forge calls, created no worktree, and modified no repository files. It binds exact source and the already-retained CI log. Root owns actual generation and PR update.
