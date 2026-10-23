# Bounded observation and recovery diagnostics

Attention observation remains read-only with respect to execution. No scheduling
step, recovery view or benchmark answers a decision, resumes an agent, releases a
writer lease, approves a grant or calls a model.

## Scheduler integration

`AttentionObserver.step({maxSubjects:25,maxEvents:200,maxDurationMs:5},now?)`
returns `{passComplete,scopesVisited,subjectsSampled,eventQuotaUsed,durationMs}`.
The daemon service should call a step, yield with `setImmediate`, check stop, and
continue until `passComplete`. Keep one active scan. `tick()` preserves the old
synchronous compatibility path; use steps for background production scans.

A pass snapshots at most 100 scopes and the existing admitted session/run
identities per scope. Each source gets one quota per pass. A run with a large
backlog cannot be immediately requeued ahead of another admitted source. Event
quota is divided between that slice's candidates, capped by the existing 50-turn
session and 200-event run limits. The quota measures the maximum newly replayed
rows, excluding bounded cursor-anchor/latest-turn checks. Loop snapshots remain
with the existing asynchronous host reader and are not claimed as sampled here.

The existing global 100-subject admission cap and 100-scope cap stay in force.
Sources beyond capacity remain `capacity_exceeded`. Fairness applies to admitted
sources; it does not silently rotate admission. Explicit release can free capacity
for the existing discovery/admission mechanism. Release during a pass is rechecked
before sampling. Existing unadmitted rows with malformed/unknown metadata stay unadmitted; only explicit capacity/binding/source discovery retry states can gain admission later. This is fail-closed corruption handling, not a claim to resist arbitrary authorized database rewrites. The durable discovery keyset, session ordinal and run sequence
cursors remain authoritative after restart. Process-local scheduling queues are
rebuilt in persistent sample-age order; no second cursor table is introduced.

The 5ms target is a cooperative deadline checked between sources, not a hard OS
scheduling guarantee: one bounded discovery query/source sample can exceed it.
The returned actual duration and benchmark samples retain overruns. Newly admitted
sources remain `not_sampled` until read; unknown observations cannot qualify as
covered solely because their reason field is empty. Coverage is observation
freshness, never process health or permission to act.

## Recovery view integration

`readAttentionRecovery(store,owner,{scope_id,after?,limit?:20},now?)` is a public
core read-only function. The host must apply existing authenticated scope access
before calling it. It validates the default-tenant scope and per-source binding,
reads one consistent deferred transaction, and returns at most 25 admitted sources.
The `after` cursor is an opaque decimal row identity; clients must return it unchanged. An oversized source identity is reported as null/unknown, and one malformed evidence row never hides other sources.
Each session includes at most 20 message/action/grant-attempt IDs and states,
with separate total and truncation counts. No message payload, question, grant
signature, credential or file contents are returned. Invalid or stale source
bindings return unknown without exposing associated evidence.

Every result has `canAutoRetry:false` and `process_liveness:unknown`. Accepted or
failed inbound messages require a terminal receipt; checking/reserved grants
require a continuation receipt. An `abandoned_unknown` disposition does not prove
that execution never occurred. Existing applied receipts remain visible as facts.
Run cursors only describe retained-log observation and never prove process stop.
Loop/Graph recovery without the existing trusted host adapter stays unknown.
`next_step` values are capability hints for the host UI, not invented shell commands
or automatic recovery actions. Central CLI/RPC routing is integrated separately.

## Local measurement

After building core, run `node scripts/bench-attention.mjs` with an explicit scratch
root and development OSSTACK_HOME. It creates its own scratch-only DB and prints
the evidence JSON path. The deterministic fixture has 100 admitted runs across ten
scopes, 20 initial events per run and a 10,000-event burst on one source. It drains
bounded passes while measuring each step and each internal recovery-handler read.
The report preserves source hashes/dirty state, machine/runtime details, raw
monotonic samples, compiled core/protocol artifact hashes and lockfile hash, p50/p95/p99/max, CPU/RSS, DB/WAL size, event-loop delay and actual
convergence. No network, adapter or model port is used.

This fixture qualifies only local run observation. It does not measure socket RPC
round trips, a ten-minute mixed Session/Loop workload, Loop overhead, cross-platform
crash recovery or real-model routing. Those fields remain pending/null until their
separate qualification evidence exists. Never substitute this internal read timing
for the product's socket p95 target or interpret test counts as latency evidence.

The existing discovery page remains 250 rows. Session-heavy and capacity-overflow
discovery can exceed the cooperative target before subject sampling starts; this
fixture does not qualify that workload. The legacy inventory endpoint also retains
its existing facts-payload contract, separate from the bounded recovery view. A
byte-bounded inventory protocol and smaller discovery quanta need independent
compatibility/performance qualification. The new recovery endpoint does not use
that inventory output.
