# Neat semantic parity evidence gate

This directory contains the fail-closed evaluation protocols for the `neat`
semantic beta. It does not contain hidden labels or hidden repository
snapshots. The original July 18 files remain an immutable historical snapshot;
future hidden runs use the v3 rebaseline files whose names end in `-v3.json`.

## What is already reproducible

- `corpus-lock-v1-v3.json` commits the active deterministic development corpus:
  5
  repository profiles, 30 isolated cases, and 120 defect units.
- Arm A is frozen to the six-file Khazix `neat-freak` v3 runtime bundle at
  commit `2b4a645cfdc894156ae347d897723562f719ce95`, bundle SHA-256
  `e77e30e39e67f05d3159548605057d396794d1bde20bd59a070670e109c3d904`.
  `khazix-neat-freak-v3-baseline.json` records every file, byte length, mode,
  and content hash. Upstream `neat-freak/evals` is intentionally excluded to
  keep evaluation fixtures out of arm A.
- `pnpm eval:neat-parity:offline` executes arm C twice for every development
  case and requires byte-stable normalized findings.
- The scorer fixes the preregistered non-inferiority margins, random seed,
  bootstrap count, run counts, judge agreement, stability, and failure gates.

## Independent custodian workflow

1. Fetch and verify the committed runtime bundle into the default evidence
   cache:

   ```bash
   pnpm --filter @osstack/neat-eval build
   node packages/neat-eval/dist/cli.js baseline fetch \
     --output .osstack/eval-cache/neat-freak-v3-2b4a645
   ```

2. The custodian creates a sanitized hidden execution bundle with at least 46
   cases and 184 independently frozen defect units, as required by the frozen
   paired-case power analysis. The execution manifest has
   `labels_included: false`; each relative snapshot path carries a tree hash.
3. Freeze `protocol-v1-v3.json`: set `status` to `frozen`, record the complete
   primary and secondary model IDs, and record the hidden bundle SHA-256 before
   the first run. Never edit thresholds after this point.
4. Provide exactly four adapter manifests: A/B for each model family. A and B
   in a family must use the same complete model ID and budget. Adapter processes
   receive a disposable copy, no labels, a minimal environment, and either no
   network or a provider-only proxy attested by a party other than the builder.
5. Run the evidence preflight. A `no_go` result is expected until every external
   artifact is present:

   ```bash
   pnpm eval:neat-parity:doctor -- \
     --hidden-bundle /custody/hidden-execution.json \
     --custody-receipt /custody/receipt.json \
     --adapter /custody/a-primary.json \
     --adapter /custody/b-primary.json \
     --adapter /custody/a-secondary.json \
     --adapter /custody/b-secondary.json
   ```

6. Invoke `osstack-neat-eval run-external`. Adapters return structure-only
   findings; they never receive or return hidden defect IDs. The custodian maps
   findings to frozen labels after execution.
7. Invoke `osstack-neat-eval blind-diffs`. Give the arm-free packet to two
   independent model judges and keep the generated key private. A human judge
   resolves every disagreement and reviews a deterministic 20% sample of
   agreements.
8. The custodian assembles the strict hidden evaluation JSON and runs
   `osstack-neat-eval score`. Exit 0 is necessary for a parity claim; exit 3
   means the public wording must remain “auditable semantic hygiene beta.”

Logged-in general code agents are not acceptable substitutes for the isolated
`SemanticJudgePort`, independent hidden custody, or blind judges.

## Built-in production semantic providers

`osstack neat semantic` accepts two fixed no-tools judge profiles. A profile
is ready only when both its credential and complete model ID are present:

| Judge ID | Credential | Model ID | Endpoint scope |
|---|---|---|---|
| `anthropic-no-tools` | `ANTHROPIC_API_KEY` | `OSSTACK_NEAT_ANTHROPIC_MODEL` | Anthropic API |
| `deepseek-no-tools` | `DEEPSEEK_API_KEY` | `OSSTACK_NEAT_DEEPSEEK_MODEL` | DeepSeek API |

The recommended explicit model ID for the first DeepSeek canary is
`deepseek-v4-pro`. Model IDs remain environment-owned so a
provider alias change cannot silently alter the cache fingerprint or evaluation
record.

The DeepSeek endpoint is fixed in the trusted provider registry;
repository configuration cannot supply a Base URL. The doctor passes the
`production_semantic_provider` check when at least one profile is complete and
reports partial configuration only by variable name, never by value.

The DeepSeek provider also requires the response model identity to match the
requested model string. A mismatch fails closed before the semantic decision
is accepted or cached.

Before invoking a canary from the terminal where the credentials are already
loaded, configure the corresponding immutable model identity:

```sh
export OSSTACK_NEAT_DEEPSEEK_MODEL=deepseek-v4-pro
```

Build once, then invoke DeepSeek through the disposable live-smoke
runner. A receipt path must be absolute and must not already exist; the runner
creates it with mode `0600` and never stores raw findings or credentials.

```sh
pnpm --filter @osstack/cli build
node scripts/smoke-neat-semantic-live.mjs \
  --provider deepseek-no-tools \
  --receipt /tmp/osstack-deepseek-live-smoke.json
```

For a live smoke, use a disposable sanitized repository with ConfigV2
`semantic.enabled: true`, invoke one profile explicitly with `--judge`, retain
the JSON ReportV2 in a private location, and verify that requested coverage is
neither `failed` nor `not_assessed`. A live smoke is integration evidence only;
it does not replace the independently held hidden A/B experiment.
