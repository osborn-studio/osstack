# Source continuity and observation admission

A source observation ledger records whether previously accepted evidence has remained usable, not which component is at fault. Host registration and clock authority are part of that evidence.

## Admission and cancellation

Inspector `busy` and `cancelled` results do not call the ledger. External cancellation is checked after asynchronous inspection and before any ledger transaction. An already-cancelled or in-flight cancelled observation does not change the stream revision, events or acknowledgement validity. RPC-level overload likewise refuses the request without entering observation.

The daemon tracks `source.inspect`, `source.observe`, `source.events` and `source.acknowledge` under the same four-request admission map. Responses have a two-second deadline; shutdown aborts their controllers and bounds the drain to two seconds. A timed-out underlying operation retains its outer slot until settlement. The inspector additionally retains its own occupied I/O slots until settlement. Synchronous filesystem operations cannot be preempted. No cross-process concurrency guarantee is made.

Malformed parameters, noncanonical repository identities and event cursors beyond the stream return `invalid_request`; an occupied admission slot returns `source_busy`. The RPC inspection route and observation require a canonical repository identity and reject nonexistent input paths; direct local inspection may still normalize a path. This identity rule does not make their scopes identical: observation additionally refuses a host home inside the repository, while inspection only reads the fixed host registry and has no ledger authority. Every inspection response is schema-validated before sending. A valid inspection snapshot with `unknown` is returned as data (`ok: true` means the read completed, not that its evidence is trusted); thrown operation failures or invalid output return `source_unavailable`. Observation likewise may return an `unknown` snapshot with a quarantined observation. Response-schema failures are never reported as caller mistakes.

## Loss of evidence

Other unavailable snapshots—including registration/configuration missing, invalid or changed; registration expiry/staleness; content/pin/read errors; read timeout; and invalid inspection clock—attempt a conservative downgrade of an existing ready stream to `unknown`. These reasons describe lost continuity, not proof of a source-side defect. A host-side timeout can therefore require operator recovery even when the source later returns unchanged. This deliberately includes generic `source_unavailable` from an internal exception or host resource error: the inspector no longer supplies usable evidence, so accepted continuity is quarantined. We do not classify a programming error as proof that the source is at fault, and do not preserve trusted readiness merely because the cause may be local. This availability cost is an explicit owner decision.

The first downgrade increments the record revision and invalidates an earlier exact acknowledgement grant. Repeated unavailable observations of an already quarantined stream do not repeatedly increment it. An unavailable first observation with no existing stream creates no row and does not advance the clock. The ledger's own clock or transactional checks can reject the write instead; failure never constitutes permission to use the snapshot.

Restoring the registration or observing the identical accepted pin does **not** automatically clear `unknown`. Recovery requires a fresh authorized snapshot and an exact private acknowledgement for the current record revision. Clock correction additionally requires the existing bounded clock-reset grant. No background retry silently restores trust.

## Verification scope

Regression coverage includes real daemon RPC contention between two blocked reads and a third refused observation, unchanged durable stream/events after refusal, pre-cancelled and in-flight cancelled host observations, registration removal/restoration with persistent quarantine, bounded shutdown of a non-settling inspection, and invalid parameters for all four RPC methods. These local tests do not qualify live external sources or operating-system I/O interruption.

The context consumer never admits on `status().state` alone: asynchronous load/validate call `observe`, require a ready current snapshot and matching revision, and propagate clock-write refusal. The final synchronous dispatch fence checks `assertClockFresh` before and after source validation. A readable stored ready row under a regressed clock is therefore not execution authority.

Scope validation and home/path failures that occur before a snapshot is inspected do not downgrade the ledger. A prior row may remain `ready` as a historical observation; a subsequent successful status/events read can expose that row. This is not current execution permission: context admission still requires successful observation and all freshness/clock/policy fences. Treating invalid caller scope as snapshot evidence would let bad input mutate a stream, so these failures intentionally leave durable continuity untouched.
