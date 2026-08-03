# Neat semantic parity v3 rebaseline — 2026-08-03

## Decision

**Khazix v3 semantic parity remains No-Go.** The A-arm source is now current,
complete, reproducible, and ready for an independent hidden run. No hidden A/B
experiment has been executed, so this rebaseline does not establish parity.

The July 18 single-file baseline is retained as a historical preregistration.
It predates neat-freak v3 and never produced hidden A/B results, so upgrading
the A arm before the first hidden run does not discard or reinterpret evidence.

## Active A-arm commitment

| Item | Commitment |
|---|---|
| Official repository | `KKKKhazix/khazix-skills` |
| Version and commit | `neat-freak` v3.0.0, `2b4a645cfdc894156ae347d897723562f719ce95` |
| Runtime scope | `SKILL.md`, four `references/*.md` files, and `scripts/audit-inventory.sh` |
| Excluded scope | `neat-freak/evals`; these fixtures are not runtime dependencies and would leak test material into arm A |
| Runtime bundle SHA-256 | `e77e30e39e67f05d3159548605057d396794d1bde20bd59a070670e109c3d904` |
| `SKILL.md` SHA-256 | `6c0ca2236d3518ccaad710f6db8e9c4aa7af67b685dc699ad347ae42186951e1` |
| Baseline manifest SHA-256 | `6a70083e0786dfd30a75e0adeba4708209748bbb5ba81c107d00a8d7b1959c9d` |
| Active protocol SHA-256 | `da1d6ff610abb1fd01ba971b9c5cc873718fc00ac6056b7ebfac2a3fb3c9e6ed` |
| Active corpus lock SHA-256 | `3b425c4ac181a1a5231575b5fa5cf7e85fcfe31c3f288cef9ec69e69b924976f` |
| Development manifest / tree SHA-256 | `2d5c7e75c613638866c28d095fbc55f2293fc8f29ea093d60a680ec52bded1f0` / `263fbf61aadaad9c96ad08cfe33ea618d3abefb44cd4df9f382d9d38f01a327c` |
| License | MIT |

The machine-readable
[`khazix-neat-freak-v3-baseline.json`](../../eval/neat-parity/khazix-neat-freak-v3-baseline.json)
records the exact file list, normalized executable modes, byte lengths, and
content hashes. The evaluator downloads only those committed raw files, rejects
redirects and mismatches, rejects symlinks, verifies the aggregate bundle, and
then atomically installs the directory.

## Protocol continuity

`protocol-v1-v3.json` retains the July 18 random seed, token and wall-clock
budgets, repetition counts, non-inferiority thresholds, power floor, blind edit
rubric, and fail-closed claim policy. Only the protocol ID, registration date,
and A-arm provenance changed. `corpus-lock-v1-v3.json` commits the regenerated
development corpus under that provenance. The original `protocol-v1.json`,
`corpus-lock-v1.json`, and July 18 report remain unchanged except for a visible
historical notice in the report.

## Evidence completed by this rebaseline

| Gate | Result |
|---|---|
| Official v3 commit and six-file runtime scope identified | PASS |
| Per-file bytes, modes, and SHA-256 commitments | PASS |
| Deterministic aggregate bundle commitment | PASS |
| Download rejects redirects, mismatched bytes, and existing destinations | PASS |
| Bundle verifier rejects symlinks and undeclared or missing files | PASS |
| A-arm adapter receives the complete isolated bundle | PASS |
| Development corpus regenerated and locked to v3 provenance | PASS |
| C-arm mechanical control | PASS — 60/60 executions, result SHA-256 `439ec866d8fd06676b65ce21d057acc862a807f2bf3bbc72606d9e587fd55cf4` |
| Hidden A/B semantic experiment | NOT ASSESSED |
| Production primary/secondary model IDs and credentials | NOT PROVIDED |
| Independent hidden bundle and custody receipt | NOT PROVIDED |
| Four isolated A/B adapter manifests | NOT PROVIDED |
| Two blind judges plus human adjudication | NOT PERFORMED |

## Remaining authorization gate

The public claim must remain **“auditable semantic hygiene beta”** until an
independent custodian freezes at least 46 hidden cases / 184 defects, complete
primary and secondary model IDs are recorded, four budget-matched isolated
adapters execute all repetitions, and blind scoring passes every preregistered
gate. Missing evidence is failure; development results and builder self-custody
cannot authorize parity wording.

Sources: [official repository](https://github.com/KKKKhazix/khazix-skills),
[v3 commit](https://github.com/KKKKhazix/khazix-skills/commit/2b4a645cfdc894156ae347d897723562f719ce95),
[frozen v3 `SKILL.md`](https://github.com/KKKKhazix/khazix-skills/blob/2b4a645cfdc894156ae347d897723562f719ce95/neat-freak/SKILL.md).
