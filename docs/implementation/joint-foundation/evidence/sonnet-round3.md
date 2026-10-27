BEGIN_AUDIT

**Scope and limits.** This is a static read of the supplied source with no execution. Counterexamples below are derived by reading and are marked "unrun". Host test evidence is still required.

## Verdict by area

**(1) Legacy/broker identity consistency: no blocking logic defect.**
- `target`, `subject.kind` and `prior_phase='broker_unknown'` are tied together by `TARGET_PHASE_MISMATCH`.
- For broker proofs, `b.schema === actual_target_schema` and `b.owner_generation === owner_generation`, so both refer to the broker. The Zod receipt and envelope agree on this.
- Effect subjects require non-null `binding_generation` and `support_profile_digest`. Attention and broker subjects may carry null.
- Proof and effect/broker-identity cross-checks are consistent. The count constraint (`proofs.length` is 0 or 1) closes the apparent duplicate-`record_ref` hole in the proof-ref check.
- The SQL ledger limits `subject.kind` to `effect` or `attention_action` and `target` to `'home'`, which matches the J17 split.
- Non-blocking nit: an attention subject may carry exactly one of binding/profile non-null. A both-or-neither rule would be cleaner, but it is not a safety defect.

**(2) JSON scalar typing and field equality: the SQL is sound.**
- `json_type` is checked for every compared scalar, and `(...) IS 1` turns NULL into a rejection.
- `json(subject_json)=json_extract(receipt_json,'$.subject')` compares minified text. Both sides come from the same canonical writer.
- STRICT tables reject a BLOB in a TEXT column.
- Hardening, not a blocker: SQLite `json_valid` accepts duplicate keys, and `json_extract` picks one occurrence that may differ from `JSON.parse`'s last-wins. Safety therefore relies on the host writing canonical bytes and readers using the strict `decodeJointContract`. The test does read back through `decodeJointContract`. J12 should add a duplicate-key probe. Unrun.

**(3) Python wiring and stacking: acceptable, with one cheap defect.**
- J01b's `--check` needs no J11 files. The J11 test opts in via `--recovery-root`. The path from core to protocol is a legitimate upward stack dependency.
- **Defect (minor, cheap):** the verifier uses bare `assert`. With `PYTHONOPTIMIZE=1` or `python3 -O`, every check is stripped and the script prints "verified" regardless.
  - Counterexample (unrun): corrupt any `expected` in `reference-vectors.json`, then run `PYTHONOPTIMIZE=1 python3 joint-reference-vectors.py --check`. It exits 0.
  - Fix: replace each `assert c, m` with `if not c: raise SystemExit('FAIL: '+m)`. Optionally invoke it as `python3 -I`.
- Doc gap: the `schemaSpecDigest` vector input in `reference-vectors.json` must equal `manifest.spec`. A re-freeze via `freeze.mjs` therefore also requires updating that vector input, and the reproduction section does not say so. The check fails loudly, so it is safe, but document it.
- Non-blocking: the Python check recomputes hashes of the recorded catalogs. It does not replay SQL, and the TS test does that part.

**(4) Mutation and negative coverage: BLOCKER B1.**

*B1a. SQL equality and home-only CHECK clauses are unexercised.*
- Negative probes cover only: a `'{}'` receipt, a non-integer revision, a BLOB subject digest, and string-typed `if_revision`, `owner_generation`, `observed_at_ms` and `schema_version`.
- No probe changes a *value* with the type kept correct. Nothing tests a mismatch in `decision`, `request_id`, `operator_ref`, `observed_at_ms`, `subject_digest`, `subject` vs `subject_json`, `kind`, or `target:'broker'`. Nothing tests a `broker_lease` subject.
- Counterexample (unrun): delete from `bootstrap.sql` the conjuncts `json_extract(receipt_json,'$.operator_ref')=principal_ref`, `...'$.target')='home'`, and `json_extract(subject_json,'$.kind') IN (...)`.
  - The test "preserves immutable decisions..." reads `ddl` from the file with no digest check, so it still passes.
  - Only the pin test fails, and `freeze.mjs` regenerates that pin. The mutant survives behaviourally.
