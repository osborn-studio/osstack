# Source continuity and observation admission

A source observation ledger records whether previously accepted evidence has remained usable, not which component is at fault. Host registration and clock authority are part of that evidence.

## Admission and cancellation

Inspector `busy` and `cancelled` results do not call the ledger. External cancellation is checked after asynchronous inspection and before any ledger transaction. An already-cancelled or in-flight cancelled observation does not change the stream revision, events or acknowledgement validity. RPC-level overload likewise refuses the request without entering observation.

The daemon tracks `source.inspect`, `source.observe`, `source.events` and `source.acknowledge` under the same four-request admission map. Responses have a two-second deadline; shutdown aborts their controllers and bounds the drain to two seconds. A timed-out underlying operation retains its outer slot until settlement. The inspector additionally retains its own occupied I/O slots until settlement. Synchronous filesystem operations cannot be preempted. No cross-process concurrency guarantee is made.

Malformed request parameters return `invalid_request`. Inspection/output/internal failures return `source_unavailable`; response-schema failures are not reported as caller mistakes.

## Loss of evidence

Other unavailable snapshots—including registration/configuration missing, invalid or changed; registration expiry/staleness; content/pin/read errors; read timeout; and invalid inspection clock—attempt a conservative downgrade of an existing ready stream to `unknown`. These reasons describe lost continuity, not proof of a source-side defect. A host-side timeout can therefore require operator recovery even when the source later returns unchanged.

The first downgrade increments the record revision and invalidates an earlier exact acknowledgement grant. Repeated unavailable observations of an already quarantined stream do not repeatedly increment it. An unavailable first observation with no existing stream creates no row and does not advance the clock. The ledger's own clock or transactional checks can reject the write instead; failure never constitutes permission to use the snapshot.

Restoring the registration or observing the identical accepted pin does **not** automatically clear `unknown`. Recovery requires a fresh authorized snapshot and an exact private acknowledgement for the current record revision. Clock correction additionally requires the existing bounded clock-reset grant. No background retry silently restores trust.

## Verification scope

Regression coverage includes real daemon RPC contention between two blocked reads and a third refused observation, unchanged durable stream/events after refusal, pre-cancelled and in-flight cancelled host observations, registration removal/restoration with persistent quarantine, bounded shutdown of a non-settling inspection, and invalid parameters for all four RPC methods. These local tests do not qualify live external sources or operating-system I/O interruption.
