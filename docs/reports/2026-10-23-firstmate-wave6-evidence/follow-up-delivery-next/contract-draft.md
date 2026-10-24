# O2a contract draft — local qualification, no real provider sends

R1 audit is still running. This is planning only, before the new O2 branch.

## Authority

O1 obligations remain unchanged: destination_ref local_operator and fulfilled_local never assert public delivery. O2 attempts reference an exact O1 obligation/revision and canonical default-tenant repo, plus an immutable prepared envelope.

Envelope preparation resolves a destination_ref from a HOST-OWNED registry. Requests cannot supply arbitrary URLs, recipient IDs, provider IDs, credentials, or transport implementations. The registry pins provider identity and exact target identity. Prepared output shows exact body, target label/thread, body digest, destination digest, envelope digest, attempt ID, and parent obligation/version. Text is data, not authority.

Authorization uses a new domain-separated Ed25519 SignedFollowUpDeliveryGrant. It binds grant_id, attempt_id, canonical repo/default tenant, provider ID, destination digest, body digest, envelope digest, issued_at_ms, expires_at_ms and max_calls=1. Host-owned trusted key registrations are purpose-specific and constrained to repo/provider/destination refs/max validity. Unknown/revoked/mis-scoped keys, future/expired grants, modified content/target and replay fail closed. No signing key is generated/loaded by the CLI; authorize accepts a previously reviewed externally signed grant. Actor fields are audit labels only. Existing broad contract approvals and continuation grants cannot grant this capability.

Revocation only removes authority. A host-authenticated scoped revoke call persists revocation. Before dispatch, verify signature, current trusted key/scope, time validity and revocation again, then atomically consume the one-attempt authorization with the started CAS. Changes after consumption cannot undo an already dispatched message; they never authorize a retry.

## State and dispatch

Migration 45 (root reserved) adds immutable-envelope attempt rows, grant consumption/revocation state, and append-only transition events; all writes use withWrite and explicit scope. Parent O1 data is not mutated by a send.

Attempt states: prepared, started, delivered, definitely_not_sent, delivery_unknown. Authorization is separately attached/revoked, not inferred from task state. prepared -> started is a durable compare-and-swap BEFORE calling transport.sendOnce. At most one sendOnce invocation for an attempt, even with two service instances/processes. A started attempt is never resumed by invoking send again after a crash. Timeout/disconnect/throw after start => delivery_unknown. Unknown and orphaned started attempts block replacement attempts for that obligation, not just the same idempotency key. Content edits require a new explicit prepared envelope and grant after the previous outcome is safely resolved.

The provider port is host-registered, with retry policy none. Declared capabilities are not qualification. No provider is registered by default; dispatch reports qualification_pending/unsupported and remains unsent. Fake transport exists only in isolated tests. O2b must add one actual provider, prove SDK automatic retries disabled, and pass explicit sandbox qualification before shipping real sends.

A pre-dispatch validation failure can be definitely_not_sent because no transport invocation occurred. A provider throw/timeout or bare boolean cannot prove not_sent. Any provider-specific not-sent proof must be structurally strong and part of the later qualified adapter; safest O2a treats every post-invoke uncertainty as unknown.

Late transport promises never silently revise an already returned timeout outcome. Keep a bounded wait, record unknown, ignore late results, and reconcile explicitly through a registered provider lookup. A stale dispatcher cannot overwrite a newer revision/outcome. Lookup failure/not-found/target-deleted is not evidence of non-delivery and never permits resend.

## Receipt authenticity

CLI/RPC reconcile accepts only attempt identity and expected revision; it never accepts delivered=true, caller-authored receipt bodies or URLs as proof. The service calls the registered provider's lookup for the immutable attempt identity. Returned receipts must bind exact provider/account, immutable target identity, body digest, attempt correlation and provider message/request IDs. Same-body messages by another author or in another thread are rejected. Provider response claims are only meaningful within a trusted qualified adapter; no fake result is production qualification.

The attempt persists receipt evidence/provenance and qualification level. Successful send is independent from the O1 promise condition. O2 must not set fulfilled_local or treat delivery as fulfillment.

## Interfaces / root wiring proposal

Core FollowUpDeliveryService(db, dbPath, {registry, trustedKeys, nowMs?, timeoutMs?}) has prepare/list/inspect/authorize/revoke/dispatch/reconcile methods; handle(method, params) routes fixed methods only. Constructor has no DB writes or migrations. RPC params always canonical repo/default tenant and CAS where mutating. Root daemon injects trusted registries, identities and actual authorization boundary; default empty maps fail closed. No graph/auth bypass.

CLI dedicated follow-up-delivery prepare/list/inspect/authorize/revoke/dispatch/reconcile uses existing daemon RPC, no direct DB/provider fallback. Files and results bounded, exact raw body hash, safe terminal rendering. Root owns bin/daemon/protocol exports/schema generation; our new core service/DDL/tests, protocol schemas/tests, command/tests, guide/plan; migration45 explicitly permitted.

## Qualification tests

Actual signed keypairs in isolated tests; wrong-purpose/mis-scoped keys, fake actor, expired/future/revoked grants, tampered bodies/targets; duplicate idempotency keys/CAS; two SQLite connections dispatch same attempt concurrently; send success response lost; timeout/late response; crash after started before receipt; non-idempotent SDK policy rejection; no registered provider; fake delivery through real RPC chain at root; wrong author/thread/body/provider/attempt receipt; target deletion; cross-scope reads; source cleanup and O1 independence. Assert actual fake sendOnce call count <=1 per attempt. Real public provider qualification remains pending, and development sends no external message.
