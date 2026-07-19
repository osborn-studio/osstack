# Neat semantic parity evaluation report — 2026-07-18

## Release decision

**Auditable semantic hygiene beta: release candidate; public rollout requires
repository CI, an explicit production-provider live smoke, and the fixed
48-hour/20-success canary.**

**Khazix semantic parity claim: No-Go.** The product implementation and the
fail-closed evaluation toolchain are complete, but the required independent
hidden bundle, independent custody receipt, frozen primary/secondary model
IDs, isolated A/B adapter matrix, live production semantic credential, and
blind edit judgments were not available to this builder. Missing evidence is
treated as failure, not as a skipped gate.

## Frozen method

| Item | Commitment |
|---|---|
| A-arm source | `KKKKhazix/khazix-skills` commit `5a963d91f772e0d4f6659c43a36876a74c468143`, MIT |
| A-arm SHA-256 | `31ab2058d60664799af767e46c985a59025934315bee1b9c20d7ff442b0af687` |
| Protocol SHA-256 | `47c4a08e9a4eefd8e31ada70ab8a440f76ccb7d91add616074d5387884f2faf4` |
| Development manifest SHA-256 | `6fa17f87bbd3e996ac53a439946e3fd7bcfbfe82a1e4b7db57b70d15010a48c2` |
| Development tree SHA-256 | `caf788686b6f51853aa8ddb7a4c65a03d6d2001840b9a7b60e05a89fcf2a2855` |
| Corpus | 5 repository profiles, 30 cases, 120 defects; 40 natural-derived and 80 controlled seeds |
| Statistical gates | Case-cluster bootstrap 95% CI; recall/precision lower bound ≥ -0.05; edit-quality lower bound ≥ -0.25; alpha ≥ 0.67; semantic Jaccard median ≥ 0.80 and every dimension ≥ 0.70; systemic failure ≤ 5% |
| Hidden power floor | Paired-case normal approximation; α 0.05, target power 0.80, assumed case-difference SD 0.12, margin 0.05 → 46 cases / 184 defects |

The external runner requires fresh disposable copies, exact A/B model and
budget pairing, environment allowlists, isolation attestations, evaluation-only
B approval receipts, snapshot tree commitments, and label-free adapter output.
Raw diffs are separated into deterministic arm-free judge packets and private
unblinding keys.

## Executed evidence

| Gate | Result |
|---|---|
| Development corpus schema, provenance, secret scan, deterministic lock | PASS |
| Evaluator unit tests | PASS — 9 tests |
| C-arm real CLI runs | PASS — 60/60 executions; two per case |
| C-arm normalized bit-for-bit reproducibility | PASS |
| C-arm result SHA-256 | `439ec866d8fd06676b65ce21d057acc862a807f2bf3bbc72606d9e587fd55cf4` |
| Strict scorer rejects threshold changes and self-custody | PASS |
| Frozen A source hash | PASS |
| Hidden A/B semantic experiment | NOT ASSESSED — required external evidence absent |
| Downstream agent task experiment | NOT ASSESSED — hidden historical task custody absent; exploratory only and not used for the claim |

## Self-assessment bias and limitations

The implementation builder authored the development generator, runner, and
scorer, so development results cannot establish parity. Natural-derived cases
are sanitized reproductions rather than untouched private repositories. The
C-arm result proves mechanical reproducibility only. No inference about A/B
recall, precision, edit quality, semantic stability, or cost is made from the
absence of external runs.

The public claim may change only after a first, preregistered hidden run passes
every scorer gate without changing the protocol, thresholds, corpus labels, or
model IDs.
