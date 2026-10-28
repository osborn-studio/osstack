Original static audit text, unchanged in fence:

````text
# Verdict: REVISE

Nothing was executed; this is a static read of the pasted text only. I have not confirmed the pasted files match f5f0026b or that the author's SHA-256 values match them. I also don't have `smoke-skills-check.mjs`, so what real case evidence contains (for example `run.json`) is inferred from `verifyCaseEvidence` in `method-verification-journey.mjs`.

The model packet itself is closed: ref IDs, case IDs, enums and snippet lines all come from fixed vocabularies, so I found no path for env, argv, paths or free text to reach it. The blocking problem is the opposite direction: `--check` and the projector accept failed, unknown and not_run rows that carry passed-looking state.

## F1. HIGH: unknown/not_run/failed rows can carry passed cleanup or bindings, in both `--check` and projection
File: `scripts/project-method-journey-evidence.mjs`, `validatePacket` (per-feature loop) and `buildProjection` (`out.cleanup = cleanup(f.cleanup)`).

For `verification !== 'passed'`, the validator only requires `product_exit === null` and `product_status === 'unknown'`. The `not_run` branch checks `cleanup.status === 'not_started'` but not `fixture_removed`. Nothing constrains the rest. This is the `cleanup unknown -> passed without source basis` vector (P11), and it is not enforced.

**Repro A (re-signed packet):**
1. Project the existing "failed sealed case" test fixture.
2. In `packet.json`, set `features[0].cleanup = {status:'passed', fixture_removed:true, descendant_termination:'not_attested'}`.
3. Re-seal `manifest.json`.
4. `--check` returns `valid`: no branch looks at cleanup when verification is `failed`.

**Repro B (re-signed packet):** in the doctor-failed packet, set `features[1].cleanup.fixture_removed = true`, `receipt_cleanup_consistent = true` and non-null `bindings` on a `not_created` row. All are accepted.

**Repro C (projector):** edit `journey.json` so `healthy` is `failed` with `cleanup:{status:'passed',fixture_removed:true,...}`. Set the receipt to `failed` with the same cleanup, then re-seal. The projector copies the passed cleanup into the non-reported slot of a failed row. The README says actual cleanup stays unknown here.

**Required fix**, in `validatePacket`, applied to both `--check` and projection:
- If `verification !== 'passed'`, require `cleanup.status ∈ {unknown, not_started}` and `cleanup.fixture_removed === null`. For `not_run`, require `not_started`.
- If `verification === 'passed'`, require `reported_product_exit === null`.
- If `evidence_state === 'not_created'`, require `reported_cleanup === null`, `receipt_cleanup_consistent === null`, `reported_product_exit === null`, and both binding digests `null`.
- Add tests for each of these as re-signed packets and as edited journeys.

## F2. MEDIUM: a legitimate driver-pass / verifier-fail journey cannot be projected
File: `scripts/project-method-journey-evidence.mjs`, `buildProjection`: `else check(receipt.status !== 'passed', 'failed_receipt_conflict')`.

In `runJourney`, the driver exits 0 and writes a `passed` receipt, then `verifyCaseEvidence` can still reject it. Its rejection codes include `scratch_residue`, `fixture_still_exists`, `bindings_changed`, `command_incomplete` and `behavior:*`. The feature stays `failed`, the case is sealed, and the root index records `verified:false`. This is the most important "unknown must not become pass" case, and the projector throws on it.

**Repro:**
1. Take the passed fixture.
2. Set the journey to `failed`, `healthy` to `verification:'failed'`, `product_exit:null`, `cleanup:{status:'unknown',...}`, `reported_product_exit:0` and `driver_exit:0`.
3. Set the root `case_manifests` entry to `verified:false`, leave `receipt.status:'passed'`, and re-seal.
4. `projectJourney` rejects with `failed_receipt_conflict`.

The only test for this path uses `receipt.status = 'failed'`.

**Required fix:** remove that check. A failed row can never reach `passed` without `verifyPassed`, and `validatePacket` already blocks promotion. The receipt's claim stays visible through `reported_cleanup`, `reported_product_exit` and `receipt_cleanup_consistent`. Add a test for this exact shape.

