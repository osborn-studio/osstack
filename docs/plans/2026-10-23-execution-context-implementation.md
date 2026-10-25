# Execution context: actual adapter prompt and provenance receipts

This implements integration plan §7 E for the guarded delivery paths. Graph,
cloud retrieval, provider wire payloads, tokenizer qualification and memory
promotion remain outside this slice. Default mode is off, preserving the exact
original adapter array and invoking neither loaders nor receipt writers.

## Owned implementation and connections

- `knowledge/src/context-budget.ts`: pure validation, complete UTF-8 rendering,
  optional selection, provenance/digests and mandatory failure diagnostics.
  Only its explicit public export is added to the knowledge index.
- `cli/src/execution-context.ts`: opt-in adapter wrapper, bounded explicit local
  pin-config/pack loading, two-phase receipt references, cancellation cleanup.
- Reliability agent owns deliver parsing, guarded-local and guarded-git
  callsites, frozen V2 contract inputs and host-proof receipt references. Root
  owns lazy bin assembly. Neither helper completion nor a trace-only knowledge
  lookup qualifies the actual delivery feature; integration tests observe the
  actual Loop adapter argument and compare it with the persisted receipt hash.

## Input contract

`--execution-context FILE` selects a repository-confined JSON config. Schema 1
requires `mode: local`, explicit canonical `repo_path`, `default_tenant: true`,
and 1–8 pack pins. Each pin specifies repository-relative `path`, `pack_id`,
`version`, exact raw-file `sha256`, manifest `scope` (`project` or `official`),
and `verified_at_ms` / `expires_at_ms`. No team/private tenant, global cache,
home scan or cloud fallback is accepted. Pin files and packs are regular files
within the canonical workspace, read with byte limits and checked for path
escape; directory aliases do not grant another repository scope. Manifest ID,
version, scope, absent tenant and raw bytes must match the explicit pin.

Optional config `max_prompt_bytes` defaults to 65536 and
`max_knowledge_bytes` to 8192. Both are bounded hard limits. Optional knowledge
is retrieved with the existing local BM25 search from only the verified pack
objects. Invalid integrity or scope blocks invocation; stale/future optional
entries are omitted with reasons. The pinned manifest's upstream provenance is
data about its declared sources, not an independent verification of those
upstream files or a promotion to instruction authority.

## Authority and complete rendering

The wrapper owns three mandatory sources: the exact current AgentTask prompt,
a fixed host safety statement, and the caller's frozen contract brief when its
digest is supplied. Contract digest and brief must be supplied together. They
are never derived from knowledge text or source-declared priority. Existing
AGENTS/instruction handling remains upstream; this feature does not import,
replace or edit instruction files. The existing instruction-mirror inspector
is for canonical/import mirrors and is not repurposed to bless pack bodies.

Each entry records identity, source reference/digest, text digest, explicit
repo/default-tenant scope, freshness and evidence kind. Conflicting or duplicate
IDs fail closed. Optional entries must be knowledge and optional; they cannot
self-declare mandatory. Expired, future, invalid or oversized mandatory input
blocks execution and names `required_omitted`; it is never silently clipped.

The complete final prompt retains the original instruction and includes host
safety/contract sections and a JSON-encoded, explicitly untrusted data section.
Knowledge cannot close its wrapper by supplying a fake delimiter. All framing,
metadata, quotes, escaping, separators and multibyte text count toward the
actual UTF-8 byte limit. Optional entries are selected whole, never cut through
UTF-8 or JSON. A byte budget does not establish a model token-window guarantee;
receipts always mark token/window qualification as unqualified for this slice.

## Real adapter and evidence contract

`createExecutionContextAdapters` receives adapters, workspacePath, optional
mode/byte limits, optional contractDigest + contractBrief, a `loadContext`
callback and `recordReceipt` callback. It returns `adapters` and `receiptRefs()`,
optionally filtered by exact run/task/session identity. Create one wrapper per
delivery; the no-argument aggregate intentionally includes all its Loop tasks.
Enabled wrappers intercept only `invoke`; metadata, capabilities, availability,
runtimeIdentity, optional lifecycle/session methods and confirmStopped retain
their original target `this`. No route, model or fallback selection changes.

Immediately before invocation, a `prepared` receipt records run/task/session,
adapter/capability, canonical source repository, distinct actual execution
repository (candidate worktree or null if absent), contract digest, final prompt hash/bytes,
selected/omitted provenance and budget qualification. No prompt/body is written
to that receipt. A failed prepared receipt blocks invocation. After the first
event from the original adapter, an `adapter_observed` receipt records the same
prompt hash. This proves the AgentTask boundary was observed, not the provider
wire payload, successful execution, physical stop or model compliance.

Receipt references are `{path,digest}` from the host writer and are preserved
even if subsequent execution fails. Reliability's delivery proof references
these immutable receipts. A cancelled attempt never adds a late writer result
to its completed reference list. If the observed receipt fails after work started,
the wrapper aborts its linked controller and performs bounded iterator cleanup;
it never calls that physical-stop proof. Outer cancellation remains connected,
late loader/iterator settlement cannot start a new provider invocation, and
original confirmStopped remains the only adapter stop-evidence mechanism.

## TDD acceptance and rollback

Pure tests cover multibyte/framing budget overflow, mandatory expiry/overflow,
source/hash/scope conflicts, optional freshness, hostile required declarations,
unknown model window and deterministic complete rendering. Host tests cover
default-off zero effects, raw pack hash/version/scope/tenant/path escape,
malicious delimiters as data, no credential/home discovery, actual captured
AgentTask hash matching both receipt phases, this-bound methods, prepare-write
failure, observed-write failure after start, abort/late reads and cleanup.

Reliability adds actual guarded delivery/Loop tests with the wrapper, proving
that the outgoing prompt equals receipt provenance and refs survive failures.
Root runs integrated full-suite and exact-head qualification. Claude CLI
Haiku 5.5 performs independent static challenge with no tools/hooks/MCP, and
raw inputs/results remain in scratch evidence. It does not replace runtime
verification. Disable the option to roll back; there is no migration or change
to provider choice, approval policy, permissions or publication authority.