- The final "mutant" test is mostly a self-test.
  - `expect(sha(ddl+'\n'+mutation)).not.toBe(sha(ddl))` is vacuous.
  - It shows that the legacy-row/catalog comparison detects tampering. It never proves that any CHECK or trigger rejects bad input.

*B1b. Receipt identity rules lack negatives in the supplied tests.* If `contracts.json` already has invalid fixtures for these, cite them. Otherwise, deleting any of these rules leaves the suite green:
- `INVALID_BROKER_DECISION`. The matrix test uses an effect subject, so broker with `applied_observed` or `proven_not_started` is never reached. Without that rule these receipts would pass, since `prior_phase` is not `reserved`.
- `EFFECT_IDENTITY_MISSING`. No test sets effect `binding_generation` or `support_profile_digest` to null. This is exactly the "new effect subjects cannot be null" requirement.
- `UNEXPECTED_EFFECT_ID` and `UNEXPECTED_BROKER_PROOF`. A broker proof with `broker_identity` absent (`b` undefined) is also untested.
- A broker subject with `target:'home'` is also untested.

## Minimal fix for B1

**SQL probes** (add to J11 test; `base` is the valid canonical receipt and `ins` inserts with the columns derived from `base`):

```ts
const patches: Array<Record<string,unknown>> = [
  {decision:'proven_stopped'},{request_id:'other'},{operator_ref:'other'},
  {observed_at_ms:r.observed_at_ms+1},{subject_digest:'b'.repeat(64)},
  {subject:{...r.subject,action_id:'z'}},{owner_generation:r.owner_generation+1},
  {if_revision:r.if_revision+1},{kind:'x'},{target:'broker'}];
for (const p of patches)
  expect(()=>db.prepare(sql).run(...args(r).map((v,i)=>i===9?canonicalJointJson({...r,...p}):v))).toThrow();
// broker_lease subject, with columns and receipt consistent, must throw (local ledger is home-only)
```

**Make the mutants fail:** for each line of `ddl` containing `json_extract(` or `json_type(`, remove it, load the mutant into a fresh in-memory db, and assert that at least one probe is *accepted*:

```ts
for (const line of ddl.split('\n').filter(l=>/json_(extract|type)\(/.test(l))) {
  const m = new Database(':memory:'); m.exec(ddl.replace(line,'    AND 1'));
  // a mutated line is dropped; some patch must now insert successfully
  expect(patches.some(p=>{try{m.prepare(sql).run(...argsFor(p));return true}catch{return false}})).toBe(true);
  m.close();
}
```

Handle the first conjunct line (which carries the opening parenthesis) separately, and add `INSERT OR IGNORE` and `ON CONFLICT DO NOTHING` variants to the replacement-resistance loops. I expect `RAISE(ABORT)` to still abort them, but that is currently unpinned.

**Zod negatives** (each must be `false` unless noted):
- Effect receipt with null `binding_generation`.
- Effect receipt with null `support_profile_digest`.
- Attention receipt with `effect_id` set.
- Broker receipt with decision `applied_observed`.
- Broker receipt with decision `proven_not_started`.
- Broker `preserve_unknown` with no proofs (`true`).
- Broker proof with no `broker_identity`.
- Effect or attention proof with a `broker_identity`.
- Broker subject with `target:'home'`.
- A mutation harness is optional if these cases are present.

**Also:**
- Drop the vacuous `sha(...)` assertion.
- Replace the Python `assert`s as above.

## Non-blocking observations
- `freeze.mjs` uses `git rev-parse origin/main`. This is fine under the state-owner procedure but non-hermetic.
- The terminal-lock test is meaningful: `receipt(3)` is the correct next revision and is rejected only because of the terminal row.
- The rollback test covers `user_version` transactionality correctly.
- Everything else I checked in the SQL, triggers, upgrade journal and digest wiring is consistent with the stated J11 scope. No runtime recovery or production migration is claimed.

## Verdict
The logic is sound, but the tests do not pin the safety-critical SQL equality and home-only checks or the Zod identity rules. B1 plus the `assert`-stripping defect are small, local fixes.

**REVISE**

END_AUDIT
