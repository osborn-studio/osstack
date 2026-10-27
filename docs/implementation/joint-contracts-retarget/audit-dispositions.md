# Fresh Sonnet 5.5 audit dispositions

The complete tool-less model inputs, original outputs and execution metadata are retained in evidence. Findings are evaluated against code and the prior J11 specification; model severity is not independently established.

| Finding | Disposition |
|---|---|
| Code P1-1 recipe and binding integrity | Accepted. Recipe role digests are recomputed from the aggregate. `verifyMethodBinding` rejects a mismatched self digest. Negative tests cover swapping roles and modifying aggregate, digest or authorization. Structural decoding remains separate from admission. |
| Code P1-2 proof replay across context | Accepted as an API hardening gap. Proof envelopes now carry binding/profile/phase/schema/build in addition to owner generation. The exported join validates each exact proof and context against the receipt. Tests mutate all six context fields. Raw containment/source facts still require authenticated immutable evidence loading and current-state CAS. |
| Code P2-1 legacy identity | Accepted. Reject effect+legacy_unknown and non-null legacy binding/profile. Preserve valid legacy Attention receipts. |
| Code P2-2 request digest in receipt | No wire duplication. J11 explicitly persists the request-input digest in its separate idempotency index and checks it in the current owner transaction. A receipt is not that index. Retained as a mandatory J12 integration obligation. |
| Code P2-3 gate oracle/time authority | Runtime obligation, not a parser guarantee. Gate registry/custody/identity authentication is required before admission. The README now states it locally, rather than relying on the downstream J11 branch. |
| Code P2-4 permit/profile mismatch | Accepted. Budget compatibility rejects a different profile digest or repository. Invocation/root counters remain separately required host checks; no claim that actions proves invocation enforceability. |
| Code P2-5 R01/source mismatch | Retain deliberate SHA-256 Git support and manifest-only scope. R01 is narrower; J02b must reject unsupported mapping. No materialization or network authentication is delivered by SourcePin parsing. |
| Code P2-6 material bodies and external digests | Clarified as unavailable for adoption until J04/J07 supplies the typed registry/envelope. Existing external digest algorithms are not replaced. Requirements declarations are not evidence of completion. |
| Code P2-7 context receipt replay | Retained for J04/J08 trusted attempt association. No current consumer or exactly-once assertion. |
| Code P2-8 endpoint kind and private generator | Accepted. Added typed kind-specific raw/byte decoders and negative tests. Root stays opt-in; build-only generator subpath exports are blocked and tested. |
| Code P3 direct schemas/identity aliases/frozen chronology | Existing strict wire decoder and host alias registry remain required. Frozen custody precedes a future candidate; executed state adds candidate/time. Prior audit explicitly corrected this in the J11 implementation notes. Python tooling is an explicit test dependency. No state or runtime claim added. |
| Ledger old predecessor history | Accepted. Retain old SHA and immutable historical evidence URL on J01; require it when a successor is stale. |
| Ledger snapshot times | Accepted missing timestamps. Refresh every PR and require a timezone-bearing per-PR observation time. Different observation times remain legal, explicitly timestamped observations; no pretend live-forge check. |
| Ledger stale node/results | Accepted. Node and board both blocked; prior validation/audit explicitly historical; tests reject promotion or relabelling. |
| Ledger slice and evidence checks | Accepted in checkpoint scope: enumerate slice states, compare observed head/base, require Draft while revalidating, reject missing/escaping evidence paths and unknown base PR. Local tests cover negative cases and J11. |
| Ledger scope overclaims | Offline checkpoint validation cannot authenticate installed management binaries, live CI or Git ancestry. These remain separately collected evidence. Handoff acceptance means receipt of the sender's work, not qualified runtime completion. The existing explicit scope remains. |

The initial broad test run overlapped later audit fixes and is retained only as an intermediate log. Only a subsequent frozen final-code run can support final validation claims.

## Second audit

The second report returned PASS with follow-up findings. We still corrected its actionable local gaps before Ready:

- P2-1: mutate the envelope, not an already-invalid receipt; assert PROOF_CONTEXT_MISMATCH for all six fields. Add a valid different-subject counterexample.
- P2-2: fail closed with adapter_invocations_unattested; profile v2 cannot qualify that budget.
- P2-3: export verifyBindingAgainst and test recomputed self digests with swapped roles and a mismatched proposal.
- P2-4: retain the scoped structural identifier checks. String normalization cannot establish identity or defeat aliases; the host registry must authenticate and resolve principals before any independence claim. No runtime identity consumer is enabled.
- P2-5: state syntax-only source scope and future Git verify_path/platform obligation; narrow the test title to the actual hazards it checks.
- P3 packaging: exclude the private generator from published files as well as exports. Clarify proof freshness/invocation limits, dependency order and timestamped candidate observations. The fixture/schema layers remain structural; independent Python parity covers six constructors, not every domain.

Checkpoint candidate_sha/head_sha are explicitly observed PR heads at each PR observed_at timestamp, not hashes of the commit that contains the checkpoint. This avoids circular self-reference. Later metadata-only pushes require a fresh live PR read before approval.

## Third audit

The third report returned PASS with one concrete P2: Zod safeParse could throw on a dirty nested recovery subject. Both refinements now catch subject parsing/canonicalization failure and emit INVALID_SUBJECT. New negative tests cover empty and lone-surrogate IDs for the direct schemas and union. The P3 broker-proof test now asserts its actual rejection reason; a separate positive case verifies committed Attention containment. Other P3 profile/alias/trial-join suggestions remain disclosed downstream requirements, not implemented runtime guarantees.

## Final focused audit

Fourth report: PASS, no concrete revision required. It confirms the dirty-subject fix and the test correction. Its non-blocking note about not pinning the INVALID_SUBJECT message is accepted: the regression under test is safeParse returning failure without throwing. All product files match either the full third-review manifest or the fourth-review delta; audit-code-binding.json records the exact final code hashes.
