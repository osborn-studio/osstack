# Graph physical apply / reviewer evidence — Opus 5 co-audit

Date: 2026-09-21. Baseline `e3ce5fd`; branch `codex/graph-decision-development`. Jev paused; no Jev code, credentials or live calls changed.

## Delivered code

- Real Git candidate create/replace/delete engine with full raw-tree, HEAD, index, mode, link and preimage checks; no filters/index mutation.
- Durable host connection: journal before one-shot beginApply, provider evidence binding, applied receipt + settlement, quarantine on uncertainty and no physical admission release.
- Complete cumulative and incremental reviewer input, including deleted/reverted/transient evidence; actual disclosure policy authenticated and enforced before content reads; context overflow fails closed.

See [design and activation gates](../design/2026-09-21-graph-physical-apply-review.md).

## Claude audit validity

Actual CLI calls explicitly selected `claude-opus-5`, tools and slash commands disabled. Source was supplied through temporary prompt files. Model usage confirms Opus 5. Claude did not run tests or write code; local processes independently produced validation evidence.

1. Initial design request exceeded its output cap (`is_error=true`), so no audit verdict was accepted.
2. First implementation response began mid-sentence. Its visible findings were investigated, but the fragment was not treated as a complete approval.
3. Full physical-applier review identified revision adoption and documentation boundaries. Its hypothesis that quarantine might overwrite completed state was checked against actual core guards and lost-ACK tests, and rejected.
4. Final physical-applier review returned “No remaining blocking defect in the delta.” This applies to the experimental host port, not production activation. Minor observations and our treatment are below.
5. Reviewer-input review found real policy enforcement, Git root and incremental-evidence gaps; all three received failing reproduction tests and fixes. Final reviewer recheck is recorded below when available.

| Finding | Resolution |
|---|---|
| Group/other executable bits misclassified as Git executable | Owner execute bit now controls Git mode; regression reproduced before fix |
| Failed quarantine persistence still reported quarantined | Separate reconciliation_required result; lost DB ACK cannot claim persistence |
| Failure catch discarded useful diagnosis | Bounded phase/path/temp/progress and allowlisted code; no arbitrary error text |
| Silent revision adoption between journal read and begin | Use the exact authorized revision; test injects lease renewal in that window and asserts zero writes |
| Canonical admission revoked after directory creation | Independently discovered; check admission before/after verifier at every boundary; RED/GREEN prevents next file write |
| Proposal paths/UTF-8/aliases supposedly unvalidated | Rejected as missing dependency context; existing strict validator already rejects them, extra filesystem-boundary tests confirm |
| Suggested weakening full-tree checks for speed | Rejected; 8-change limit and explicit inventory bounds retained; optimize only with equivalent proof |
| Quarantine may downgrade already applied receipt | Rejected by immutable core resolution plus actual commit-then-lost-ACK test |
| Pristine workspace scope unclear | Documented explicitly; ignored/untracked files are not silently omitted |
| Completed counter is not exact physical progress | Documented as durable lower bound, with sync phase; never a replay cursor |
| Quarantine after grant/admission revocation | Intentional forensic recording, not permission to write or release workspace |
| Duplicate begin returns reconciliationRequired | Intentional: a prior winner may have unresolved physical state; this loser cannot infer “nothing happened” |
| Completion artifact could precede failed DB commit | Explicit artifact-vs-authoritative-state boundary documented; no artifact-only recovery |
| Reviewer policy digest was decorative | Shared deny-first policy validation checks actual rules and cumulative/incremental union before reading blobs |
| Git could discover a parent repository | Explicit toplevel equality; regression with canonical .git subdirectory |
| Reverted/transient repair paths lacked bodies | Full incrementalChanges before/after, distinct from complete cumulative changes |
| UTF-8 BOM stripped by TextDecoder | Reproduced; preserve BOM and verify exact byte round-trip |

## Validation scope

Node 22.22.1; isolated temporary repositories, SQLite databases and OSSTACK_HOME. No production database was opened and no real writing/review provider API was called. Fake provider HTTP is used for lifecycle tests; Claude audits themselves were real calls.

- Physical application: 21 tests, including linked worktree, ignored file rejection, mode and original-checkout protection.
- Process SIGKILL: 18 windows: before/after gate, create/delete/replace, file sync, each mutation's directory sync, final completion. Reopen inspects authoritative state and proves no physical replay after an admitted attempt. Before-gate remains eligible for a genuinely first application.
- Invocation + physical host: 30 tests, including immutable lost-ACK outcome, provider evidence missing/forged, admission revocation and revision drift.
- Reviewer evidence: 13 tests, including cumulative repair, transient deletion, original-byte restoration, actual deny policy, BOM, exact size boundary, invalid UTF-8 and authority revocation.
- Core evidence/apply suites: 44 tests passed, including 17 evidence tests and 27 apply-ledger tests.
- Existing graph-action-broker regression: 35 tests passed.

