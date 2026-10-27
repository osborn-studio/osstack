# Independent PR 276 adversarial run — original candidate

Code: `a2f3a3f3f417236b036b6f21fe1bc400bf47e0bf`. Built module imported directly; no candidate edits, network, OSStack home, daemon or provider access.

## Results

Nine adversarial test groups passed. Fresh fixture builder generates independent Ed25519 keys and all three qualification levels for each of 24 capabilities. A recursive graph oracle separately computes expected eligibility, including cycles and transitive revocations. 120 deterministic randomized graphs passed, each evaluated again after reversing all qualification records. This covers 240 whole-registry evaluations (5,760 entry projections).

Additional successful cases: a full 24-node chain propagates the terminal dependency expiry; artifact callbacks cannot mutate queued qualifications, policy or trust snapshots; a shared throwing source digest is read once; unknown target/trust/key/revocation fields reject before reads; a joint-style document cannot act as a behavior registry; a validly signed cross-capability predecessor cannot complete a journey; 65 MiB raw padding before or after valid records rejects before artifact reads; 72 authenticated evidence references with distinct hashes receiving corrupt 8 MiB objects fail closed, with no repeated digest read.

The corruption test verifies observed eligibility and callback bound. It does not instrument internal hash/copy CPU counts; source inspection confirms the budget is debited before hashing. Invalid source-manifest parse caching and exact nested policy fields were not covered by this original script and were separately raised by the main Sonnet audit.

## Scope and disposition

No additional confirmed defect emerged from this independent run. This is evidence for the named original candidate, not clearance of the subsequent Sonnet findings. Re-run unchanged scenarios on the repaired candidate before assigning current evidence. This does not attest production host identity, trust-root custody, revocation-root signatures, real provider execution or runtime authorization. `authorization: none` remains expected.

Command: `PATH=/opt/homebrew/opt/node@22/bin:$PATH node adversarial-a2f3a3f.mjs`. Exit status: 0. Full results and SHA-256 bindings are adjacent.
