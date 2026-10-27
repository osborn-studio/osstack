# Closure audit: BASE 1b9d9098 → CANDIDATE 9f260187

Reading only, nothing run. I take the supplied result of 111 tests OK, 126 gates and 72 cases as given.

## Previous findings

| ID | Status | Basis |
|---|---|---|
| P2-A | Closed | `J08.admission_boundary` and JP-08a now require only `J01.contracts`. `method-host-admission.ts` and its test are J08-exclusive: no other package lists them, and the slice overlap loop would catch one that did. The guarded closures (`J01.scoped`, `J01.legacy_full`, `J10.protocol`, `J23.harness`, `J27.release_channel`, `legacy:V06.release_channel`, `legacy:V03.host_measurement`) no longer reach `J25.e0`. The validator asserts this through `host_gates_independent_of_E0` and `newly_inherits_J25_e0 == []`. `method-admission.ts` stays J05 production, and J08 extends it after J07, which is ordered. |
| P2-B | Partially closed | A pinned `frozen_contract_artifacts` list, `identity_fields` on the three gates, and per-package `invalidates_component_evidence` are all validated. Two gaps remain: P2-1 and P2-2 below. |
| P2-C | Closed | The file is now in `PINNED_LAYER_SPEC_FILES` and loaded. The validator recomputes the removed J01 inheritance and the added E0 inheritance from the frozen `baseline_requires`, and it checks `execution_gate_closure`. A byte-change test exists. |

## P0 / P1

None.

## P2

**P2-1. The invalidation overlap set omits the gates' `entry_source_paths`.**
- The validator builds `artifacts = frozen_contract_artifacts ∪ tracked_contract_extension_paths`. It never adds the `entry_source_paths` from `gate_evidence_bindings`.
- Two entry paths are written by packages that are not required to declare invalidation:
  - `J01.scoped` lists `packages/cli/src/graph-verification.ts`. J07 writes it (`extend_existing`), and J07 declares invalidation only for `method-artifact.ts`.
  - `J08.admission_boundary` and `J01.scoped` list `method-host-admission.ts`. J08 owns it and may extend it when wiring the full trial under JA72.
- Reproducer: J07's `write_paths` contain `graph-verification.ts`, and its `invalidates_component_evidence.paths` is `["packages/protocol/src/method-artifact.ts"]`. J07 has no dependency on `J01.scoped`, so its change can merge after `J01.scoped` passes. `validate()` still passes. The doc claims every writer of overlapping contract paths declares invalidation.
- Fix: include every gate's `entry_source_paths` in `artifacts`. Then J07 and J08 must declare invalidation, with their paths listed in the expected `paths`. Add a negative test for each.

**P2-2. Nine of the eleven `frozen_contract_artifacts` have no producer or owner in any work package.**
- `joint-contracts.ts`, `joint-evidence.ts`, `joint-generate.ts`, `joint-json.ts`, `joint-lifecycle.ts`, `joint-primitives.ts`, `joint-recovery.ts`, `joint-shapes.ts` and `method-materials.ts` appear in no `write_paths` or `path_disposition`.
- J01's `write_paths` hold only `engineering.ts` and `method-binding.ts`, yet JP-01a and JP-01b are planned to produce strict JSON and structural contracts.
- Consequences:
  - The overlap-based invalidation check can never fire for these nine files unless a package lists them.
  - The merge-order check does not cover them.
  - `gate-layers.md` says the list contains only "existing" files, but `method-binding.ts` is `proposed_new`.
- Reproducer: search `work-packages.json` for `joint-json.ts`. Nothing matches, and the validator passes.
- Fix, either of:
  - Add the paths to J01's `write_paths` with a `path_disposition` (new or existing), so the overlap check applies.
  - State that they are pre-existing baseline files and pin their commit and digests. Correct the "existing" sentence for `method-binding.ts`.

## Suggestions (not blockers)

- `J01.contracts` has empty `entry_source_paths`, so `entry_source_digest` has no defined input. The harness test files (JP-01c, JP-01d, JP-08a tests) are also outside the identity digests. A weakened test would not change any listed digest. Either name them as entry or harness paths, or say that `config_digest` or `oracle_digest` covers them.
- `added_e0` iterates only `baseline_requires` keys, so `J01.contracts` is never checked for E0. Add it to `host_gates_independent_of_E0`.
- Re-freezing after J05 or J07 changes the protocol invalidates J02's and J05's own evidence (J05 depends on J02, whose evidence is bound to the `J01.contracts` candidate). Say explicitly that this loop is intended and bounded.
- The slice `pr` block and `case_producer_for` are covered only by the digest pin. A cross-check against the gate's `requires` would be cheap.

VERDICT: REVISE
END_AUDIT