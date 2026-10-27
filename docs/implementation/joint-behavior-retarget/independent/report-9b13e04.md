# Independent PR 276 adversarial verification — repaired candidate

Candidate code SHA: `9b13e04022b3068987d3807414b75f07aa2d265b`.

Result: PASS, 12 test groups. This evidence supersedes the original candidate run for the scenarios below. The original `a2f3a3f` input, output and report remain preserved.

## Independent verification

A standalone Node script generates fresh Ed25519 signers and a complete qualification chain for each of 24 capabilities. Its recursive dependency oracle is separate from the evaluator's iterative graph propagation. Across 120 deterministic randomized graphs, eligibility agreed for cycles, transitive dependency failures, and revocation at each qualification level. Reversing all qualification documents produced identical snapshots: 240 registry evaluations and 5,760 entry projections.

Additional cases passed:

- Full 24-node dependency chain propagates the shortest qualification expiry to every parent.
- Host artifact callback mutations do not alter snapshotted qualifications, trust or policy.
- A shared throwing source read is cached; no repeated read and no retained eligible chain.
- Unknown target, trust, key and revocation properties reject before artifact reads.
- A Joint-style document cannot substitute for an R01 behavior registry.
- A validly signed journey pointing to another capability's host qualification remains ineligible.
- 65 MiB raw qualification padding in either leading or trailing position rejects before artifact reads.
- 72 authenticated evidence claims with distinct digests receiving corrupt 8 MiB objects fail closed. Digest reads are unique. The test bounds observable callback work; it does not directly instrument internal hash or copy CPU. Inspection confirms byte-budget debit precedes hashing.
- Unknown fields at each policy object level reject even after the host recomputes the policy digest, preventing digest mismatch from masking schema rejection.
- Cyclic caller-owned objects supplied as invalid scalar echoes remain mutable and are not retained in output. Null and undefined top-level inputs reject safely.
- 24 otherwise-valid signed chains referencing the same malformed source manifest all become ineligible. A temporary process-local JSON.parse counter confirms precisely one manifest parse; no qualification authentication errors mask this assertion.

## Reproduction and evidence binding

Run `python3 run-final.py` in this directory. It checks the expected Git SHA, invokes Node 22 against the candidate's built behavior-registry module, records the command exit status, and requires source and built-module SHA-256 hashes to remain unchanged throughout the test. The script writes `results-9b13e04.txt` and `manifest-9b13e04.json`.

No product files, Git state, PRs, OSStack homes or external services were modified. No additional confirmed defect was found. This establishes the tested library behavior under supplied trust assertions, not production host authentication, revocation-root validation, real provider execution or runtime authorization. The result continues to require `authorization: none`.
