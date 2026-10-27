# Audit: gate-layers design PR (BASE d3fa7ef → CANDIDATE b2d9c723)

This is a diff-only review. Nothing was executed, so mutation results are derived by reading the validator code. Line numbers for `validate-design.py` are approximate, taken from hunk offsets.

## What holds

- The gate graph is acyclic. `J01.scoped` requires `J01.contracts` and `J08.admission_boundary`, and the boundary gate requires only `J01.contracts`. `J08.scoped` requires `J01.scoped`.
- The override whitelist is closed. `component_dependency_gates` demands exact equality with `COMPONENT_GATE_OVERRIDES`, so a J08 override, an override pointing at another owner's gate, or a dropped override all fail.
- The legacy and joint case namespaces are separated. Unknown, duplicate or non-list `joint_case_requirements` fail before `set()` can raise on unhashable items. `legacy_release_requirements`, `local_override` and the `legacy_gate_map` hashes are untouched by the diff.
- The preflight file is honestly scoped. It is named "observation_not_gate_pass", and `unknowns.json` still blocks J02 `implementation_start` on O06. The 43 listed PR #271 paths count correctly.

## P0

None found.

## P1

**P1-1. The JP-08a slice is almost entirely unvalidated, so the "non-effecting, no schema, J01.contracts-only" invariant is prose.**
- Location: `validate-design.py`, final block of `validate_gate_layers` (≈ lines 224–228), and `work-packages.json` J08 `component_slices[0]`.
- What the validator checks: only `gate`, `requires`, `case_producer_for` and `case_owner_work_item`.
- What it does not check: `write_paths`, `scope`, `qualification`, or the slice's relation to the package-level merge and queue rules. Both the shared-write-path overlap loop and the schema-registration/queue checks iterate `works[*].write_paths`, not slices.
- Reproducible mutation A: set the slice `write_paths` to `["packages/core/src/state/migrations.ts", "packages/core/src/state/schema.ts"]` and the scope to "creates permit, creates run, invokes executor". The validator still passes. The slice requires only `J01.contracts`, so it bypasses J12 recovery, the `control_plane_schema` queue, `introduces_schema` and `J08.recovery`. `J01.scoped` (host authorization) then depends on it.
- Reproducible mutation B: the slice's `method-admission.ts` is also in J05's `write_paths`, and both are `proposed_new`. At package level J05 precedes J08 through J07. JP-08a needs only `J01.contracts`, and `J01.scoped` needs JP-08a, but J05 is not an ancestor of JP-08a. The plan therefore contains two owners creating the same new file with unspecified order, and no check sees it.
- Fix: add slice-level checks. Allowed write-path set, no schema or state paths, no overlap with other packages unless ordered, an explicit slice-level merge DAG, and a machine-readable `effects: none`. Also decide which package owns `method-admission.ts`.

## P2

**P2-1. The negative test `test_release_cannot_qualify_using_only_component_closure` is vacuous.**
- It replaces `J01.scoped` with `J01.contracts` everywhere except J08.scoped and uses a bare `assertRaises(ValueError)`.
- It fails at the pre-existing "package dependency absent from stage gate" check on J23.scoped, not at `release bypasses J01 host acceptance`.
- The release-closure check is never exercised in isolation. J23.scoped and J26.scoped keep `J01.scoped` in the J27 closure regardless, so the check is largely redundant.
- Fix: use a regex on the message. Show an isolated mutation that only the new check catches, or drop the claim.

**P2-2. Non-scoped consumers of `J01.scoped` are unprotected.**
- Mutation: set `J01.legacy_full.requires`, `J10.protocol`, `J27.release_channel` or `J23.harness` to `["J01.contracts"]`. The validator passes. Package-dependency checks cover only `.scoped` gates, and nothing enforces `X.legacy_full ⊇ X.scoped`.
- This is pre-existing, but the docs now rely on it ("`J01.scoped` 仍由 J23/J26、legacy 与发布链消费").
- Fix: pin `J01.scoped` in the requires of `J01.legacy_full`, `J10.protocol`, `J27.release_channel` and `J23.harness`, or add a generic `legacy_full ⊇ scoped` rule.

