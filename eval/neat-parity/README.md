# Neat semantic parity evidence gate

This directory contains the frozen, fail-closed evaluation protocol for the
`neat` semantic beta. It does not contain hidden labels or hidden repository
snapshots.

## What is already reproducible

- `corpus-lock-v1.json` commits the deterministic development corpus: 5
  repository profiles, 30 isolated cases, and 120 defect units.
- Arm A is frozen to Khazix `neat-freak/SKILL.md` commit
  `5a963d91f772e0d4f6659c43a36876a74c468143`, SHA-256
  `31ab2058d60664799af767e46c985a59025934315bee1b9c20d7ff442b0af687`.
- `pnpm eval:neat-parity:offline` executes arm C twice for every development
  case and requires byte-stable normalized findings.
- The scorer fixes the preregistered non-inferiority margins, random seed,
  bootstrap count, run counts, judge agreement, stability, and failure gates.

## Independent custodian workflow

1. The custodian creates a sanitized hidden execution bundle with at least 46
   cases and 184 independently frozen defect units, as required by the frozen
   paired-case power analysis. The execution manifest has
   `labels_included: false`; each relative snapshot path carries a tree hash.
2. Freeze `protocol-v1.json`: set `status` to `frozen`, record the complete
   primary and secondary model IDs, and record the hidden bundle SHA-256 before
   the first run. Never edit thresholds after this point.
3. Provide exactly four adapter manifests: A/B for each model family. A and B
   in a family must use the same complete model ID and budget. Adapter processes
   receive a disposable copy, no labels, a minimal environment, and either no
   network or a provider-only proxy attested by a party other than the builder.
4. Run the evidence preflight. A `no_go` result is expected until every external
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

5. Invoke `osstack-neat-eval run-external`. Adapters return structure-only
   findings; they never receive or return hidden defect IDs. The custodian maps
   findings to frozen labels after execution.
6. Invoke `osstack-neat-eval blind-diffs`. Give the arm-free packet to two
   independent model judges and keep the generated key private. A human judge
   resolves every disagreement and reviews a deterministic 20% sample of
   agreements.
7. The custodian assembles the strict hidden evaluation JSON and runs
   `osstack-neat-eval score`. Exit 0 is necessary for a parity claim; exit 3
   means the public wording must remain “auditable semantic hygiene beta.”

Logged-in general code agents are not acceptable substitutes for the isolated
`SemanticJudgePort`, independent hidden custody, or blind judges.