## F3. MEDIUM: "passed" is derived from a subset of the checks that need only retained bytes
File: `scripts/project-method-journey-evidence.mjs`, `verifyPassed` and `buildProjection`.

`verifyCaseEvidence` rejects each of these using retained data only (no live access), but the projector ignores them:
- **`run.json`:** it is never read. `status !== 'passed'`, `bindings_unchanged !== true` and `bindings !== final_bindings` do not matter.
- **Receipt contradictions:** `receipt.behavior` and `receipt.failure` are not checked, so a receipt with `status:'passed'` and a non-null failure still passes.
- **Run identity:** `manifest.run_id`, `receipt.run_id` and `run.run_id` are not compared.
- **Input identity:** `input.json` is not compared to `{version:1, sources: expected.sources}`, so `evaluateCase` can pass against `expectations.json` while the retained input differs.
- **Command/detail conflict:** `command.json` is not compared to the detail file.
- **Cross-case bindings:** the driver's `cross_case_bindings_changed` check is missing. Each case's digests are only compared to its own receipt and journey row.

**Repro 1 (run.json):** on the real pair, edit `run.json` to `status:'failed', bindings_unchanged:false`, re-seal the case and root, and project. It outputs `verification:'passed'`, because `run.json` is not read. The synthetic fixture has no `run.json`, so the tests cannot catch this.

**Repro 2 (cross-case):** give `missing-ref` a different, internally consistent bindings digest in its `bindings.json`, `receipt.binding_digests`, journey row and case manifest hash, then re-seal. The projector emits `journey_status:'passed'` with differing `source_digest` values.

**Required fix:** add these retained-only checks to `verifyPassed`, require `run.json`, and compare `out.bindings` across passed cases in `buildProjection`. Keep the live-fixture checks out of scope as the README says.

## F4. LOW: resource bounds are weaker than documented
File: `scripts/project-method-journey-evidence.mjs`.

- `bounded()` returns `bytes.subarray(0, size)`, which keeps the whole `max + 1` backing buffer (8 MiB) alive. Up to 128 tiny members per directory therefore pin about 1 GiB of backing store per sealed directory, and the root's buffers stay live through the case loop. The `total <= 32 MiB` accounting counts logical length only. RSS impact depends on lazy zero pages, and I did not measure it.
- `readdir` in `sealed`, `checkPacket` and the `cases` listing is unbounded before the inventory check. The README's "at most 128 members" holds only for manifest rows.

**Required fix:**
- Return a copy (`Buffer.from(...)`), or size the buffer from `fd.stat().size`.
- Use `opendir` and reject once more than 129 entries are seen.

## F5. LOW: CLI reporting
- The CLI discards the `check()` code and prints only `projection_or_packet_validation_failed`. The codes are fixed strings and safe to emit (e.g. `failed_receipt_conflict`). Emit `error.message` only when it matches `^[a-z_]+$`; that keeps path-bearing fs errors out.
- `original_evidence_modified: false` is hard-coded and never measured. Either hash the input tree before and after, or rename the field to a non-verification statement such as `input_opened_read_only: true`.

## Observed, non-blocking
- An `unsealed` case (driver timeout or interrupt) rejects the whole projection. That is consistent with the README, but the criteria say legitimate failures may lack a receipt. Decide this explicitly and document it.
- The tests use a synthetic fixture with no `run.json`, `environment.json` or `git-*` files, so they cannot catch F3.

## Checked and sound
- **Closed-schema and allowlist enforcement:** `safeLine` is anchored, fixed-grammar and linear-time. Stream byte accounting is consistent between the projector and the validator.
- **Canonical-bytes check:** it defeats duplicate-key tricks and extra keys, so re-signing alone cannot add fields.
- **Path and output handling:** `O_NOFOLLOW`, `lstat`-based directory checks, the overlap and scratch containment checks, and the exact two-file packet inventory all hold.
- **Host experiment:** the README leaves the prior host-experiment failed axes unchanged and includes no new host run.

Merge is the user's call. I'd hold it until F1–F3 are fixed with tests.
````
