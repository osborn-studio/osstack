# Daily Attention audit disposition

Claude Code CLI was invoked with requested model `claude-haiku-5-5`, tools/slash
commands/hooks/MCP disabled. Raw input/output/stderr are retained. CLI emits
`unrecognized_model`; modelUsage labels the requested name, which is not independent
attestation of the underlying provider model identity.

## Round one

Four P1 findings:
1. Snapshot completeness/cursor consistency: fixed, including full-page per-scope
   count sums. Truncation, hidden rows, counts and cursor adversarial tests added.
2. Future-clock unknown counts displayed as current: fixed, discard snapshot and
   show unknown coverage; counts no longer produce owner suggestions.
3. Alleged non-canonical stored scope paths: rejected with source evidence.
   `AttentionStore.registerScope` calls realpathSync and statSync, requires
   default-tenant task, then stores canonicalRepo. Existing canonical alias and
   default-tenant tests cover the real boundary.
4. Attention could displace failing-CI recommendations: fixed; autonomy and failing
   CI retain priority, then Attention read-only evidence checks. Duplicate alias
   scope suggestions are deduplicated and tested.

P2 disposition:
- Cached-snapshot TTL is additional transport/cache validation; source scope TTL
  remains in readAttentionDashboard. Real query-only DB stale-scope test retained.
- not_watched now explicitly reports missing coverage without zero waits.
- Missing/inaccessible paths are workspace_unavailable.
- Budget-exhausted/cancelled entries retain explicit per-repo reasons; incomplete
  coverage (including overflow) contributes one aggregate daily warning.
- Shared daemon connection is intentionally writable; the factory invokes only
  existing read queries, not mutations. Changing query_only on a shared handle
  would break daemon execution. Both unit and integration tests use query_only.
- Default tenant NULL is enforced in actual registerScope SQL, not inferred from
  arbitrary tenant strings. String 'default' is a distinct tenant, not an alias.
- Attention sample clock is captured after possibly slow scans so valid RPC samples
  are not incorrectly future-dated relative to brief generation start. Small
  transport skew tolerated; excessive future clocks discard counts.
- Persistence additionally capped to 2 MiB across snapshots, tested with oversized
  valid responses. Scope/repo/time/concurrency limits retained.
- Registry aliases render separate named entries, with no portfolio total summed;
  this limitation is documented. Owner suggestions deduplicate scope IDs.
- Missing renderer/clock/ENOENT/budget tests added; actual read-only SQLite
  integration test already existed in daily-cli.test.ts.
- inbox/inventory CLI subcommands confirmed; supervision-service uses inventory
  reads/listItems SELECT/count SELECT. No answer/resume/seen invocation.
- Synchronous SQLite cannot be interrupted by JS timers; explicitly documented.
  Existing store caps scopes at 100; no unbounded scope admission introduced.

Validation: 49 targeted tests, CLI tsc, Biome, and diff whitespace checks passed.
Old home/schema tests prove no DB creation and unchanged SQLite bytes/schema/version.
Actual daemon/bin dispatch wiring is delegated to root integration, not claimed by
this branch's helper tests. Root's baseline fix 001764d5 was cherry-picked as
 a5608468 only to make local typecheck possible; it is not this feature's change.

## Round two

DA-1 confirmed: expired cached not_watched became stale and rendered zero counts.
Fixed with unknown + discarded snapshot and regression rendering assertions.
DA-2 claimed TS null errors: contradicted by actual successful `tsc --noEmit`;
an explicit `!snapshot || !totals` guard was still added for readability.
DA-3 assumed sampled_at NULL: disproven by migration `INTEGER NOT NULL DEFAULT 0`.
Added actual newly registered scope regression before its first scan.
DA-4 source scope future-clock counts: fixed by discarding whole-repository snapshot
when any returned source scope has unknown coverage. Actual query-only SQLite test
moves the read clock backwards and verifies unknown/no snapshot.

## Rounds three and four, final closure

Round three: raw result confirms zero P0/P1; one P2 retained-budget overcharging,
two P3 items. Fixed retained output accounting after discard decisions; separate
source_coverage_unknown from genuine clock_moved_backwards. Documentation now
states two logical waiting slots, not two guaranteed physical transport requests.
Late aborted results already stop at throwIfAborted before parse/accounting.

Round four targeted review explicitly approves the three production corrections,
with zero P0/P1. Its only P2 is the failing test log captured while an existing
race in the test fixture was being corrected: a call-order-based mocked reader
assigned the slow result nondeterministically after async realpath. Final test
uses two distinct workspace directories and selects slow/fast by canonical path.
This changes the fixture, not production ordering. A near-deadline budget test
also now has enough queued entries to observe skipped work after timer rounding.
Final 49 tests pass; the 15-test Attention unit suite additionally passed five
consecutive runs. CLI tsc and Biome pass. The targeted audit's statement that tsc
status was unknown reflects its text-only evidence, not a failure; final logs
and recorded tool exits confirm successful checks.

Deliver commits in order:
- 45fbe7c85c60dfde366424f2dc6ed09576d8d30d main feature
- 37c2ee36750b74a68689798ec0d585c56f10aaa8 review corrections + stable fixture

Both are unpushed. Root performs real bin/daemon integration and whole-workspace
checks/audit; do not confuse these focused read-model tests with host dispatch proof.
