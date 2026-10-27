# Audit dispositions

Original Claude reports are retained verbatim. Round1 REVISE; round2 used PASS while still listing P2 concerns, so the owner did not treat it as closure. Round3 PASS reports no actual P0/P1/P2.

- Repeated corrupt/missing/throwing artifact reads: confirmed; cache every attempted digest. Keep charging bounded bytes BEFORE hashing to bound real work; do not refund corrupted data.
- Unknown target/trust/key/revocation and policy/scenario fields: confirmed forward-compatibility hazard; exact field checks now reject them. Signed wire bytes remain unchanged.
- Repeated parsing of shared invalid source manifests: confirmed; cache an invalid sentinel. A parse-count regression verifies one parse; independent test covers 24 signed capability chains.
- Invalid scalar echoes: normalize malformed values to primitive sentinels; never freeze the caller's object. Null/undefined input safely rejects.
- Export inventory: generator records export lines. Put the new type export on one line and regenerate; no generator behavior change.
- Stale J01 comment and old-epoch ambiguity: clarify separate R01 Behavior* / J01 Joint* signing and digest domains, J02a inspection mapping responsibility, complete current revocation snapshot semantics, and rejection sentinels. Add old-epoch/revocation regression. Identity-key test title now states rejection occurs before signature verification.
- #278/#279 absence: these are separate PRs, not missing implementation here.

Core already imports crypto/protocol. Measured incremental evaluator module load after those existing dependencies: about 1.01ms; CLI startup budget passed. Cold isolated evaluator import includes existing protocol initialization and is not the incremental barrel cost.

Independent final candidate checks include 120 random dependency graphs in both record orders (5,760 capability projections), expiry propagation, revocations, cross-capability predecessor, callback mutation, raw/evidence budgets and negative caches. These supplement 55 repository evaluator tests. They do not establish issuer authority, real provenance or live-host qualification.

Optional P3 items from round3 remain documented suggestions, not falsely closed blockers: callback binding guidance, additional repository boundary tests, and evidence bundle parse memoization. R05/V06 trust custody, J02b/R03/R04 mapping and J12 recovery remain separate.

The user merged old #276 head5e86 while audit hardening was being prepared. New #282 code85e19da8 is based on main28d116f3. Round4 independently reviewed this exact supplemental diff and returned PASS without P0/P1/P2. Its fresh full run has6269 passed/5 skipped/0 failed; earlier9b13e040 results remain historical. Exact raw inputs and code/base/diff binding are preserved.
