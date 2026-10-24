# GitHub delivery qualification evidence — 2026-10-24

Source: f5725c3c, following d04a8078, 82fef10c and 788a64e1. This evidence covers component implementation, not the parent integration or the entire repository suite.

## Verified locally

61 CLI tests and 48 core delivery tests passed. Tests include a real local HTTP server, immutable GraphQL subject targeting, exact author/body/correlation receipts, foreign marker copies, bounded oversized/paginated/timeout responses, no automatic POST retry, grant revocation before consume, synchronous credential/ticket fences, durable send journal and existing process-kill recovery. CLI strict typecheck passed after rebuilding local workspace declarations; scoped lint passed. The final fence logs are the latest tests. No external message was posted and no real credential or host trust was configured.

## Independent CLI challenges and dispositions

The invocation requested `claude-haiku-5-5`, disabled tools/slash commands/hooks, and used isolated settings and an empty strict MCP configuration. Raw inputs, stdout JSON, stderr and settings are retained. Completed rounds 1, 3 and 4 have `is_error: false`; round 2 was an explicitly terminated experimental run and is not counted as completed. Each completed response reports the requested model in modelUsage, but stderr warns `unrecognized_model`. Model metadata is preserved; actual backend weights cannot be independently attested. These were static challenges; Claude did not execute tests.

Round 1 identified three availability concerns: readiness GET failure after consume, malicious foreign-author marker copies, and old thread history hiding recent receipts. They were fixed with pre-consume readiness, trusted-author filtering, and a bounded timestamp window. Round 3 found the second readiness GET still occurred after consume. Commit 788a64e1 replaced it with a one-use ticket and an immutable-subject GraphQL POST; the timestamp window now uses durable send_started time. Round 4 found an awaited private credential read still after consume. Commit f5725c3c moved the credential/ticket freshness check synchronously into the consuming transaction and removed all awaited reads before POST; a new regression test confirms the active grant remains unconsumed on fence failure. It also permits receipt lookup after issue lock. This final corrective commit has local regression evidence, but has NOT yet received an independent post-fix audit: parent CLI authentication later expired. Do not describe this as a clean final Haiku approval.

Bounded lookup can still return unknown on timeout, extreme pagination, inconsistent provider data or absent receipts. No negative lookup grants retry authority. Same-uid hostile processes with issuer-key access are outside the local trust boundary. A persisted send attempt after process crash remains unknown until an exact positive receipt is found. The dispatch timeout covers two bounded phases (readiness and write), not one total phase.

## Historical failed experiments retained

`targeted.log` was an inadvertently broad earlier suite run while workspace output was stale: 2 fence tests failed, 2392 passed and 3 skipped. It is not current qualification. `typed-core.log` records one failed, subsequently discarded typed-not-started experiment; schema45 correctly prevented that transition. `typed-typecheck.log` includes stale tracked knowledge declarations. Those experiments were removed or rebuilt. Latest component tests pass; the parent owns complete-suite qualification.

## Real environment still pending

A human must provision host-private registry, operator key and least-privilege GitHub token, explicitly attest sandbox then production qualification, and approve an exact wire preview. Live checks still required: GraphQL addComment token permissions; real author/immutable subject IDs; raw-body normalization; request IDs and pagination/since semantics; locked issue and rate-limit behavior; actual network interruption/daemon restart and receipt lookup. Local tests do not establish these properties and production stays disabled without explicit host setup. The CLI signer requires a local TTY and full preview digest, never RPC or --yes.