Historical failed runs: initial missing-module tests; targeted regression REDs; one new alias test exceeded the default 5 seconds under load, unchanged timeout passed in subsequent whole-file runs. A newly written host assertion used a nonexistent admission query method/table; corrected to the real graph_action_admissions.released_at column. These were not hidden by skipping tests or raising existing thresholds.

Final expanded regression/build results and audit hashes are appended after execution. These counts describe selected scopes, not an all-monorepo green claim.

## Next Graph work

P06 and P07 are now partially implemented; no production registration has been enabled. Next is receipt-aware freeze/broker wiring under a new program identity, real authority/token-bound proof, independent reviewer transport, and a three-file daemon→ready acceptance test. Recovery, CLI diagnostics, eval and draft-PR delivery still follow. The roadmap is not complete and these local commits are not a published release.

## Reviewer recheck disposition

The final reviewer-input response confirms the policy, union-authorization and incremental-completeness findings are resolved, while maintaining “Not promotion-safe (unchanged).” Production activation is indeed outside this implementation. Its remaining claims were checked rather than automatically accepted:

- The 16385-byte maxBuffer bounds the read; oversize is intentionally context_incomplete whether rejected by subprocess or explicit byte check. The claim that the explicit branch is necessarily dead is not established and does not identify an acceptance bypass.
- Repeated cumulative/incremental bodies count twice because they are actually serialized twice. The 128 KiB aggregate cap and 200000-byte envelope cap are separate constraints; deduplicating the counter without deduplicating the actual envelope would misstate disclosure size. Kept conservative semantics.
- Exact SHA1/SHA256 blob IDs select matching hash algorithms; unverified compatibility-address modes are not promoted. Unsupported/mismatched data fails closed.
- Resolving trees after reading blobs cannot follow moving refs because all inputs are exact commit hashes. Reordering is optional, not a correctness fix.
- The review explicitly confirmed BOM preservation is correct.

No claim is made that Claude certified production readiness. The physical-applier final response found no blocking delta; the reviewer-input final response retains the activation limitation above.

## Audit response integrity

Raw responses are local temporary audit artifacts, not guaranteed permanent archives. These SHA-256 values identify the actual JSON inspected:

| Response | is_error | Recorded models | JSON SHA-256 |
|---|---|---|---|
| design | True | claude-opus-5 | `75f4e60a15fc4fb8c8b2043187194970189d788586f3cbcb7c0c618b6d01a16e` |
| code1 | False | claude-opus-5 | `dff146a2909a70a49cf33310354278a96060a18950697de888b9b4ed658c5b4e` |
| code2 | False | claude-opus-5 | `13bbf5fba70b2747ab0bcab92f30cc83569060435442f501e93ff10442e4b884` |
| final | False | claude-opus-5 | `c593cd18dcbbb632a28efa51104f650bc23ab412265227d87c329cac5d2c5994` |
| review-input | False | claude-opus-5 | `77b39f3a435f2677b4aa13f05f627b0c5d5b419ed108dc774b9aec83df1d82b2` |
| review-input-final | False | claude-opus-5 | `68bda02d84f73ccf90ea4a6afa58d4191a520b1a1e149f2298648a4e28dcc2af` |

## Final local checks

- CLI selected seven files: **135 distinct tests passed** (21 physical apply, 18 process crashes, 30 invocation/host, 13 review input, 35 broker, 17 broker boundary, 1 daemon broker). The clean-filter test was subsequently strengthened with a real `.gitattributes` binding and side-effect marker and rerun separately.
- Agents full package: **352/352**, 24 files, maxWorkers=1. This includes existing Jev tests as regression only; no Jev development or live calls.
- Core selected evidence/apply suites: **44/44**. Total across the three disjoint scopes: **531** tests, not counting repeated targeted runs.
- Core, Agents and CLI builds passed; CLI strict typecheck passed; Biome on 11 changed TypeScript source/test files passed; command inventory fresh; git diff --check passed.
- Built CLI startup, explicit temporary OSSTACK_HOME, five samples: `--version` median 59ms (57–64; 150ms budget), `--help` median 144ms (135–702; 500ms median budget). A high individual help sample is retained here, not hidden by the median.
- No full-monorepo test run or production durability/canary claim. No new eager root export, dependencies, daemon startup behavior, migrations, release, merge or remote push.
