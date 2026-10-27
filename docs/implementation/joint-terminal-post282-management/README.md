# Post-#282 integration and project evidence

Main is `ede5aadced37ac9dc29dd21f0e307ad2c46d2976`. #282 merged its audited head `f81b72eb813533357e5317871dcbc5febe004244`; its original tested base remains historical. #279 product evidence is separately archived in the sibling `joint-terminal-post282` directory and bound by the execution ledger.

## Management audit

Actual Claude CLI model `claude-sonnet-5-5` reviewed the owner collector and operations prose in three rounds. The first two reports requested revisions; the final narrow closure passed. [Original round 1](management-report.md), [closure round 2](management-closure-report.md), and [final review](management-final-report.md) remain unmodified. The archive includes full prompts, raw JSON responses, stderr, scripts and dispositions. Final prose reviewed in scratch is copied byte-for-byte after full tests, then checked with the staged documentation. No model claimed to execute the Git, CI or RPC observations.

Confirmed fixes include immutable published-head archive reads, complete attachment/hash coverage, final-run log binding, source/head ancestry, receipt base/time binding, central-ledger compare-and-swap and atomic replacement, explicit single-owner writing, and clear wording that #279 has synchronized main but has not been merged. The offline validator itself is unchanged and pinned to main. Final collector adaptation to actual argv-array command records and status fields, exact raw audit member/model/source bindings, and stricter readiness selection was additionally checked by an independent reviewer against the immutable published archive; see [schema adaptation review](independent-final-refresh-review.md). Original historical snapshots are preserved; CI and Ready are timestamped observations and must be queried again before merge.

## Independent verification and bounded completion

[Independent report](independent/report.md) documents two real daemon/RPC/SQLite combined-fault tests and 12 selected R02 component regressions. Source bindings distinguish the earlier candidate used for those extra tests from the final adjacent-test commit. They do not replace the final full suite or actual Sonnet product audit.

The R02 library component is complete within its frozen original scope after #276 plus #282: supplied bytes, build/source/contract/version/qualification, invalid/expired/revoked/substituted entries and dependency eligibility are checked without runtime-home discovery or authority grants. This does not complete J02b, trust operations, dispatch integration or production qualification.

## Additional authorized concurrency

User authorized independent Codex sessions alongside the three local subagent slots. Session `01a17da2-4810-7543-b9d7-a008fe51c2e0` delivered the JA01/JA02 oracle prototype, 11 frozen vectors, 12 self-tests and detection of nine fault models. Its placeholder host run explicitly reports 11 blocked, exit 2; actual product host was not executed, and formal acceptance remains `specified_not_run`. The complete regular-file scratch capture and receipt are compressed in this archive, including the precise pre-freeze limitations.

The next-wave N0/O06/J11 proposal is exploratory input only: no frozen gate, dependency or product code is changed by this PR. Its local four-slot observation is not a project-wide limit; the user subsequently authorized independent sessions. Main coordinator alone owns integration and PR publication; gilberthello alone approves and merges. There is no autonomous OSStack goal_dispatch or recovery qualification.

All compressed and uncompressed SHA-256 values are listed in [the manifest](archive-manifest.json). This is owner-collected evidence, not cryptographic remote attestation. Post-publication CI observations are recorded after this immutable snapshot and are not claimed to be inside its own commit.
