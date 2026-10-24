# Remote Graph cancellation — component delivery evidence

Source commit d3659ca4. No database migration. Root owns central command routing, complete repository validation and pull requests.

## Implemented

Dedicated write-only control exporter; distinct exact Ed25519 remote cancellation grant; host-private current registry and local interactive issuer; fixed approved target, daemon generation and Graph scope/run/generation/revision binding; existing daemon socket only; one Graph cancel invocation; client and server create-only fsynced journals; exact durable receipt lookup after lost ACK; no automatic resend after unknown; no physical stop assertion or lock release. Read-only exporter authorization is not widened. Natural subcommand --help works before configuration. Actual setup examples and limits are in ../../guides/remote-graph-cancellation.md.

## Verification

Final control suite:28 passed (r2-final-confirm.log). The prior combined run passed81 tests:27 control,44 existing read-only remote,10 existing GraphRPC tests. One subsequent test and production change strengthened acknowledgement validation: only cancellation status and an advanced revision can produce stop_requested; final28 passed afterward. Strict CLI typecheck and scoped lint passed. The graph test fixture now allocates under the mandated scratch root; existing GraphRPC regressions passed with that change.

The local tests cross real child-process framed stdio and a real Unix socket. They cover complete issuer/config/client/exporter flow; actual GraphRpcService cancellation and worker abort via a trusted local fixture bridge; lost ACK after receipt fsync; SIGKILL after invoke; reserve-without-result crash; duplicate/concurrent requests; stale daemon/Graph generation/scope/revision; expiry with historical query; registry/issuer revocation; corrupted/wrong-generation receipts; request UUID conflicts; private ancestor permissions; malformed/oversized/stderr-flood peer; timeout; no database autostart; and read-only token rejection. The test bridge exercises the actual Graph service but is not a real SSH server or production adapter. Real process kill is tested; physical power loss is not.

The remote receipt consistently says physical_stop:not_attested even when the local Graph test separately confirms its worker abort. stop_requested is an acknowledgement, not a proof that all external processes stopped. No actual SSH host, credential provisioning, remote cancellation or trust mutation occurred.

## Requested independent audit could not run

One Claude Code CLI invocation requested claude-haiku-5-5 with tools disabled, slash commands disabled, isolated settings and strict empty MCP. The raw result has is_error:true, terminal_reason:api_error, no modelUsage and zero model tokens: OAuth session expired and could not be refreshed. Its subtype is misleadingly success and its process exit may be0; neither is an audit pass. stderr also records unrecognized_model. No inference/review happened. Authentication failure is preserved under audit/; there were no repeated retries. audit-ready-final-source.txt contains the current source for a future authenticated challenge. This component must NOT be reported as Haiku-approved.

## Remaining real-environment qualification

A host operator must configure the private server registry/Ed25519 public trust, separate local issuer key, client endpoint and SSH host-key pin, plus an authorized existing Graph registration. Verify real SSH restriction/identity, exact instance and generation observations, deployed adapter stop evidence/lease retention, clock skew, disk/power-loss durability, SSH connection loss and host restart. Until then qualification remains remote_host_pending. Filesystem sync calls alone do not attest the storage hardware. No unknown result should be cleared by deleting its journal. Signing a new request requires a new exact human approval.
