# Attention in daily briefs

`runDailyBrief` composes the same read-only Attention section for manual `daily`
and persisted daily sessions. Registry entries are filtered to enabled repositories;
each read uses the canonical repository directory and the default tenant. The
persisted dated brief contains `attention`, and Markdown shows human/system/unknown
wait responsibility, open decisions, uncertain answers, missing sources and dead
letters. This is an observation summary, not approval or execution authority.

## Host integration

`DailyCliDeps` and `RunDailyBriefDeps` accept `attentionReader?: DailyAttentionReader`
and `signal?: AbortSignal`. A reader receives `{ workspacePath, nowMs, limit: 100,
signal }` and returns an AttentionDashboard object. The scheduled daemon injects
`createDailyAttentionReader(existingDb, () => currentObserverService)` and the
session abort signal. Manual CLI wiring injects an existing read-only
`dashboard.snapshot` RPC and returns its `attention` field, forwarding workspace
and attentionLimit. Neither path starts a daemon. The reader factory never opens
a database, migrates, or accepts mutation callbacks.

A missing reader/connection/schema is `unknown`; a disabled observer is `disabled`;
a valid empty scope set is `not_watched`. Stale and degraded projections preserve
historical counts with their coverage labels. Missing data never becomes a healthy
zero. RPC payload validation rejects other tenants, overview snapshots, mismatched
repository paths, malformed counts and inconsistent row counts. Returned data is
allowlisted before persistence, with a two MiB aggregate snapshot budget. Overflow is unknown. A cached nonempty sample older than 65 seconds is stale; an expired empty sample is unknown.
more than five seconds ahead is unknown and its counts are discarded (small RPC clock/transport skew allowed). A scope whose source coverage is unknown also invalidates the repository counts. A not-watched repository shows absent coverage rather than zero waits. The Attention sampling clock is captured after other daily scans, separately from the brief generation start.
Each repository snapshot is internally consistent; the whole portfolio is not one
transaction and duplicate registry aliases must not be summed as distinct scopes.

At most 100 enabled repositories are sampled with two concurrent readers, a 500 ms
per-read timeout and a two-second asynchronous budget. Remaining repositories have
explicit unknown/omitted coverage. Each read requests at most 100 scopes; full
repository totals remain separate from the displayed page and truncation is
reported. Timers cannot preempt synchronous SQLite work; this relies on the bounded
existing Attention read model. Cancellable transports should honor the supplied
signal; late results from non-cooperating transports are discarded.

## Decisions and compatibility

At most three owner suggestions retain existing autonomy and failing-CI priority, followed by
Attention evidence checks. Fresh human waits with open decisions suggest
`attention inbox --scope`; uncertain, stale or missing-source facts suggest
`attention inventory --scope`. Scope IDs are deduplicated across registry aliases.
The daily producer never calls answer, resume, seen, posture or delivery mutation.
It does not claim actor-specific unread counts: this summary is actor-neutral.

Old persisted briefs without `attention` still render. New Attention Markdown strips
terminal controls and escapes untrusted markup; this is not a claim about unrelated
legacy report sections. Existing Stack, Probe and hygiene DB reads now explicitly
use the guarded readonly connection. Missing homes do not create a database; old
schemas degrade to warnings without migration. The only intended write remains
the dated JSON brief in the explicit OSSTACK_HOME.

Validation covers workspace/default-tenant filtering with a real query-only SQLite
connection, manual and reusable brief persistence, absent and disabled sources,
not-watched and stale coverage, pagination disclosure, malformed RPC input,
timeouts/cancellation, output escaping and unchanged legacy database bytes/schema.
