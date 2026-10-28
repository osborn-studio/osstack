# Bounded code-review behavior observations

This engineering probe uses the shared code-review method at `73d446b46e444ff5b8ef9a39c5fab962793967fd`, published in PR296 at `4833bd97`. It does not require or claim PR merge. Two small synthetic candidates come from actual Git objects: a shared base, A changing nullish defaulting to logical-OR defaulting, and B consistently renaming the local binding. Both hosts received identical source/diff/intent/assertion bytes; their index differs only in host export paths; commit messages and evaluator oracle outputs were excluded. Real Git provenance is checked by the coordinator; models inspect snapshots, not a live Git repository. There is no no-method control and no claim of causal benefit or general review quality.

## Observations

| Host | Primary recognition | Consumption and limitations | Overall |
| --- | --- | --- | --- |
| Codex CLI 0.160.1 | Correctly identifies A's reachable zero-limit regression and rejects a style-only finding for B | 15 actual cat commands returned exact supplied bytes. Final 263 words; all assistant messages 285 words. It says no fallback was needed, but the trace shows explicit reads and no native Skill invocation. Requested gpt-6.1-sol is metadata-bound; execution-resolved model is not attested. | Limited; primary A/B recognition passes only in this scope |
| Claude CLI 2.1.291 | Correctly identifies A and reports no actionable defect in B | Native Skill(osstack-mode), exact method body and 10 exact Read results observed. Final 365 words, above the advisory 350 target but within the hard 500 ceiling. It transparently skipped four A/B intent/assertion files using index hash equality; evaluator knowledge of equal bytes does not count as model reads. Its extra assertion that non-numeric inputs behave identically across versions is overbroad: NaN/false are static counterexamples. The null aside contradicts itself. | Limited; primary A/B recognition passes only in this scope |

Both final answers separate static reasoning from execution. Neither host ran fixture tests, a product driver, installations, live Git or fixes. Original coordinator test logs were used only for the independent oracle, without a new fixture execution. Native method invocation does not authenticate the provider or establish a formal principal. Claude raw system/result metadata reports claude-sonnet-5-5; this is host-reported identity.

## Protocol and evidence

Twelve criteria were frozen before responses; a final preparation supplement bound the neutral prompt, two workspaces, exact runners, source objects, catalogs and guard templates. Root subsequently approved separate exact guards, each binding that supplement, before the actual calls. A new prospective 250–350-word target retained the unchanged 500 hard ceiling. Each host had one user turn, 180 seconds maximum and zero retries. Both returned exit 0 within budget and both 83-entry inventories remained unchanged. Owned temporary homes were removed by the runners; workspaces are retained at this observation until owner archive verification and cleanup. CLI authentication was internal to each host and not collected. Read-only settings and observed compliance do not establish an OS read fence, global host-state invariance or all-descendant termination.

The earlier Claude 515-word packet experiment remains failed; it used older material and a different task. These new under-limit responses do not regrade it. There were two new host user turns and no host retry; any separately recorded toolless report audit is not a host experiment. No J01/J11/runtime qualification follows.

Original criteria, preparation, raw streams, exact reads, inventories, counterexamples and independent dispositions are preserved with candidate hashes. The independent final grade is `04ea1c39646c57557f21064a018f387111ab64ee3723ff55b3b2f51a53fc9af3`. Next work should address attribution and exhaustive requested-input reading in prospective tasks, without changing these observations or claiming this tiny probe proves broad review competence.

Publication and historical scope are backed by the retained PR296 GitHub receipt and unchanged method/export diff from 73d to 4833; CLI versions come from preparation/host-binaries.json. The prior packet report and central gate ledger are separately retained supporting records, not facts inferred from these two new responses.

After the audited observation, root verified all352 members of the [raw archive](evidence/manifest.json), then removed only the two owned host workspaces. The [cleanup receipt](evidence/cleanup.json) does not certify global host state or descendant termination. Both limited grades remain unchanged. Actual report audit history is retained in [audit](audit.md).
