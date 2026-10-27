BEGIN_AUDIT
**Verdict: PASS.** I found no concrete remaining defect in the final fixes. This is a read-only review of the code you pasted. I did not run anything.

**1. Python assert stripping**
- `joint-reference-vectors.py` has no `assert` statements left. `require()` raises `SystemExit('FAIL: …')`, and the unknown-helper branch raises `ValueError`. Both survive `-O`.
- The corrupt-vector probe is wired correctly:
  - With `python3 -I -O -c probe script`, `sys.argv[1]` is the script path. The probe rebinds `sys.argv` to `[script, '--check']`, so argparse sees only `--check`.
  - The patched `Path.read_text` accepts `*args, **kwargs` and corrupts only `reference-vectors.json`.
  - `vectors[0]` is assumed to be the `bindingDigest` vector, which the expected message `FAIL: bindingDigest` depends on. This is fixture-order coupling, not a defect.
  - An uncaught `SystemExit` with a string writes it to stderr and exits 1. `execFileSync` with `stdio:'pipe'` includes stderr in the error message, so `toThrow('FAIL: bindingDigest')` is a valid substring match.
- The test fails if the check is skipped: a stripped assert would exit 0 and the `toThrow` would fail. That shows changed behavior, not only a changed hash.

**2. SQL typed-mismatch and home-only mutants**
- The probe list has 13 entries:
  - 10 typed-field probes: decision, request_id, operator_ref, subject_digest, observed_at_ms, owner_generation, if_revision, kind, target, schema_version.
  - `json(subject_json)=`.
  - `json_type … if_revision` (the string `'0'` case).
  - The `kind IN` home-only probe, using a `broker_lease` subject whose receipt target stays `home`.
- Each anchor matches exactly one DDL line, and `expect(hits).toHaveLength(1)` enforces that. I checked that `json_extract(...'$.kind')` does not collide with the `json_type(...'$.kind')` line, and that `$.subject` does not collide with `$.subject_digest`.
- The mutation replaces `AND <expr>` with `AND 1`. For the final conjunct it becomes `AND 1) IS 1)`, so the parentheses stay balanced and the mutant compiles. A syntax error would throw in `mutant.exec` and fail the test.
- Each probe changes one receipt field while the column value stays good. That is the only discrepancy the removed conjunct would have caught, so the original DDL rejects and the mutant accepts.
- The `if_revision='0'` case works because `json_extract` returns text `'0'`. SQLite applies the INTEGER column affinity in the comparison, so it equals 0. Without the `json_type` line the mutant accepts, and the original rejects through `json_type`.
- The accept/reject pair is evidence that the rejection comes from the targeted conjunct. The mutant differs from the original by that one line only.

**3. OR IGNORE / DO NOTHING / REPLACE**
- Covered for `operator_recovery_decisions`, `operator_upgrade_journal`, `joint_method_objects`, `engineering_goal_specs` and `trial_permit_consumptions`.
- The no-update and no-delete triggers fire on the upsert paths. `OR IGNORE` is stopped by the insert guard's `RAISE(ABORT)`, since the `BEFORE INSERT` trigger fires before conflict resolution.

**4. Zod identity negatives**
- Covered for effect (`binding_generation` / `support_profile_digest` null), attention (extra `effect_id`), and broker (wrong decision type, `target:'home'`, missing identity, and each identity field mismatched).
- The proven_stopped proof carrying a broker identity is rejected for effect and attention receipts.

**Non-blocking observations**
- The corrupt-vector test covers only the `--check` vector loop. It does not cover the `--recovery-root` `require` branches under `-O`. Those use the same `require`, so the risk is low. One optional corrupt-manifest probe would close it.
- The last block in the typed-mismatch test (broker target plus broker subject) is a plain rejection, not a mutant. That is fine, because `target='home'` and `kind IN` each independently reject it and the probes above already pin those two.

No counterexample. Ship.
END_AUDIT
