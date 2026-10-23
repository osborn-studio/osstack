# Haiku round 1 disposition

- F1: added optional run/task/session receiptRefs filters plus disjoint-attribution tests. Each actual receipt includes identities. Delivery integration constructs a factory per delivery and aggregates all tasks intentionally; no cross-delivery shared instance is supported. Caller confirms this separately.
- F2: fixed. Persist rejects late refs after invocation closed or signal aborted; cancellation test resolves the deferred writer after failure and asserts stable empty refs.
- F3: proposed race reproduction is already rejected by existing final opened-file dev/ino comparison. Restoring the original directory makes final stat identity differ from the outside opened descriptor. Byte-identical hardlinks sharing dev/ino do not demonstrate reading different content or bypass a hash pin. No unqualified atomic-filesystem-snapshot claim; cooperative same-user local files, bounded reads and exact bytes pinned. A stronger portable openat directory-descriptor sandbox is outside this module.
- F4: original task and brief are mandatory host-supplied inputs, intentionally preserved byte-for-byte, not untrusted retrieved pack fields. The module provides no authority through text markers; existing host contract/authorization remains enforcing. Documented this boundary. Escaping original code/instructions would alter authorized task semantics; pack text cannot close its data section.
- F5: fixed. Prompt optional rows now contain only opaque ID, knowledge kind, excerpt hash and text. Full source refs and scope are receipt-only. Test excludes repository and full source ref from final prompt.
- F6: caller-owned FrozenDeliveryContractV2 guarantees full contract digest/brief pairing; text_sha256 separately proves exact brief. Deriving full-contract digest from brief would be wrong. Documented and requested actual caller assertion from integration agent.
- F7: explicitly documented finite receipt cap and invalid optional sources as fail-closed conditions. Optional freshness/budget omissions remain non-fatal. Malformed sources should not silently become trusted knowledge. The bounded evidence contract favors safe failure over executing without complete receipt.

New scope proof distinguishes source repo and candidate execution repo. Loader constructor validates duplicate IDs consistently. Post-start abort/cleanup and pre-abort behavior have adversarial tests.

## Round 2 disposition

- EC-P1-001 confirmed and reproduced RED: cancellation while suspended at yield allowed one eager underlying next. Fixed with checkAbort immediately before every next. Added post-yield cancellation no-advance test.
- EC-P2-001 fixed: sampled_at_ms stays selection time; observed_at_ms is distinct and validated.
- EC-P2-002 fixed: confinedRead maximum is min(per-pack cap, aggregate remaining); never reads a full over-budget pack. Added combined-cap test.
- EC-P2-003 fixed: non-regular source has unavailable code and its own test.
- EC-P2-004 prepared evidence intentionally survives failed dispatch; prepared never proves invocation, explicit in guide. A third pre-invoke phase would still not establish actual invocation and cannot resolve crash ambiguity. Existing caller consumes prepared as preparation-only evidence, never publication proof.
- EC-P2-005 duplicate_id case renamed; added original mandatory digest test and listed missing tests.
- EC-P2-006 documented unsalted-hash guessability and private-evidence handling. Digests are required provenance, not anonymization.

Reliability owner confirmed both callers create one wrapper per delivery and brief/digest from same FrozenDeliveryContractV2. Actual Loop qualification remains separate.

## Final round 3

Haiku returned no confirmed P0/P1; explicitly verified the cancellation fix, separate timestamps, remaining read bound and late-ref guard. Residual P2: same-user path-swap boundary, documented as cooperative local filesystem rather than an atomic filesystem snapshot/sandbox. P3 observations are a non-blocking observed-phase-specific test gap and documented bounded cleanup without stop proof. No source changes after this final review; guide clarified that residual. CLI emits unrecognized_model warning, while result modelUsage reports claude-haiku-5-5; this is requested/invoked model metadata, not independent backend identity attestation.
