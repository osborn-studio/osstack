# Audit of PR #276 at 9b13e040 (R02 behavior registry evaluator)

I reviewed the diff by reading only, as instructed. I did not run the tests, so the test counts in the host notes are unverified here.

## Verdict: PASS

I found no actual P0, P1 or P2 defect in the final code. Counterexamples I tried and could not make succeed:

- **Canonical bytes:** duplicate keys, `\u`-escaped text, `1.0`, BOMs and trailing whitespace all fail `canonical(value) !== raw` (`behavior-registry.ts`, `parseArtifact`). Key sort order matches RFC 8785's UTF-16 code-unit order.
- **Signature scope:** the signed bytes are `canonical(payload)`, the key must match role, capability and profile hash, and the signature regex forces exactly 64 bytes.
- **Revocation:** revoked-key and revoked-digest checks run on every record, so a revoked predecessor is never in `verified` and `chain()` cannot reach it. The epoch floor applies to the snapshot, not to issuance, as documented.
- **Record-ID conflicts:** only authenticated, current and bound records can create an `(signer_key_id, record_id)` conflict. An unsigned or forged duplicate cannot poison a legitimate chain.
- **Cross-capability predecessors:** `chain()` checks capability and level at every hop, and the level decreases, so there are no loops.
- **Dependencies:** a missing dependency, a version mismatch, a cycle (including diamond joins) or an ineligible dependency all propagate to the parent. The 24-pass relaxation covers the maximum depth of 24 nodes.
- **Expiry bound:** `validUntilMs` is the minimum of the revocation expiry, the revocation age bound, every record in the chain, and every dependency. It always exceeds `nowMs`.
- **Input mutation:** `target`, `trust`, `policy`, the registry bytes and the qualification bytes are all snapshotted before the first `readArtifact` call. Mutation from inside the callback cannot change the evaluation.
- **Resource bounds:**
  - Raw batch count and bytes are checked before any artifact read.
  - Every attempted artifact digest is cached, including failures, and charged before hashing.
  - Source manifests are cached, including invalid ones.
  - Evidence budget exhaustion fails closed.
- **Small-order keys:** the 7-entry table with the sign bit masked matches libsodium's list, including the p and p+1 aliases.

## Prior findings

P2-1 through P2-5 and the round-2 items are closed against the final code:

| Finding | Closed by |
|---|---|
| Repeat corrupt reads | `read()` cache (`behavior-registry.ts`), three-way once-only test |
| Unknown fields | `exactKeys` on target, trust, key, revocations, policy, levels and scenario, with tests |
| Export inventory | `PUBLIC_EXPORTS.md` and `index.ts` match |
| Behavior*/Joint* separation | stated in the comment and the guide; no conversion code exists |
| Old-epoch revocation | dedicated test |
| Manifest parse count | null sentinel plus `JSON.parse` spy test |
| Echo normalization | `typeof` guard and `safeInteger` guard, test present |

## Optional improvements (not defects)

- **P3, `this` binding:** `const readArtifact = input?.readArtifact` is called unbound. A host that passes `store.read` from a class instance gets a swallowed `TypeError` and every artifact becomes unavailable. This fails closed but is hard to diagnose. Either document that the callback must be bound or call it as `input.readArtifact(...)`.
- **P3, guide gaps:** the guide never defines the preimages of `profileSha256s` (SHA-256 of canonical profile) or `required_scenario_set_sha256` (SHA-256 of canonical sorted scenario IDs). A host implementer must read the code to get these right.
- **P3, stale wording:** the guide says the host API "no longer accepts the earlier bare `revokedRecordIds` list". That API never shipped on main, so the sentence refers to an in-PR iteration. The changeset filename `behavior-registry-loader.md` also says "loader" for an evaluator.
- **P3, test gaps:**
  - The single oversized-document path (`qualification_oversized`, `sha256: ""`) is untested.
  - The 64 MiB evidence-budget exhaustion path is untested in the repo; the host cites only an external subagent run.
- **P3, bundle re-parsing:** evidence bundles are re-parsed per record, since only the read is cached. This is bounded by trusted signers and the schema's 1000-entry cap.

## Deferred and out of scope (correctly not claimed)

- **#278 and #279:** the diff contains no Session or cleanup code, so #278 is not verified here. The #279 terminal-producer fence is separate and pending; nothing in this PR claims it. It must not be inferred from this change.
- **R05/V06:** trust authentication, operations-root verification, the persisted epoch, and revocation retention and pruning.
- **R03/R04 and J02b:** source extraction, provenance mapping and J02a `source_inspection` mapping to `BehaviorSourceManifestV1`.
- **R05/J10:** migration vectors before any codec unification.
- **J11:** the guide treats it as a recovery specification and makes no claim that locks are automatically recovered.
- **Host-side items:** mixed-order (non-small-order torsion) keys, remote Git content proof, and evidence semantics. The guide disclaims all three.

END_AUDIT