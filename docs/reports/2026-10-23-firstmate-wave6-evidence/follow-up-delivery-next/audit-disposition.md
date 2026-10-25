# O2a Haiku audit disposition

## Round 1

- P1 consumed grant overwritten by revoke: accepted. Revocation updates only active grants, consumed is permanently terminal in the DDL, and a separate immutable event records revocation after start. Added actual in-flight race assertions.
- P2 stale sender receipt after revoke/reconcile: retained deliberately conservative behavior. Once another action advances the revision or uncertainty is returned, late sender outcomes cannot silently overwrite it. Explicit trusted lookup can resolve unknown; no resend is permitted. No provider availability guarantee is claimed. Added race/lookup test and docs.
- P2 clock regression prevents revocation: accepted. Revocation uses a monotone logical record timestamp with explicit event basis even for an invalid/regressed clock. Issuance and dispatch retain strict clock validation. Added three regressions.
- P2 author/thread receipt binding: strengthened target with actor_node_id and receipt with author_node_id; exact equality checked along with immutable target_node_id. Real adapter must authenticate those facts and per-attempt correlation from provider, not echo request values. A malicious trusted adapter cannot be authenticated by adding fields; that host trust boundary is explicit. Wrong-author regression added; no real adapter bundled.
- P2 second delivery after delivered: clarified intended cardinality. A subsequent explicit message for the same promise is allowed only through a fresh immutable attempt and fresh separately reviewed grant. Unknown/started block replacement. Added no-authority-reuse test.
- P3 consumption changes count: accepted; require exactly one row before started.
- P3 lone surrogate body: independently found and fixed during round 1. Text must roundtrip exact UTF-8; tests reject lone surrogates and preserve valid Unicode without normalization.
- P3 expired authorization blocks prepare: intentional safe reservation; explicit scoped revoke is the documented recovery, never automatic resend.
- P3 list cost: bounded <=50 rows/64KiB; retained integrity checks rather than adding denormalization in this security-sensitive increment. Not a production provider throughput claim.

No real external provider or signing UI is shipped. Static audits do not confer production qualification. CLI requested claude-haiku-5-5; raw CLI result includes canonicalModel=claude-haiku-5-5/provider=firstParty but CLI also emitted unrecognized_model. These are reported metadata, not independent backend attestation.

## Round 2

- Conditional P1 durability: confirmed existing openDb uses WAL/NORMAL. Scoped O2 durableWrite now verifies WAL, temporarily uses FULL (and fullfsync on macOS), performs immediate transaction and restores settings synchronously before transport. Existing db.ts unchanged. Tests inspect actual pragma at consumption and restored settings at transport entry, reject non-WAL; SIGKILL retained but no physical power-loss proof claimed. Primary reference https://www.sqlite.org/pragma.html#pragma_synchronous and #pragma_fullfsync.
- P2 expiry revived after observed time rollback: accepted. Migration45 adds a durable clock high-water row. Failed checks persist observed valid times in a separate FULL transaction after rollback; subsequent admission below high-water fails, including service restart. Trusted host clock remains prerequisite for never-observed elapsed time; no independent time oracle claimed.
- P2 post-send wall clock validity: accepted. Evidence and revocation use logical monotone time; valid receipt persists despite regressed/invalid time. Database I/O failure still reports an error and retains durable started/uncertain state, rather than fabricating a successfully persisted unknown result.
- P2 moved repo prevents revoke/inspection: accepted. Read/revoke/reconcile use exact historical canonical path string match (no fallback/rebinding); new prepare/authorize/dispatch still need live canonical directory. Move regression covers old scope recovery and rejection of new scope.
- P2 two-connection test alleged invalid: reviewer overlooked revision(row, expected_revision), which executes before state check; the second original revision is rejected as CAS conflict. Actual test passes. It tests two connections in one process, not simultaneous child-process lock contention; documentation makes no cross-process contention test claim. Separate real SIGKILL test remains.
- P3 mixed control text / BOM: exact data with escaped JSON review is intentional, documented. Decoder now ignoreBOM:true preserves legitimate leading BOM; lone surrogates still rejected. Added mixed-control and BOM test.
- P3 cursor case: accepted; after_id normalized to lowercase. Added protocol regression.
- P3 generated artifacts / unseen registration: tracked knowledge dist files are known build-only changes restored before commit. Third audit includes db.ts, migration registration and package exports. No knowledge source or artifact included in delivery commit.

## Round 3 and final scope

- P1 withWrite is DEFERRED: confirmed. Earlier audit framing incorrectly described the existing helper; actual db.ts remains unchanged. O2 now calls the existing preflightDiskSpace and an explicit delivery-local db.transaction(...).immediate(). Its failed-clock persistence transaction is also IMMEDIATE. New real second-connection held-write-lock regression asserts no attempt-row read, no authority consumption and no provider call before claim lock acquisition. Root will independently audit the integrated final code; no fourth component review is claimed.
- P2 forward clock excursion: conservative admission quarantine is documented. No unsafe reset or grant revival path added. Clock recovery requires separately reviewed operator tooling before production qualification.
- P2 registry changes prevent reconcile: documented availability limitation; keep historical registrations through uncertainty. No real provider registered.
- P2 transport without lookup may send: documented qualification limitation; production qualification must reject such adapters. Generic service currently allows it; do not claim otherwise.
- P3 read snapshot consistency: documented adjacent-observation limitation; CAS prevents incorrect mutation. Follow-on improvement, not a forged-authority path.
- The lowercase pagination fix was applied after round3 snapshot when its new regression exposed a missed replacement; protocol tests pass. Final P1 fix and held-lock test also postdate round3 and are to be covered by root integrated audit. The raw round3 verdict is retained unchanged, not presented as accepted/clean.
