# Closure audit: gate-layers design (BASE b2d9c723 → CANDIDATE 1b9d9098)

Diff and full-file review only. Nothing was run, so the mutation results below are derived by reading `validate-design.py` and the data files. I relied on the supplied validation output (107 tests OK, 126 gates, 72 cases) as given.

## Previous findings

| ID | Status | Basis |
|---|---|---|
| P1-1 | Closed | `work.component_slices` must equal the byte-pinned `component-slice-specs.json`. The validator checks slice `requires` against the gate's `requires`, the owner role, and shared paths via `other.scoped ∈ closure(slice.gate)`. JP-08a now requires `J05.scoped`. A mutated slice (schema paths, effects, extra slice) fails with "unregistered or changed component slice". |
| P2-1 | Closed | The release guard is now exercised through `validate_gate_layers` directly, with a regex on the exact message. |
| P2-2 | Closed | `J01.legacy_full`, `J10.protocol`, `J27.release_channel` and `J23.harness` are pinned. A generic `X.scoped ∈ X.legacy_full` rule is added. |
| P2-3 | Closed for enforcement | Closure guards for J08/J09/J14/J16/J17 are in place. The archive is accurate on the removal side, but see P2-C below. |
| P2-4 | Closed within the stated trust model | The original archive is hashed and loaded. Stable oracle fields are compared. JA59/70/71/72 are content-pinned. |
| P2-5 | Closed | JA71 and JA72 are mandatory on `J08.admission_boundary` and `J08.scoped`. Removing either fails with "joint case coverage drift". |
| P2-6 | Closed | JA02 `implementation_producer_work_item` is J08 and enforced. The role is rewritten consistently, and the original semantic fields are unchanged. |
| P2-7 | Closed | A closed slice registry and `required_base_gates` for J02/J03/J04/J11 are validated. I found no effective PR-level cycle, because the J01 consumers now use the gate rather than the whole package. |
| P2-8 | Partially closed | A binding rule exists, but it is prose only. See P2-B. |
| P2-9 | Closed | Counts and index rows are consistent. The PR #271 wording is acceptable if every one of the 43 paths is under `docs/`. |

## P0 / P1

None found.

## P2 (new or remaining)

**P2-A. Making `J05.scoped` a prerequisite of the admission boundary couples host acceptance and legacy release gates to the E0 experiment decision.**
- Chain: `J01.scoped → J08.admission_boundary → J05.scoped → J25.e0`.
- `J05.scoped.decision_requirements` allows only `J25.e0 ∈ {continue, shrink}`.
- Gates now pulled behind that decision:
  - `J23.scoped`, `J26.scoped`, `J23.harness`.
  - `J10.protocol` and `J01.legacy_full`.
  - `J27.release_channel`, and through it `legacy:V06.release_channel`.
  - `legacy:V03.host_measurement`.
  - `legacy:V06.release_channel` is required for every artifact release (`every_artifact_release`).
- At BASE, `J08.admission_boundary` required only `J01.contracts`, so none of these closures contained `J25.e0`.
- Reproducer, by reading `execution-gates.json`:
  1. Compute `closure('J27.release_channel')`. It now contains `J01.scoped`, `J08.admission_boundary`, `J05.scoped`, `J25.e0`.
  2. Set the E0 decision to `stop`, which is an allowed E0 outcome. `J05.scoped` becomes unsatisfiable, and so does the Firstmate release channel, which is unrelated to the P-method value.
- The validator has no check against this, and `transitive-impact.json` records only removed inheritance, not this added inheritance.
- The only stated reason for the edge is ordering the shared file `method-admission.ts`.
- Fix, either of:
  - Give `method-admission.ts` to a single owner. For example, J08 creates it and J05 drops it from `write_paths`, or JP-08a uses a separate file. Then `J08.admission_boundary` can go back to `requires: [J01.contracts]`.
  - Keep the edge, but document the coupling, add it to the impact archive, and assert it deliberately.

**P2-B. The candidate-binding rule has no enumerated artifact set or identity fields, so it cannot be machine-checked.**
- `component_evidence_binding_rule` is a string compared with a constant in the same file. `contract_artifacts: "read_only…"` is free text.
- No path or digest set defines the "frozen contract artifacts".
- Recovery gates carry `identity_fields`. `J01.contracts`, `J08.admission_boundary` and `J01.scoped` carry none.
- Reproducer: pass J01.contracts at candidate X, then change a protocol file in a later PR. For example, J05 (`packages/protocol/src/engineering-recipe.ts`) or J07 (`packages/protocol/src/method-artifact.ts`) can change recipe or artifact body schemas that J01's outputs claim to freeze. Nothing in the data or validator says whether that invalidates J02–J11 evidence, and the validator passes.
- Fix: add a closed `frozen_contract_artifacts` path list to the pinned registry. Give the three gates `identity_fields` (candidate_sha, contract/entry source digest, config digest). Require that any other package's `write_paths` overlapping the list be declared as invalidating. This is design-only and needs no runtime.

**P2-C. `transitive-impact.json` is neither loaded nor pinned, though the docs call it the complete set.**
- Reproducer: delete `"J07.scoped"` from `no_longer_inherits_J01_scoped`, or set `execution_gate_closure` to `{}`. The validator and all tests still pass.
- My manual recomputation of the removal list matches the file, so the content is currently correct.
- Fix: add it to `PINNED_LAYER_SPEC_FILES`, and cross-check `execution_gate_closure` against the live closure. Also add the P2-A inheritance.

## Suggestions (not blockers)

- The slice overlap loop compares slices only with other packages' `write_paths`. It does not compare slices with each other or with other packages' slices. Slice paths (`joint-host-acceptance.test.ts`, JP-01c tests, `method-admission.test.ts`) are also absent from the owning package's `write_paths`. The registry is pinned, so there is no collision today. Fold slice paths into the generic overlap check before the registry grows.
- `JP-08a` has no PR base of its own. As part of JP-08 it waits on J12, although its gate does not. This is conservative, not unsafe. Consider `required_base_gates` for the slice.
- State explicitly that the effective stage graph is slice-level. A package-level J01 → … → J08 → JP-01d loop is hidden by the gate-based bases.
- Reword the preflight text to "all 43 paths under `docs/` (scripts, logs and JSON included)".
- Prose counts (126 and 72) are checked only by the test, not by the validator.

VERDICT: REVISE
END_AUDIT