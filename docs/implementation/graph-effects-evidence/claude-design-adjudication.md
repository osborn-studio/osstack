# Claude design challenge adjudication

Source: claude-design.json, actual claude-fable-5-1 tool-less review. Snapshot predates C4 implementation.

Accepted: refresh revision after every async boundary but preserve original generation/owner/program; failed != not_applied; exact compiled slot/action payload binding; threadId bound to run; unique effect-level admission ID and no nested whole-run lease; atomic shared budget; bounded Saver ACK semantics.

Rejected suggestion to persist stale-generation confirmations through the regular mutation path: violates C3/G13 fencing. Failed post-effect persistence stays unknown, evidence retained for later authenticated G15 reconciliation. We do not weaken current checks.

Qualified: automatic daemon orphan scan and broker receipt-aware worker takeover belong G14/G15. Current storage requires trusted supervisor attestation and external effect reconciliation before takeover; ledger blocks inherited unresolved actions and stale writes. No worker is launched by C4.

Rejected unqualified adapter self-report not_started as sole retry authorization: only trusted broker pre-invocation decisions can establish zero effects. Adapter failure/exit alone cannot. Raw worker receipts remain untrusted.

Qualified epoch proposal: mutable ledger-derived epoch would add scheduler authority. Registered immutable per-node/epoch action allowlist is acceptable; G18 compiler owns ordered finite epochs. No new node FSM.

Clock rollback remains fail-closed in G08, not silently rewritten to allow possibly expired authority. G28/operations may later add a documented clock policy.
