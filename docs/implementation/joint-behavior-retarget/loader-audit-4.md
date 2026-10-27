# Audit: #276 supplemental evaluator hardening

**Verdict: PASS.** I found no P0, P1 or P2 defect in the supplied patch. This is a read-only review, as requested. I ran no tests and did not diff against the new main `28d116f3`.

## Prior findings, closed against the final code

| Finding | Status | Evidence |
|---|---|---|
| P2-1: repeated failed artifact reads | Closed | `read()` sets `artifacts.set(digest, undefined)` before calling `readArtifact`. Missing, throwing, oversized, over-budget and hash-mismatch reads therefore all callback once per digest. Bounded bytes are charged before hashing, so unique corrupt objects still consume the 64 MiB budget. The counterexample would be a shared bad digest read three times, and the `missing`/`corrupt`/`throw` tests assert `reads === 1` and three `evidence_unavailable` rejections. |
| P2-2: unknown trusted fields | Closed | `exactKeys` covers target, trust, each key, revocations, each policy, the `requiredScenarios` level map and each scenario. The profiles are strict zod objects. Tests cover all seven cases, including the digest-pinned policy ones. |
| P2-3: export inventory | Closed | The inventory line and `index.ts` match, and there is no runtime change. |
| P2-4: R01/J01 drift | Closed | The comment and guide say `Behavior*` keeps its v1 canonical bytes, SHA-256 pins and signing payload. They say there is no conversion, that J02a `source_inspection` output is not a `BehaviorSourceManifestV1`, and that unification needs R05/J10 migration vectors. I saw no change to `canonical`, `parseArtifact` semantics, the signature payload or the digest inputs. |
| P2-5: epoch floor and sentinel | Closed | The floor applies only to `revocations.epoch`. The per-record check is `revocation_epoch > revocations.epoch`, and the old-epoch test covers it. The guide documents that `sha256: ""` is a sentinel, not an identifier, and distinguishes `invalid_context` from `qualification_batch_oversized`. |
| Round 2: invalid manifest reparse | Closed | `sourceManifests` caches `null` on parse failure and the `JSON.parse` spy test asserts one parse. |
| Round 2: malformed echoes | Closed | `expectedRegistrySha256` is echoed only if it is a string, `evaluatedAtMs` falls back to `0`, and `input?.` handles undefined input. The malformed caller object is never placed in the frozen snapshot. |

## Compatibility and claims

- Behavior V1 semantics are unchanged. Wire fields, canonical bytes, signing payload and revocation digest binding are as before.
- The one behavior change is that extra fields on the trusted target, trust, key, policy and scenario objects now reject with `invalid_context`. For revocations the rejection is `revocation_unavailable`. This is documented, the evaluator is experimental, and the docs say no daemon path calls it. I treat it as intended hardening, not drift.
- The guide's claims match the code: one read per digest, the 256-document and 64 MiB rejections, the sentinel digest, and the floor semantics.
- The patch makes no claim that J11 locks are recovered, and it claims no host authorization, R05/V06 trust service, runtime registration or provenance fetch.

## Optional, not defects

- The policy `exactKeys` pass runs on `input.policy` and the later `structuredClone` runs on the same object. A caller with accessors could differ between the two. The caller is a trusted host and the evaluation is synchronous, so I treat this as documented typed-library scope. Cloning first and then validating the clone would remove it.
- The new tests sit at file top level, outside the `describe` block. That is style only.

## Deferred or unverified

- **#279 terminal-producer fence:** pending separately and not absorbed here.
- **Full test run:** the combined candidate on the new main still needs its own full run. The earlier 6263-test PASS was on the `8fed` baseline.
- **Merge-base diff:** I could not confirm that the patch is exactly the hardening plus changeset on top of `28d116f3`. The supplied diff is consistent with that, but the merged main's evaluator file was not shown.
- **R05/V06 trust, revocation persistence and rotation:** documented as out of scope and not implemented.

END_AUDIT