**P2-3. Transitive weakening is understated.**
- The docs say "仅四项" (only four), but J05, J06, J07, J12 (real hold recovery and operator authorization writes), J13, J25.e0 and J31's J07 edge no longer inherit `J01.scoped`/JA01/JA02. J07.scoped is the completion-gating implementation (JA14/JA68).
- Release and executor-invoking gates still reach `J01.scoped` via J23, so this is not a bypass today. The documentation should state it, and the validator should assert it for J08, J09, J14, J16 and J17 (closure ⊇ `{J01.scoped, J08.admission_boundary}`) so a later edit to J23 cannot silently open it.

**P2-4. JA01/JA02 protection is self-anchored and incomplete.**
- `PROTECTED_HOST_CASE_DIGESTS` live in the same file and PR as the data they protect.
- `ja01-ja02-original.json` is never loaded or cross-checked by the validator.
- `oracle_spec` is excluded from the digest. Setting JA02 `oracle_spec.observation_boundary` to "parser spy only" passes, even though the validated `oracle` field says otherwise.
- JA70 and JA59 are not content-pinned. Changing JA70's `then` to "合法组件授予运行权限" passes, which breaks the "不授予运行权限" invariant.
- Fix: hash the evidence file in the baseline, recompute the digests from it, include `oracle_spec` minus lifecycle fields, and pin JA70's key semantics.

**P2-5. The JA02 positive-control and same-boundary requirements are non-binding.**
- `gate-layers.md` says the oracle "应包括" a same-repo positive control and that the full trial "必须证明" it uses the same boundary.
- JA02's text is frozen, so neither requirement is in `required_evidence`. No JA16/17/49/61 evidence requirement encodes a "no second entry" check.
- Because JP-08a is non-effecting, "executor calls = 0" holds for both the good and the bad variant, so only the admission-error half of the oracle discriminates. An unconditional-reject stub can pass unless the positive control is mandatory.
- Fix: add a binding evidence item or a new J08-owned case for the positive control and single-entry proof.

**P2-6. Oracle implementation role is wrong for JA02.**
- JA02 `oracle_spec.implementation_owner_role` is `contract-owner` (J01). The code is actually written by the qualification-owner in JP-08a.
- Independence checks would therefore compare author and custodian against the wrong implementers. Record the producing role, or re-own JA02 and the slice consistently.

**P2-7. Package-level graph and PR base ordering are inconsistent with the gate override.**
- J02, J03, J04 and J11 still have `depends_on: J01` and `base: main_after_dependencies`. J01's package includes JP-01d/`J01.scoped`, which needs the J08 slice, while J08 depends on J12→J11→J01.
- That is a package-level cycle hidden only because the slice edge exists at gate level. `planned_pr_slices` strings are unvalidated, and JP-01d has no write paths or owner for the host Session/task code that JA01 exercises. J01 `write_paths` cover protocol files only.
- Fix: model slices as DAG nodes (JP-01c as the override target) and give JP-01d paths or an explicit "regression-only" declaration.

**P2-8. No candidate binding between contract-level and host-level evidence.**
- J02–J11 will be accepted against `J01.contracts` at candidate X. JP-01d, at candidate Y, may still change protocol bytes.
- Add a rule that JP-01d may not alter the frozen contract artifacts or digests, or else invalidate the downstream evidence.

**P2-9. Inaccurate or stale claims.**
- `verification-spec.md` still says "新增 JA49–JA69" next to the new count of 70.
- `work-package-index.md` cannot be confirmed to list JA70 for J01. Please check that row.
- The preflight says the 43 PR #271 changes are "均为README/docs", but they include `validate-roadmap.py`, `test_validate_roadmap.py`, `.log` and `.json` files. "No product paths" is accurate, but "README/docs only" is not.
- `gate-layers.md`'s 126-gate and 70-case counts are prose that the validator does not check.

## Suggestions (not blockers)

- Give `PROTECTED_HOST_CASE_*` and `COMPONENT_GATE_OVERRIDES` a single registry file, with the digest computed by a script that is separate from the validator.
- Make the new gate tests assert exact messages, in the style of `test_scope_case_list_cannot_silently_drop_runtime_obligations`.
- Fail with `ValueError` instead of `KeyError` or `TypeError` for malformed `component_slices`, so nested-malformed data is rejected uniformly.
- The O06 evidence is correctly scoped. Also record the main SHA at merge time in the preflight's invalidation rule.

VERDICT: REVISE
END_AUDIT