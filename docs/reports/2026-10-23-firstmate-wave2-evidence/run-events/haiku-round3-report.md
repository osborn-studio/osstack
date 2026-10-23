## Result

- **P0 count: 0. P1 count: 0.**
- **N1 (missing replay markers): partially closed.** The run catch path, corrupt-JSON inventory fallback, source-missing and binding-conflict paths, and the scope-wide source-missing update now carry the marker. One run path still omits it (finding 1).
- **N3 (corrupt cursor advanced over existing gap): closed.** `priorValid` gates the event loop regardless of `saved.gap`, and `facts_json` is preserved. The `{` reproducer stalls as the new test expects.
- **N6 (undiscovered runs excluded): closed.** The UNION ALL term, its four bound parameters, and its `NOT EXISTS` on `kind='run'` are correct. Discovery reset and `scan_complete` behave as the new test expects.

## Remaining findings

### 1. P2 (residual N1): run subjects written by the discovery INSERT have no `event_replay` marker

`scan()` writes the discovery row with `JSON.stringify({ state, awaiting_decision, reason, unresolved_receipts })`. For `kind='run'`, `source` is always `undefined`, so `state` is `"unknown"`. When `admitted=0` (`count >= 100`), the row gets `reason: "capacity_exceeded"` and nothing else. `update()`'s run-only prepend never runs on this path, and `projectAttentionRun` is never called for non-admitted subjects.

Reproducer (extending the `attention-run-projection.test.ts` setup):
1. Insert 101 runs in task `t` with distinct IDs, each with its own session row or none.
2. `observer.tick(1000)`. The first 100 by key are admitted.
3. Read `attention_subjects` for the 101st run.

Result: `facts` is `{"state":"unknown","reason":"capacity_exceeded",...}` with no `event_replay`. `inventory` reports `degraded` through `reason<>'snapshot_only'`, but a consumer reading `facts.event_replay.complete` gets `undefined`, not `false`. The frozen contract says `complete:false` wherever run replay is present, so this may be acceptable as "not present." It is still the N1 class the commit set out to remove. Fix: add the run-conditional marker to the INSERT payload, or have `inventory` synthesize it for run rows lacking it. Downgrade to P3 only if the owner explicitly accepts absence for non-admitted runs.

### 2. P2 (behavior change, needs owner decision): a repaired corrupt cursor now resumes advancing with the gap still sticky

Before this commit, `gap !== "invalid_cursor_facts"` was false on every later tick, so a stalled cursor could never advance, even after its `facts_json` was repaired. Now `priorValid` is recomputed from the current row. After repair, the loop runs and advances, while `gap` stays `invalid_cursor_facts` through `??=`.

Reproducer:
1. `event(0); tick(1000)`, then `UPDATE attention_run_cursors SET facts_json='{' WHERE run_id='r'`.
2. `event(1); tick(2000)`. Cursor stays at 0, gap `invalid_cursor_facts`.
3. `UPDATE attention_run_cursors SET facts_json='{"observed_status":null,"unsupported_events":0}' WHERE run_id='r'`.
4. `event(2); tick(3000)`.

Result: `last_seq` goes to 2. The gap stays set, so `caught_up` stays `false`, and the `invalid_cursor_facts` stall is no longer permanent. This matches the sticky-sequence-gap precedent, so it may be intended. But the stall is no longer a terminal stop, and the new test does not cover repair. Either lock the behavior with a test and record it as intended, or keep the stall by also checking `saved.gap === "invalid_cursor_facts"` in `priorValid`.

### 3. Note (no regression): `undiscovered` runs a full run-table `NOT EXISTS` every tick

The new run arm has no keyset bound, so each scope now scans all task runs on every tick, in addition to the existing session arm. This is inside the already-pending aggregate performance qualification and is not a correctness issue.

## Non-findings checked

- **`writeSubject` spread order:** `...facts` follows the default `event_replay`, so the success-path marker wins. Early returns carry no `event_replay`, so the default applies.
- **`update()` prepend:** the catch-path payload has no `event_replay` key, so the prepend is not overwritten incorrectly.
- **TypeScript:** the `if (...) { ... } else { ... }` block in the projection is valid, and `saved!` is safe because `priorValid` can only be false when `saved` exists.
- **`faulty` precedence:** `AND` binds tighter than `OR`, so the expression still means the intended thing inside `CASE`.
- **Authority echo and `unknown` resolution:** unchanged in this delta and covered by the frozen contract.