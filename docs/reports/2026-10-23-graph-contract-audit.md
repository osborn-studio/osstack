# Graph contract and context audit — 2026-10-23

## Delivery boundary

This slice adds opt-in V2 contracts to the actual existing Graph durable reservation, effect execution, immutable candidate verification and atomic ready publication. It supports exactly one trusted registry check, implement/local_verified/artifact_only, no publication or merge authority, and optional default-tenant pinned context. It does not add a publisher, compiler version, database migration, public package export or remote authority.

The root integration owns the live committed-policy/private-overlay resolver, daemon method exposure, final full regression and startup checks. These component results do not qualify that integration or external model/provider execution.

## Independent static review

Claude Code was invoked with the requested `claude-haiku-5-5`, tools/slash commands/hooks/plugins/MCP disabled, no session persistence and static source bundles. The CLI emitted its `unrecognized_model` warning; successful result metadata identified `claude-haiku-5-5`. This is evidence of the requested CLI audit, not independent provider identity attestation. Raw prompts/results/stderr are retained in the local evidence directory below.

Round 1 identified a conditional P1: the recorded clone was not the exact object handed to the adapter. Fixed by cloning and deep-freezing once, observing that object, and passing that same object to the adapter. Mutation tests verify both top-level and nested freezing. It also prompted durable context-to-effect links and stronger producer evidence validation.

Round 2 reported no demonstrated P0/P1 and five P2 findings. Disposition:

- Repeated context invocation wrote an extra prepared receipt before rejection: fixed by a guard outside the context assembler. A repeat cannot invalidate the first invocation's evidence.
- Completion selection uses live process memory: retained limitation. Link records are durable, but arbitrary checkpoint restart/rediscovery is not implemented. Missing selection fails closed; no recovery qualification is claimed.
- Non-context reviewer accepted another invocation with a fresh run ID: fixed with a V2-only guard keyed by trusted effect identity before any await. A new explicitly authorized logical attempt is allowed; the no-contract path is unchanged.
- Public context integrity errors collapse into POLICY_DENIED, while generic execution-context errors may be INTERNAL_ERROR: retained diagnostic limitation. Raw host paths/commands remain undisclosed and all failures deny completion. A future error-code revision can distinguish these without expanding execution authority.
- Final synchronous authority content checks occur inside the existing IMMEDIATE publication transaction: retained intentional correctness boundary. No async work occurs in that transaction; local file reads can increase lock time. This slice does not claim RPC p95 qualification for that path.

Round 3 statically reviewed only the two replay fixes and found no P0/P1/P2 regression. Its P3 notes are conservative behavior: rejected replay may reread authority; a failed first reviewer invocation consumes its effect identity. The subsequent full regression exposed that a blanket prepared-action guard broke legacy retries; it was narrowed to V2 plus trusted effectKey, and a real test now covers both same-effect denial and new-attempt success.

Round 4 reviewed the retry correction and found no P0/P1. Its P2 edge case is intentional: the V2 effect key is consumed before asynchronous authorization, so a failed preflight or cancellation cannot retry the same logical effect. This prevents concurrent duplicate starts; a newly authorized logical attempt is allowed and covered by the regression test.

Other uncertainties are explicitly bounded: full Graph repair tests verify the original base remains available; actual daemon resolver/wire checks belong to root integration; orphan files are not completions and have no new GC here; same-UID host files are not an OS sandbox. Context receipts attest final AgentTask input, never provider wire bytes. Missing adapter events cannot fabricate an observed phase.

## Verification

Validation uses Node 22 and an isolated scratch root. Final Graph reruns explicitly set test TMPDIR under that scratch root. No development CLI was run against the serving home.

- Admission, context and real Graph suite: 37 tests passed before the final replay guard tightening (20 admission, 8 context, 9 real Graph).
- Added ignored untracked path counterexample: passed. Candidate serialization cannot hide ignored out-of-scope output.
- Legacy Graph regression: 119 tests passed across seven files, including unchanged admission, bounded messages, joins, adversarial delivery and actual delivery. Counts overlap the admission suite; do not add them as unique totals.
- Core publication snapshot tests: 6 passed, including admission state drift without a run revision change and rejection outside a caller transaction.
- The first replay rerun exposed two legacy retry failures (retained in `g2-replay-tests.log`); both passed after the scope correction, along with the new V2 attempt test (`g2-retry-regression.log`). Final full replay rerun passed all 49 tests (41 verification + 8 context) in `g2-final-replay-tests.log`; three post-audit real context/repair/ignored-path cases passed (`g2-post-audit-integration.log`).
- Core and CLI typechecks, twelve-file Biome check and `git diff --check` passed.

Real Graph cases cover source HEAD/refs/index/tracked bytes unchanged; final grant/revision changes after receipt persistence; unknown physical stop; writer/rebuilt-reviewer final prompt hashes; full contract digest; repair epochs rejecting stale evidence; path scope; idempotent durable admission; and read-only completion tamper rejection. No live provider, PR, merge or deployment is claimed.

## Evidence

Local directory: `/Volumes/AIMATE_WORK/tmp/osstack/smoke/pr237-integration/delivery-contract/graph-next/`.

| Round | Raw result | SHA-256 |
| --- | --- | --- |
| 1 | `audit-1-result.json` | `6818f8d0f82550401747c4251f31c5c6c4de04445c85a1d574026f93ff8d0f51` |
| 2 | `audit-2-result.json` | `a0ab55dc8e73117eeed3e9672555b76f3c2f3618d5ffa4af7215267cf4104d85` |
| 3 | `audit-3-result.json` | `861083dcdab46d3950d0870492abe6b7105be18fd547eb1f9c00c042a8254e2a` |
| 4 | `audit-4-result.json` | `83fd9444bf296faabf9d70bb68cc28eda08b41037dff06d1bfe3f91269c24434` |
