# Explicit bounded Attention triage

The authenticated daemon owns this optional queue. Inbox reads, scans and daily
summaries never invoke a model. The default configuration is disabled. The only
model output is advisory text: the deterministic category of an open decision
remains `human_decision`, even when the model suggests `system_wait`. No answer,
resume, seen, approval, item-state update or external action is performed.

## Host wiring

Construct `AttentionTriageLedger(supervision.store, supervision.observer.owner)`
and `createAttentionTriageService({ledger,config,providerFactory})` once per daemon.
Use public `@osstack/core` and `@osstack/agents` exports. The provider factory uses
`createControlledTriageProvider({state_directory,model_id,max_cost_usd})` with a
private directory under the existing runtime scratch root. Initialize it lazily;
call `service.stop()` before closing the database. Do not call from observer ticks.

Explicit configuration names for host integration:

- `OSSTACK_ATTENTION_TRIAGE_ENABLED=1`; every other value means disabled.
- `OSSTACK_ATTENTION_TRIAGE_MODEL`: required exact model when enabled, no fallback.
- `OSSTACK_ATTENTION_TRIAGE_CALLS_PER_HOUR`: default 5, integer 1..5.
- `OSSTACK_ATTENTION_TRIAGE_TIMEOUT_MS`: default 20000, integer 1..20000.
- `OSSTACK_ATTENTION_TRIAGE_MAX_COST_USD`: default 0.05, finite >0 and <=0.25.

These names specify the root-owned daemon configuration adapter; this module
accepts the validated config object rather than reading ambient environment.
The provider accepts only an explicit `ANTHROPIC_API_KEY` for authentication.
It does not import OAuth tokens, custom base URLs, repo settings, plugins, hooks,
MCP configuration or process injection variables. Missing credentials/model
availability yields an explicit failure, not another provider/model. A custom base-URL credential environment is rejected before network access, preventing a gateway key from being accidentally rerouted to the official API.

`attention triage --scope ID --item ID --model EXACT [--json]` calls
`attention.triage` with `{scope_id,item_id,model_id}` and a 25-second RPC timeout.
The host calls `service.run(params,signal)` and returns `{ok:true,result}`.
`attention triage --status --scope ID [--json]` calls `attention.triage-status`
with `{scope_id}`; the host calls `service.diagnostics(scope_id)`. Scope access,
Attention enabled state and daemon draining checks remain at the authenticated
host boundary. Legacy `attention triage --input` remains a separate offline parser.

## Source and budget contract

Migration 43 only adds `attention_triage_attempts` and its indexes. Source reads
join the registered scope/default-tenant task/run, admitted session binding,
current session version and latest decision turn. The current decision hash must
match the item. The excerpt is source data; commands inside it are never authority.

The owner-fenced reservation transaction runs before provider invocation. The ledger completion API is host-internal and never exposed as RPC data; only the fixed provider lifecycle may attest local process termination. A rolling
hour permits at most five attempts per scope (configurable lower). Failed,
invalid, cancelled and unknown attempts count; an indexed global unique slot
permits only one unresolved invocation. A persisted latest time prevents a clock
rollback from reopening a budget window; skew beyond five minutes reports
`clock_uncertain` for operator diagnosis. Registered Attention scopes are capped
at 100 by the existing store, so the per-scope limit is not an unbounded scope factory. Cache keys bind actual source version,
revision, content, model and permission fingerprint. Expired, stale, mismatched,
missing-usage and extra-field responses never install advice. Successful receipts require both wall-clock and same-process monotonic deadlines; small wall-clock rollback cannot extend the invocation. Advice reports its source digest, policy fingerprint, exact requested/reported model and original reservation time. Valid usage is retained even when the model response JSON is rejected.

The provider factory/policy phase shares the bounded call deadline and supports shutdown cancellation. Failed initialization may retry without creating another pending factory.

The SDK policy fixes no tools/MCP/hooks/plugins/skills, `maxTurns=1`,
`persistSession=false`, a private empty working directory, a pinned executable,
and a bounded cost/output request. Full prompt plus fixed system text is at most
8 KiB; retained output is at most 2 KiB/500 explanation characters. The daemon
limits invocation time to 20 seconds and keeps cancelled execution isolated until
the host observes the SDK child process exit. The SDK public spawn hook fixes the pinned executable, private working directory and actual child environment; parent environment variables are never merged. TERM/KILL without an exit event remains unconfirmed. Init metadata must report the exact model and
empty capability lists. This verifies reported runtime configuration, not model
weights or OS-level isolation against malicious same-UID processes.

## Unknown calls and operator recovery

A timeout with an unsettled provider, daemon stop or owner change leaves an
`unknown` attempt. Its active slot remains quarantined and its hourly attempt is
never refunded. Late success cannot promote the unknown result into cached advice.
A same-owner invocation whose local SDK child has confirmed exit can release only the slot; the outcome stays
unknown. An old owner can never release it after restart.

Use the read-only status command to obtain the affected attempt ID, reservation
time and reason. Keep the persisted database and runtime evidence. Stop the
host-controlled invocation and collect host-level termination evidence for that
specific attempt before any recovery. This first increment deliberately exposes
no caller boolean, SQL-reset helper or automatic quarantine release. A verified
termination-receipt recovery adapter remains pending; until then leave model
triage disabled and continue deterministic Attention operation. Do not delete the
ledger or switch homes to evade unresolved concurrency or rolling budgets.

## Acceptance and remaining qualification

Tests cover disabled zero-init, exact model mismatch, foreign/stale source,
no-tools init and tool-activity rejection, usage/JSON validation, concurrent calls,
physical database reopen, rolling budget/clock rollback, late completion after
timeout, and shutdown before DB close. Existing migrations and controlled-session
behavior are regression-tested. Actual provider smoke evidence records either a
verified init/result or an honest unavailable/unknown state; it never silently
substitutes another model. No live-model qualification is implied by fixtures.
