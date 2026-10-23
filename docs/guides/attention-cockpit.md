# Attention in the product Cockpit

The product dashboard and terminal Cockpit show a read-only Attention section. Its counters describe stored observations, not task completion or permission to execute. No answer, abandon, cancel, approval, or automatic retry action is added.

The host must supply the actual observer lifecycle to `createDashboardSnapshot` using `attentionService: "running" | "disabled" | "unavailable"`. An omitted lifecycle is unavailable, even if historical rows exist. Both the daemon RPC and HTTP snapshot callback must supply this state; setting an environment flag alone is not proof of an active observer.

When a workspace is explicitly selected, Attention canonicalizes its path and includes only matching registered scopes whose task still belongs to the default tenant. Without a workspace the block is explicitly a local overview, still restricted to the default tenant. Row totals, category totals and pagination use the same filter. “Outside coverage” counts only already discovered subjects in registered scopes; it does not count arbitrary unregistered repositories.

- `disabled` / `unavailable`: counters are unknown (`null`), not zero.
- `not_watched`: no registered scopes match the selection; this is not healthy coverage.
- `stale`: owner changed, observation expired, or the clock moved behind a sample. Stored business facts remain visible.
- `degraded`: scans, sources, history or admission are incomplete.
- `available`: matching observations are current; this does not establish process liveness or ownership of execution.

Each scope retains its own coverage reason. Wait-owner counters include only admitted subjects; released or capacity-excluded subjects are counted outside coverage. `items` counts every stored decision and `other_items` retains states outside the separately named counters, so terminal or future states are not silently dropped. Open decisions, reserved answers, uncertain answers, missing sources, applied answers and failed notifications have separate counters. An applied answer is not a completed task. Read-only `attention inventory --scope <scope_id>` and `attention inbox --scope <scope_id>` provide source details; the displayed scope ID is an identity, not an authorization token.

Only the Attention block is read within one SQLite transaction. The surrounding legacy dashboard and successive pages are separate snapshots. If the schema is missing or unreadable the block becomes unavailable; the reader never opens another database, migrates, starts observation, marks items seen, or makes a model/network call.

The HTTP API accepts `attention_after=<scope_id>` and `attention_limit=1..100` (default 25); “More watched tasks” preserves the selected workspace. Host snapshot callbacks must forward `DashboardHttpSnapshotParams.attentionAfter` and `.attentionLimit`. RPC hosts may expose the corresponding `attentionAfter`/`attentionLimit` values. Counts remain complete for the selection even when the row page is truncated. Cross-page snapshot consistency is not promised.

Source text is rendered as text in the browser and stripped of terminal control bytes in the Attention TUI section. The browser marks the section unavailable if a refresh fails or exceeds its deadline; late responses cannot overwrite a newer request. Reading or changing pages does not modify any action, delivery, posture, seen marker or grant.

Performance evidence for this development batch is a bounded in-process read-model benchmark, not daemon RPC or sustained throughput qualification. Full integration, whole-repository checks and host lifecycle wiring are required before the combined change is ready.
