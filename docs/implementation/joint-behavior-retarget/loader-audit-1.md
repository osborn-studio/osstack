# Review of #276 (R02 behavior registry evaluator) at f614c89d

**Verdict: REVISE.** I found no P0. The core logic holds up against the counterexamples I tried: replay, key-role confusion, ID squatting, a forged same-ID record, TOCTOU on caller inputs, dependency cycles and batch padding. The remaining defects are one conditional P1 and a handful of P2 items, listed below. Findings are given by symbol name because the diff has no line numbers.

## Present defects

**P1 (conditional): #278 is not in the supplied diff.**
- Counterexample: the diff touches only `behavior-registry.*`, the guide, the changeset, the exports inventory and `index.ts`. It has no Session start-outcome or held-admission-on-cleanup-throw change and no test for either.
- If #278 is meant to ship in this PR, the code, the tests and a changeset for the affected package are missing.
- If #278 is a separate PR, there is no defect here.
- Fix: either add #278 with a cleanup-throw test that asserts the start outcome and the held admission survive, or state in the PR that #278 is separate.

**P2-1: `read()` in `behavior-registry.ts` does not cache failures and charges the budget before verifying the digest.**
- Counterexample: an authenticated record lists evidence digest D. The host store returns an 8 MiB blob that does not hash to D.
- Each `read(D)` calls `readArtifact` again and deducts 8 MiB from `remainingEvidenceBytes` before the hash check. The failure is not cached.
- After 8 attempts the 64 MiB budget is gone. Records and sources that sort later by digest then fail as `evidence_unavailable` or `source_unavailable`.
- A missing digest is never negative-cached either. Up to 256 records × 1000 refs gives about 256k synchronous host callbacks.
- Fix: cache negative results per digest. Charge the budget once per digest, and only after the hash check passes.

**P2-2: unknown fields in the trust and revocation inputs are silently ignored.**
- Only `revokedRecordIds` is special-cased. Any other extra field on `revocations` or on a `trust.keys[]` item is accepted and excluded from `revocationSnapshotSha256` and `trustSha256`.
- Counterexample: a host passes a snapshot with a future field such as `revokedIssuerIds: [...]`. The evaluator treats it as absent and still trusts the keys. The fingerprint does not change either, so the loss is invisible.
- Fix: allowlist the exact keys on `trust`, `trust.keys[]`, `revocations` and `target`. Return `invalid_context` or `revocation_unavailable` on any extra key. Add a test.

**P2-3: `docs/inventory/PUBLIC_EXPORTS.md` is truncated.**
- The diff adds `export type { BehaviorRegistryInput, BehaviorRegistryTrust, BehaviorRegistryPolicy,` with no continuation line.
- It lists neither `BehaviorRegistryEntry`, `BehaviorRegistrySnapshot` nor `BehaviorRegistryEvaluationContext`. It therefore does not match `index.ts`.
- Fix: copy the exact two-line statement from `index.ts`.

**P2-4: a code comment makes a false claim about J01.**
- The comment in `parseArtifact` says "the independent joint-json raw parser under development in J01". J01 is already on main, so the comment is untrue.
- This evaluator carries a second RFC 8785 serializer (`canonical`), which is an unacknowledged drift risk.
- Fix: reword the comment to say the Behavior* canonicalizer is intentionally separate from J01 `Joint*`, with no implicit conversion. Add a TODO naming where unification or cross-vector testing would be tracked.

**P2-5: test and doc gaps.**
- Nothing tests a record whose `revocation_epoch` is below `minimumRevocationEpoch`.
  - The code only rejects epochs greater than the snapshot epoch, so such a record is accepted.
  - The guide never says that older-epoch records rely entirely on the complete revocation snapshot. It should say so, and a test should pin the behavior.
- "rejects an identity-key qualification with trivial R=identity and S=0 signature" never reaches signature verification.
  - It is rejected earlier as `invalid_context` by the key check. The name overstates what it covers.
  - Rename it or split out a test that exercises the verify path.
- The count limit rejects with `invalid_context` and the byte limit with `qualification_batch_oversized`. Oversized or non-`Uint8Array` documents record `sha256: ""`. Both are undocumented sentinels.
- If the `@osstack/core` barrel did not previously import `node:crypto` anywhere, check that no browser or edge bundle consumes `index.ts`.

## Explicitly deferred, not defects here

- #279 terminal-producer fence: nothing in this diff absorbs it. Keep it separate.
- R05/V06 work:
  - authenticating the trust context;
  - verifying the operations-root signature;
  - persisting the epoch floor;
  - detecting equivocation;
  - retention and pruning of revocations.
- A signature domain-separation prefix: deferred under the frozen draft, and the dedicated-key-purpose requirement is documented.
- Authenticating the trusted clock.
- Runtime registration, daemon wiring and provenance fetch.

## Claims I checked

- The guide and changeset consistently say the evaluator does not authenticate its inputs or grant authority (`authorization: "none"`).
- The J11 recovery spec is not claimed as automatic lock recovery. The guide says no operator recovery is part of the change.
- The R01 `Behavior*` schemas are used as-is, with no `Joint*` import or conversion and no wire or signing-byte change.

END_AUDIT