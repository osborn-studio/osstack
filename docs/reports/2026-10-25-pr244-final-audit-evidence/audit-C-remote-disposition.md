# C4/C5 remote cancellation dispositions

## C4 — distinguish two failure windows; conservative unresolved state remains explicit

`remote-cancel-exporter.ts` writes the final durable result before sending its response. `remote-cancel.test.ts` test `lost remote ACK after fsync is recovered by query without replay` actually kills the exporter during its second stdout frame (after result write), then repeats cancel which the local journal converts to query; it recovers stop_requested with exactly one graph.cancel call. This is the implemented lost-ACK recovery guarantee.

The different test `process killed after reserve and cancellation invocation stays unknown and never replays` kills before a durable final result. Its queries intentionally stay unknown. A daemon error, CAS race, or post-reserve host registry revocation is also conservatively unknown. This over-classifies known rejections but never authorizes another effect. No claim of eventual resolution applies to these cases. Adding graph.status cannot prove that this request caused cancellation, and may observe an unrelated cancellation; current exact receipt semantics deliberately refuse that inference. No second cancel, new grant, DB edit, or status-based fabricated acknowledgement was introduced.

The receipt's home/generation identifiers bind the signed requested target. For not_found/unknown they do not attest current remote liveness or identity; observed_revision remains null and physical_stop is always not_attested. For stop_requested, the exporter checks deployment.identity, Graph scope/generation/revision and cancel response through the same socket, then durably records the observed revision. These field semantics and unresolved operation limitations should be explicit in the ledger.

Relevant complete source: remote-cancel-exporter.ts (handleRemoteControlExportCommand, graphConnection), remote-cancel-protocol.ts (receipt schema/journal), remote-cancel-client.ts (local one-shot reserve/query conversion), remote-cancel.test.ts (both exact failure-window tests). The parent owns final model disposition.

## C5 — reproduced and fixed

Identity key validation, scratch allocation, known_hosts write, and SSH argument construction now precede the durable local request reserve. A new local cancel that fails this preparation returns not_sent and leaves the grant reusable; this means only this invocation never reached reserve/transport, not a remote global-state attestation. Existing reserved requests and query failures remain delivery_unknown. Immediately before any journal reserve, output defaults back to unknown, preserving uncertainty on a possibly durable write failure and every post-reserve/spawn failure. Journal creation itself may occur during preflight but creates no request reserve.

Regression `local identity preflight failure does not reserve or burn the cancellation grant` makes the private key world-readable, asserts no spawn/daemon call, restores key mode, and proves the same request then executes exactly one cancellation. It failed before the change; RED log is C5-remote-preflight-red.log. Full remote-cancel and actual main entrypoint tests pass; raw log C-remote-test.log. No network SSH host, new execution authority or real user Graph was used.

## Final client delta and scoped verdict

A validated remote receipt is retained if writing the local observed journal fails; observation_persisted is false on write failure or an already-existing record. The durable local reservation remains consumed, and the regression proves repeated invocation issues only one cancellation. When any prior local reservation exists, a remote not_found receipt is retained as evidence but the overall client outcome remains delivery_unknown; it is not proof of no effect and never permits replay. The latest remote-cancel plus actual CLI entrypoint run has 36 passing tests, with CLI typecheck passing (`B1-r5-validation.json`).

Final authenticated Haiku 5.5 review `reaudit-B1-final-result.json` returns PASS_SCOPED for B1 and C4/C5. Optional hardening suggestions are recorded in that raw result, not represented as completed changes. No live remote SSH environment was qualified. Full integration and CI remain separate gates.
