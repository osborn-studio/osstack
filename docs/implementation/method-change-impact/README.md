# Shared change-impact method

The author slice adds an eighth shared method: determine what a change can break beyond its diff, identify the safety assumptions that matter, and challenge them with concrete evidence. It routes through the existing four OSStack entries. It adds no runtime analyzer, model panel, execution permission or gate.

## Source mapping

The source is `pstack/skills/blast-radius/SKILL.md` from `cursor/plugins` at `99b609a72323b70204eab407c622f436e858e112`. Its SHA-256 is `2e10745b97f5862323dcda3b29ca60d56b5c3c98e37020085d26b48efbe0a436`. The shared source attribution (removed) retains the upstream name and author; the adapted method name is `change-impact`.

| Upstream capability | OSStack adaptation |
| --- | --- |
| Identify the fact that makes the change safe | Make key assumptions falsifiable; search for counterexamples; retain independent boundary promises when one fact is insufficient |
| Follow what symbol search misses | Trace real consumers through data, persisted and wire contracts, versions/local patches, generated artifacts, timing and teardown |
| Prove the important fact with actual code | Prefer a discriminating check of the real implementation/caller; record inputs, build identity, command and result; do not substitute a mocked assumption |
| Separate risks from cleared cases | Tie each risk to a reachable trigger and consequence; use evidence-based likelihood and bounded cleared scenarios |
| Show how far the evidence reached | Distinguish source reasoning, traced exclusions, executed checks and application observations; keep blocked/not-run and unknown paths visible |

OSStack does not import a mandatory arena or fixed model defaults. Candidate execution remains untrusted and requires owned isolation, no injected credentials, and task-permitted network and writes. If those limits cannot be established, the method retains a source-supported assessment and an explicit missing check. Analysis alone does not authorize product changes, publication or production access.

## Author scope and checks

This author branch starts at merged main `92088fe55a2f985ca743fa1fabee0c081a6f672d` after PR #296. Its ten-file slice consists of the new reference, the root skill, four entry files, source attribution, `EXPORT.md`, exporter tests and this record. The separate performance method and any integration-owner changes are outside these author counts.

The raw author check records bind the tested file bytes to this slice. The first selected test run reported **4 passed, 6 failed, 0 skipped** before the reference existed. The reference-existence, two actual host-export observations, navigation and source-link checks failed as expected. The missing-reference negative test initially stopped during fixture setup because there was no reference to remove; that initial result is not described as an exporter rejection.

After implementation, the complete exporter test file reported **80 passed, 0 failed, 0 skipped**. It drives both real CLI export layouts and traverses their reference graph from every entry. It checks the new reference against canonical bytes and manifest hashes. A scratch-copy negative removes the advertised reference and observes rejection before an output directory is reserved. Thus the positive and negative cases check an actual consumer contract: exported navigation remains usable and incomplete material is refused. They do not establish the quality of a model's impact analysis.

Two additional retained CLI exports each contained **60 files**, including four byte-identical copies of `change-impact.md`; all manifest lengths and hashes were verified. The root skill and four entries passed `quick_validate.py`. These figures describe the author-only eight-method package, not a later combined package or a host's native selection behavior. Historical host observations in `EXPORT.md` remain tied to their original material version.

The author records live under the task scratch root at `runtime/method-impact-performance-20261028/impact/`: the fixed upstream source/hash, original RED and GREEN command outputs, actual export manifests and bytes, and skill-format results. The candidate freeze and archive manifest bind these records for integration. Independent criteria were frozen before implementation; independent review, actual Sonnet audit and the full-suite queue are separate integration records. This author task ran no model, application driver or full repository test suite.
