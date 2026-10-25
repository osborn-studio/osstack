## Verdict: 0 P0, 0 P1. Residual P2 closed by inspection.

### 1. Capacity-rejected run marker (closes prior P2)

- **Marker applies on INSERT.** The discovery INSERT payload now spreads `event_replay: { complete:false, caught_up:false, gap, completeness_scope:"unverified_retention" }` when `row.kind === "run"`. Capacity-rejected rows get `gap:"capacity_exceeded"`. The spread is placed first, so `state`, `reason`, and `unresolved_receipts` keys are unaffected, and no key collides with `event_replay`.
- **Marker applies on conflict.** The `ON CONFLICT DO UPDATE` clause sets `payload_json=excluded.payload_json`, so a re-discovered rejected row also receives the marker.
- **Admitted rows are not affected.** The loop's first check skips rows with `admitted=1`, so no admitted row reaches this INSERT and loses an existing projection payload. The `gap:"not_sampled"` branch is only reachable for newly admitted rows, which are projected immediately, and `update()` also keeps `event_replay` on run payloads.
- **Promotion path is safe.** A previously rejected run that gets a free slot on a later scan is rewritten as `gap:"not_sampled"` with `complete:false`. The marker stays incomplete, so no completeness is claimed.
- **Other writers preserve the marker.** The `source_missing` branch rewrites all subjects in the scope with `event_replay`, and `inventory()`'s corrupt-payload fallback also emits it. No writer strips it for run rows.
- **Inventory effect.** Rejected rows have `reason:"capacity_exceeded"`, which makes `faulty` true and coverage `degraded`. This matches the new test's expectation.

**Closure: P2 closed.** The marker applies to every path that writes a rejected run's payload.

### 2. Test: capacity rejection (101 runs)

- The test asserts `admitted=0`, the marker fields, `admitted:100`, and `subject_total:101`. The logic is consistent with the observer code.
- **Setup dependency (not a finding in the delta):** `x099` is rejected only if exactly one other subject sorts before `x099` in the `'1:'||run_id` key order, so that 100 admissions happen before it. If `setup()` inserts a run ID that sorts after `x099`, `x099` would be admitted and the test would fail. `setup()` was not supplied, so this cannot be confirmed from the diff.

### 3. Test: operator repair with sticky gap

- The delta changes no repair logic. The test asserts existing behavior: `last_seq` stays at 0 while facts are corrupt, and after manual repair the cursor advances to 1 with `gap:"invalid_cursor_facts"` and `event_replay` `complete:false, caught_up:false`.
- **Verification limit:** the sticky-gap and `complete:false` assertions depend on `projectAttentionRun` and the cursor code in `attention-run-projection.ts`, which was not supplied. The test is consistent with the observer's contract, but I cannot confirm the assertion holds. This is a verification gap, not a regression finding.
- This test is consistent with the owner's stated boundary: explicit operator repair may resume reads, but the gap is not cleared automatically.

### Regressions

None identified in the delta. The only runtime change is the conditional spread in the discovery payload. The test additions do not alter runtime behavior.

### Out of scope (per instructions, not audited)

Retention and prefix integrity, `caught_up` beyond the new watermark, global 100-admission stability, performance, the `unknown` state union, and coverage semantics beyond observation.