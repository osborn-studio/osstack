**Verdict: PASS.** I found no P0 or P1 defects. The P2 items below are non-blocking hardening and test gaps. This is a static read of the diff only; I ran nothing, including the tests.

## Present defects

**P2-1: failed source-manifest parses are not cached** (`behavior-registry.ts`, `sourceError`)
- Only a successful parse is stored in `sourceManifests`.
- Counterexample: 24 registry entries cite the same corrupt 8 MiB manifest. The bytes are read once but parsed up to 24 times, so up to 24 synchronous `JSON.parse` and zod runs of the same bad input.
- This is bounded and fails closed, but it contradicts the "read once, failure not forgiven" intent.
- Minimal fix: store a failure sentinel keyed by `source_manifest_sha256` and return `source_manifest_invalid` from it.

**P2-2: `policy` has no exact-field check, unlike `target`, `trust`, `key` and `revocations`**
- The policy digest covers extra fields, but the evaluator only reads `capabilityId`, `contractVersion` and `requiredScenarios`.
- Counterexample: the host pins a digest over `{…, forbiddenScenarios:[…]}`. The digest matches and the field is silently ignored, which is the same "future field silently ignored" hazard this PR closes elsewhere.
- Minimal fix: use `exactKeys` on each policy item and on each scenario item, and reject with `invalid_context`. Add one test.

**P2-3: pre-validation echo and freeze of caller values** (`reject` and `snapshot` construction)
- `evaluatedAtMs` and `expectedRegistrySha256` are copied into the result before validation.
- Counterexample: `nowMs: NaN`, or `expectedRegistrySha256` set to an object, returns a "rejected" snapshot that violates its declared types. The recursive `freeze` then freezes the caller's own object.
- `evaluateBehaviorRegistry(undefined)` throws a `TypeError` before the `try` block instead of returning a rejection.
- Minimal fix: wrap the initial reads in the `try` block, and echo only values that passed `safeInteger` or `digestPattern` (otherwise `0` or `""`).

**P2-4: missing tests for the headline resource claims**
- Nothing exercises exhaustion of the 64 MiB evidence budget: a later read fails closed and the budget stays charged on mismatch.
- Nothing tests the 8,192-entry manifest cap or the registry's 24-entry cap, or P2-1 and P2-2 above.
- Minimal fix: add one budget-exhaustion test (e.g. 9 distinct 8 MiB objects) asserting the later entries are ineligible, and one oversized-manifest test.

## Claims I checked and found consistent with the code
- **Authorization:** the output always carries `authorization:"none"`, and the docs and changeset disclaim trust-context authentication, operations-root verification, epoch persistence and daemon wiring.
- **Record-ID conflicts:** they are scoped to `(signer_key_id, record_id)` and computed only after authentication, matching the docs and tests.
- **Revocation:** it is by full-document digest. The old `revokedRecordIds` shape is rejected through exact-key checking.
- **Canonical bytes:** the canonical-bytes round-trip rejects duplicate keys, BOMs and alternate numbers.
- **Signatures:** the base64 shape check forces zero padding bits.
- **Artifact reads:** each digest is read once, with the budget charged before hashing.
- **Mutation during evaluation:** inputs are cloned or copied before the artifact callback runs, so mutation during a callback cannot change the evaluated snapshot.

## Deferred and out of scope
- **#279 (terminal-producer fence):** not in this diff, and the changeset and guide never claim it. It stays deferred. I suggest one sentence in the PR description saying so, so it is not read as absorbed here.
- **#278 (Session start outcome and held admission when cleanup throws):** no Session code is in this diff. It is out of scope here.
- **J11:** the guide correctly calls it a recovery specification and claims no automatic lock recovery.
- **J01 and J02a:** the guide states there is no implicit `Behavior*`↔`Joint*` conversion and that `source_inspection` is not a source manifest.
- **Deferred to R05/V06:** trust-context authentication, operations-root signature verification, epoch persistence and equivocation detection, and revocation retention and pruning.
- **Torsion-component Ed25519 keys:** only the small-order encodings are rejected, and the guide says so. It is not a defect for this PR.

END_AUDIT