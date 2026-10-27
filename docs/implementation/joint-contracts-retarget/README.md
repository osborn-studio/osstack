# J01b retarget and integrity boundary

PR #273 targets main. The inspected main is `4924d224ab9e6e2d7f801d68faea389fedf3751e`, including #272, #275, #277 and #280. The initial main merge preserved the original J01b product patch byte-for-byte. The new audit then required the integrity corrections below. The final candidate is not identical to the original patch.

## Required consumer checks

`decodeJointContract` checks raw JSON and local structure. It does not admit a trusted record. Use `decodeJointContractAs` or the byte variant at an endpoint that accepts one kind. A claimed `host_authenticated`, grant ref, oracle time or measurement is untrusted until the host resolves its immutable record and authorization.

Before admitting a binding, call `verifyMethodBinding`, then call `verifyBindingAgainst` with host-loaded proposal/recipe. Resolve the contract and verify actual scope separately. `MethodRecipe` checks every role digest against its aggregate requirements. A digest constructor accepts a placeholder self digest; it is not an admission function.

Recovery consumers must load immutable proof envelopes, authenticate the producer, rehash raw evidence bytes and call `verifyRecoveryProofEnvelopes`. The join compares exact proof content, subject, owner generation, binding generation, support profile, phase, schema spec, recovery build and chronology. The envelope now requires these context fields; old envelopes must be rejected. The host must additionally verify source instance/generation, cancel receipt, workspace and containment domain from the referenced evidence. Neither a receipt nor an envelope from a client establishes those facts. This structural join has no freshness lower bound and no per-invocation identity; the host must resolve both from immutable records. Only current trusted state plus durable CAS can authorize recovery. Legacy unknown has only an Attention subject with null binding/profile; it cannot impersonate a new effect.

`trialBudgetIssues` checks exact profile digest and repository plus the represented budget axes. It always returns `adapter_invocations_unattested` because profile v2 cannot attest this cap. An empty list cannot be used to activate a trial. The host must separately enforce `max_root_runs`, current usage, expiry and authorization; a later profile/consumer change must resolve invocation measurement before trial admission. A profile's `actions` axis does not prove an invocation cap. No trial consumer exists in J01b; J08 cannot activate without evidence for every required cap.

## Boundaries retained from the design

- Gate evidence is a claim. The host gate registry must resolve the expected oracle/revision and immutable custody/result records, authenticate independent principals, verify exact candidate/profile and monotonic history. Candidate SHA binds Git source; no new duplicate raw-code-hash field is introduced here.
- Recovery idempotency belongs to the immutable request ledger: `(authenticated principal, request_id)` plus `recoveryRequestInputDigest` and current scope. A receipt alone is not an idempotency database. J11's request index stores that digest separately. J12 must compare it transactionally before returning an old receipt.
- SourcePin is a Git-object identity, not permission to fetch/materialize. Git SHA-1 and SHA-256 IDs are deliberate. R01's HTTPS/SHA-1 source shape is narrower. J02b must reject unsupported mappings explicitly; it cannot truncate hashes or assume that every SourcePin is a BehaviorSource. Paths such as Windows aliases must not be materialized merely because a manifest parsed. Repository identity remains caller asserted; do not put secrets in source identifiers.
- The ten `material:*` schemas are descriptive bodies, not host evidence envelopes. Their use in a requirement does not create a satisfiable host artifact automatically. J04/J07 must bind each body to kind/schema/policy, run/effect/binding and content bytes before adoption. Until that registry/envelope exists, reject such admission. Existing contract/config digests and raw content hashes keep their existing algorithms; J01 does not replace them with arbitrary new domains.
- `ContextReceipt` records a prompt observation, not exactly-once delivery or provider-wire evidence. J04/J08 must associate preparation/observation with the trusted run/attempt ledger and reject orphan/replayed observations. No proof of that runtime exists here.
- The protocol root stays opt-in. The build-only `joint-generate` module is excluded from package subpath imports; its schema-generation script uses an internal relative import. The generator is also excluded from published files. It remains a developer operation.
- Direct Zod schemas validate local structure. Use raw decoders for wire data and typed digest/verification helpers for integrity. Neither allows hostile JavaScript proxies or establishes provenance.

## Downstream action

#274 and #281 retain their old pinned base and historical evidence. Both remain blocked until #273 merges, then they must integrate these changes and rerun their checks. J11 must consume the expanded proof envelope and verification join. No production migration or runtime activation is part of this PR.

SourceSnapshot file order is normalized; dependency array order is intentionally part of identity. Ref string checks do not prove identity or alias independence. Host identity resolution is mandatory even for canonically different strings. SourceSnapshot is syntax-only: J02b must apply Git verify_path/platform checks before any materialization; Windows/HFS dotgit aliases remain outside this parser.
