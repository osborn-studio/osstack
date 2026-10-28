# Change-impact and performance-measurement methods

This D2a delivery adds two source-adapted engineering methods to OSStack's existing four named entries and both project export formats. The integrated package has nine methods. It does not register a new runtime command or import the upstream catalog wholesale.

- **Change impact:** pin the real change boundary; name the safety assumption; inspect callers and persisted, generated, cross-language and temporal consumers; propose falsifiable checks; preserve evidence when scope changes.
- **Performance measurement:** compare equivalent completed correct work, disclose failures and timing boundaries, measure noise and bottlenecks, distinguish latency reduction from throughput gain, and challenge implausible end-to-end improvements. Numerical examples are synthetic teaching data.

## Source and authorship

Upstream remains pinned to `99b609a72323b70204eab407c622f436e858e112`, with original author/license attribution in the [package source index](../../../osstack-methods-skill/references/sources.md). Adapted originals are `blast-radius`, `benchmark-checklist`, and `principle-explain-the-number`.

A authored `f6c56937f7b3ca75a0b349d9f757a8caa901da3e` (eight-method intermediate, 80 export tests); B authored `5f7797034437e5005dbfe8696c4a3762d3a7e724` (standalone performance material). Root integrated the shared nine-method routing at `4483e7d676fdb8c53b0b84a0611d5a6755b1ab95`, then addressed audit suggestions at **`687811a69c564b5812200c65f02e8aba35f002a3`**. Historical author results retain their original scope.

## Independent verification and actual audit

Independent criteria were frozen before implementation: `ebec2ebce5de0cc5c5d1ea6f933ca0e5b5b069c1bfaab2ca1d858627395a9436` (12 criteria). Final independent exports at 687811a6 have **64 material files and 201 local links per host**; all four entries reach all nine methods. Manifest bytes, lengths and inventories were checked. Synthetic fraction checks distinguish 20% throughput gain from 16.67% time reduction for equal work. A reviewer-helper comparison-range mistake and its correction remain in the raw record.

Actual Claude CLI `claude-sonnet-5-5` returned PASS on the supplied 4483 source, with optional improvements. Root adopted explicit throughput direction, queue/contention assumptions, profiling authority and scope-change rechecks. A second actual invocation returned limited closure PASS for that exact 6878 diff. Root independently checked 22 supplied-source bindings plus both raw prompt/response hashes. These static audit results are not runtime or host-behavior qualification. An optional direct-label mirror test and ABBA wording were not added; existing real graph tests cover the intended navigation contract.

Final exports: **81 passed, 0 failed, 0 skipped**. Full package regression and final document checks are bound separately in [validation](evidence/validation.json). The four generated knowledge dist files produced by the fresh build are preserved as a patch in raw evidence and excluded from the delivered change.

## Evidence and limits

The [archive manifest](evidence/manifest.json) binds original source anchors, author tests, independent freezes and checks, original audits, raw full-regression logs and operational receipts. Earlier bounded code-review host observations are included at [their own source-bound report](../method-review-behavior/README.md): both remain LIMITED despite recognizing the small defect correctly. Those runs used the earlier review method, not these two new methods.

No new host model invocation or real performance benchmark was run for the two new methods. Export consistency, synthetic math and static review do not demonstrate native use, broad review efficacy, causal improvement, or J01/J11/runtime qualification. User gilberthello retains PR approval and merge ownership.
