# R1 audit disposition

Requested/invoked model: claude-haiku-5-5. Both Claude Code JSON results report that model in modelUsage with provider firstParty; CLI stderr also emitted unrecognized_model. This is CLI metadata, not independent backend attestation. Tools, hooks, MCP, slash commands, settings sources and session persistence were disabled. Raw contexts/results/stderr are retained.

Round 1: no confirmed P0/P1; ten P2 suggestions.
- DB evidence: full SQLite serialized page image hash before/after both source fixture and actual daemon observer, covering all tables/values. WAL/SHM lock-byte changes are not used as read-only evidence. Actual daemon test is the strongest end-to-end no-write check.
- Privacy: positive DB source checks confirm private title/native ID exist; positive upstream checks confirm private repo/view IDs. Upstream WorkerViewService intentionally never emits modeltext/native IDs, so asserting secrets in its response would violate its contract. Child output omits all sensitive fields.
- Authorization tests: successful control, method/extra-field rejection and cross-connection token replay, plus positive hostile-peer control.
- Evidence hashes now recursively key-sort objects, preserve arrays, and have insertion-order tests.
- SSH: reject whitespace, quotes, percent and backslash in identity/known-host paths; native /usr/bin/ssh -G asserts effective flags. No network used.
- Errors: closed channels retain a bounded error sink and stderr has an error listener; close idempotent.
- Direct internal readRemoteHome invalid caller input intentionally throws before transport (documented); CLI catches. Runtime/remote failures return allowlisted unknown.
- Local RPC envelope gets 1024 bytes above 64KiB projection; remote wire remains 64KiB. Boundary regression test added.
- Trusted daemon scope filter now tested through exporter with distinct other-tenant/repo states; exporter verifies bound scope echo, not independent row auth.

Independent lifecycle finding: real child would remain active after one snapshot if stdin remained open. Added failing test then production finally pauses input; child exits normally. No daemon/task execution is stopped by this change.

Round 2: no confirmed P0/P1, only five P3 observations.
- Early returns before channel initialization do not start stdin flowing. New real child tests for bad args and invalid registry both exit 1 without reader EOF and emit no stdout. No runtime change needed.
- Registry SHA is documented as public pin confirmation, not confidentiality for guessed contents.
- Scratch path restrictions already documented with identity restrictions; unknown is deliberate fail-closed availability behavior.
- Actual daemon whole serialized DB image is primary no-write evidence; fixture supports deterministic source projection consistency.
- Tenant/repo test now asserts exact distinct source-kind/state/revision tuples, beyond counts.

After round 2, runtime modules were unchanged; only tests and guide strengthened. Final targeted suite 90/90 passed, CLI typecheck and six-file Biome passed. Whole workspace build passed before final review; new modules are independently bundled in child tests. Root owns actual bin routing, final integrated build/full suite, and PR qualification. No real remote host was configured or contacted. No real SSH or remote action qualification is claimed.
