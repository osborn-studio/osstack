# R1 remote home read-only projection

## Delivery and ownership

This increment implements an explicit, pinned SSH stdio reader of an already running OSStack home. It does not start a daemon, open a database, execute agents, forward arbitrary RPC, or claim remote-host qualification. The root integration owns lazy CLI routing; these modules own protocol, exporter, client, and focused tests.

`remote-home inspect --registry FILE --sha256 HASH --alias NAME [--limit 1..50]` loads a bounded owner-only regular canonical registry file. Each entry pins hostname/port/user, an Ed25519 host public key, an explicit private identity file, home ID, daemon protocol, exporter registry digest, and scope alias. The local registry digest is also pinned by the operator. Registry changes require explicit repinning.

`remote-export --stdio` reads only host-provided `OSSTACK_REMOTE_EXPORT_REGISTRY` and `OSSTACK_REMOTE_EXPORT_SHA256`. Its registry pins home ID, daemon protocol, explicit canonical same-UID socket, and canonical repository scopes with explicit default tenant. Requests cannot replace these paths. SSH invokes exactly the literal `osstack remote-export --stdio`; deploy it with a restricted SSH account/forced-command wrapper that sets the registry environment and does not permit port forwarding. The client does not install or modify SSH configuration.

## Wire and authorization

Version 1 uses UTF-8 JSON behind a four-byte big-endian length prefix, at most 65,536 bytes including header. A connection has exactly two sequential exchanges: hello (nonce, protocol, home, server-registry digest, scope), then snapshot (channel token, sequence 1, limit). The exporter grants a random connection-local read-only token only after matching the registry and current daemon identity. Strict schemas reject every other method and unknown field. Tokens do not authorize generic local RPC and are never stored or printed.

The local socket decoder permits an additional 1,024 bytes around the existing 64 KiB worker projection for the RPC envelope; remote frames remain capped at 64 KiB. The exporter sends only fixed local `deployment.identity` and `worker.list` RPCs. Identity is checked before the grant and both before/after the snapshot; home/protocol/generation changes fail closed. Socket ownership/canonical path/inode are checked around reads. The worker response must match the canonical scope and expected scope digest. Projection removes repository paths, opaque local view IDs/cursors, prompts, logs, provider IDs and credentials. Per-row references are snapshot-local; they cannot be used as stable worker identities or cancellation targets.

Each wire response binds nonce, home, instance generation, registry digest, scope, protocol and sequence. Snapshot payload is SHA-256 hashed as evidence of the bytes/fields observed, not independent proof that the server's assertions are true. SSH host authentication and server authorization remain the deployment trust boundary. A home ID/nonce/hash is not standalone authentication.

## Limits, uncertainty and freshness

At most one in-flight request, one page of at most 50 source views, two frames per direction, and bounded stderr; no reconnect, replay, action retry or local fallback. A truncated page explicitly reports incomplete and `has_more`; no cursor is exposed in this first increment. A complete empty page proves only that this query returned no eligible source views, never that the home is healthy. Session/run rows can describe the same worker; Graph and unbound runs remain excluded.

The client reports local monotonic round-trip duration and local receipt time. Remote timestamps and source freshness are untrusted observations and never prove liveness. Negative/future source clock relationships are reported as unknown. The view is a point-in-time observation, not a durable cache or live stream. Timeouts, disconnects, framing/protocol/identity errors produce an allowlisted unknown result without reusing stale observations.

## Tests and release qualification

Start with failing tests for strict registry validation, fixed SSH argv, private-path removal and binding failure. Test frame fragmentation, oversized/banner/extra frames, token/method replay, host/home/protocol/nonce/registry mismatch, generation changes, future timestamps, scope substitution, empty/truncated results, timeouts and disconnects. Run an actual child exporter through pipes against an isolated already-running daemon; compare serialized complete database page images before and after reads and verify no start/send/cancel calls are possible. Test the command parser using the same real client exchange over an injected local child process; this qualifies stdio behavior, not SSH host trust.

Run targeted build/typecheck/tests and independent Claude Code Haiku 5.5 audit. Record exact source hashes and raw audit output. Real two-host SSH authentication, host-key rotation, constrained-account policy, networking failure and platform OpenSSH compatibility require an operator-provided remote host and remain pending. Removing the explicit CLI/registry configuration disables this optional feature; no migration or persistent runtime state is introduced.
