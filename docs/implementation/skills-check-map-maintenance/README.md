# Maintain the fixed skills-check map

Compare a separately maintained expectation map with a fresh, real five-case journey. The command uses the existing `runJourney` verifier. It does not change the map, product code or existing evidence.

## Run

Use the actual target checkout with its supported Node version, installed dependencies and current build. In a fresh checkout, run `pnpm install --frozen-lockfile` and `pnpm build` first and keep their logs. Do not restore generated files until verification ends. Set `OSSTACK_SCRATCH_ROOT` to an absolute owned scratch directory and create its `runtime/` parent. The output directory itself must not exist.

From that checkout, substitute your owned absolute paths:

```sh
node scripts/maintain-skills-check-map.mjs --map /owned/path/map.json --output /owned/scratch/runtime/map-pass-001
```

The supplied [map.json](map.json) is a starting map, not proof of a run. Copy it to an owned location before making a maintenance correction. The command reads the map before driving and compares its bytes again afterward. It saves the initial bytes as `map-before.json`. It runs only the existing fixed full journey under `journey/` and adds `maintenance.json`. Keep invocation stdout/stderr separately. Both the successful and failed journey records survive fixture cleanup.

## Map and result

The map is a regular, non-symlink UTF-8 JSON file of at most 64 KiB. Its closed object has `schema_version: 1`, `target: "skills-check-full"`, and `features`. Each row contains exactly `case_id`, `expected_product_exit` (integer 0–255), and `expected_product_status` (`healthy`, `failed`, `drift`, or `empty`). Exactly one row is required for each of `healthy`, `missing-ref`, `drift`, `mixed`, and `empty`. Row order is not significant. Missing, duplicate and unknown case IDs are invalid; no drive starts for invalid input.

- Exit **0**, `consistent`: all five cases passed the existing behavior/evidence/cleanup checks and all map values agree.
- Exit **1**, `mismatch`: the complete verified journey differs from at least one well-formed map expectation. Inspect `rows` before deciding what needs correction.
- Exit **2**, `blocked`: input/output refusal, a failed or incomplete journey, unknown required cleanup, unreadable evidence, or changed map bytes. A preflight refusal creates no owned output. A failure after acquisition keeps its available evidence.

`empty` has product exit 0 and status `empty`; it is not a healthy-source observation. Expected source failures and drift keep their original product exits and statuses. Driver exit 0 means that the expected observation was verified. The existing journey validates raw semantics, source counts, refs, blessed/current SHAs, source/build records and fixture cleanup. This command does not replace those checks with exit-only comparison. Failed, `not_run` and unknown states stay in the original journey and cannot produce a complete maintenance pass.

`failure` preserves the first maintenance failure; `subsequent_failures` lists later errors, including map closeout failures. Partial `journey` fields are the returned observations, not success claims: inspect overall status, `receipt_matches_returned` and nullable hashes. A missing manifest cannot erase earlier journey details. `execution_path` states whether normal `runJourney`, an injected journey, or an injected driver was used. The last two are programmatic test seams, unavailable through this CLI, and do not prove real product execution. This marker is a declaration, not identity authentication.

## Correct a map with evidence

A discrepancy does not identify its cause. Inspect the relevant current source, governing expectation and raw journey first. Classify documentation drift, harness gap, product regression or unknown. Do not bless a broken product by changing its expected result. Keep the earlier map snapshot and failed comparison. For a confirmed correction within the authorized map scope, edit that map and rerun the same command with a new output directory. Do not reuse or overwrite the failed output.

The bounded maintenance demonstration uses an explicitly injected stale expectation: `missing-ref` expects product exit 0. The real fixed negative returns 1. Only that map cell is corrected to 1 before a fresh repeat. This is a test of maintenance, not a new product defect. Consult the release evidence for actual execution results; this recipe alone makes no run claim.

## Limits and source

Agreement covers these five local fixture cases only. It does not complete source review, discover unmapped project features, authenticate evidence producers or qualify a native host/model. Source/build bindings retain the existing journey's declarations; build hashes do not prove compilation. Map hashes are before/after snapshots, not a concurrent-writer lock. Direct-child exit and fixture absence do not attest all descendants. No watcher, scheduler, network provider, automatic correction or new method is added. The tool does not need the packet projector or PR305.

This fixed maintenance slice adapts index reconciliation, live re-proof and failure preservation from Lauren Tan's MIT-licensed [pstack maintain-verification-skill](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/maintain-verification-skill/SKILL.md). It uses OSStack's existing [maintenance method](../../../osstack-methods-skill/references/maintain-verification.md) and [full journey](../../../scripts/method-verification-journey.mjs). It does not implement pstack's complete general-project maintenance lifecycle.
