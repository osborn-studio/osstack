# Closure audit: BASE d3fa7ef → CURRENT bc25b1c (delta from e8770e3)

**Limits.** I had no tools and executed nothing. SQLite error classes and trigger ordering come from documented semantics. I did not see the verification record for bc25b1c, only the e8770e3 one, so I make no claim about test counts for this SHA. This is not a J11/J17 gate PASS and not runtime deployment qualification.

## P0 / P1

None found.

## Closure of the requested details

- **Lease-creation writer fencing (doc).** Closed.
  - The new sentence matches `schema.sql`. The guard's `owner_generation>=NEW.grant_generation` admits historical grants up to the current owner.
  - The doc now states this is not an owner-fenced admission API. It also states that a future lease-creation host must fence old writers and authenticate the current owner generation.
  - SQL is untouched, so there is no refreeze.
- **SQLite ≥3.38 plus an actual JSON smoke test, in both engines.** Closed.
  - `freeze.py` asserts `>= (3,38,0)` and runs `json_valid('{}')` and `json_extract('{"probe":1}','$.probe')`, expecting `(1,1)`. The escaped quotes in the Python string produce valid JSON.
  - The TS test parses `sqlite_version()` against `3_038_000` and asserts the same JSON probe result.
  - The doc and manifest are consistent with both.
- **Malformed JSON rejected with `SQLITE_ERROR` and no state change.** Closed.
  - With `receipt_json='{'`, the first two `WHEN` disjuncts of the BEFORE INSERT guard are false. The third subquery reaches `json_extract(NEW.receipt_json, …)` because the earlier conjuncts match `lease-a`.
  - That raises a generic error before CHECK evaluation, so `code:'SQLITE_ERROR'` is the expected result. The test also asserts the lease row and decision history are unchanged.
  - Host checklist item 5 now says any SQLite failure must abort, not only `SQLITE_CONSTRAINT`.
  - The existing `sqlReject` helper, which requires `SQLITE_CONSTRAINT*`, is not used for this case, so the earlier assertions are unaffected.
- **Raw Buffer SQL/fixture hashing.** Closed. `hash` now accepts `string | Uint8Array`, and the manifest test hashes `readFileSync(new URL(...))` with no encoding. This matches Python's `read_bytes()`. `fixture()` still reads the SQL as UTF-8, which is only for execution.
- **Oracle timestamp exactly read from original criteria.** Closed.
  - `freeze.py` parses `oracle-freeze.json` only after the raw sha256 check passes. It copies `oracle['frozen_at']` verbatim.
  - `manifest.json` shows `2026-10-27T16:16:01.175077+00:00`, which is identical to the string in `oracle-freeze.json`.
  - `json.dumps(..., ensure_ascii=False, indent=2)` does not alter that string. The TS test asserts exact equality with the oracle file.

## Regression check on accepted offline guarantees

- `schema.sql`, `held-orphan.sql` and `catalog.json` do not appear in the delta.
- `oracle_prefreeze` is outside `digest_body`, so `schema_spec_digest` (30712be8…) is unchanged. The test's `schemaSpecDigest(spec)` equality is unaffected.
- The manifest change is limited to `frozen_at`. The storage flags, `qualification` entries and dependencies are unchanged, so the `deployment_qualified=false`, `allocation=not_reserved` and `not_run` boundary is preserved.
- The new tests do not alter existing test setup. `fixture()` is unchanged, and no existing assertion was weakened or removed.
- The freeze-then-check flow is stable. A regenerated manifest has the same bytes as the committed one, so `--check` should pass.

## Optional, non-blocking

- The doc sentence "Decision insertion rejects … direct projection mutation, history mutation and replacement" is loosely worded. Projection and history mutation are blocked by the lease update guard and the no-update/no-delete triggers, not by decision insertion. This is a wording tidy-up, not a boundary error.
- The TS test file has a stray double blank line after the new tests (style only).
- Optional future runtime work: bind the final-SHA verification record to bc25b1c at merge, as already planned.

None of these blocks closure.

VERDICT: PASS
END_AUDIT