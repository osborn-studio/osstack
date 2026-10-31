# Shared code-review method

OSStack now supplies one shared code-review method through its existing four entries. It turns a request to review code or a PR into scoped, evidence-based findings. The method pins the candidate, traces reachable inputs, separates observed failures from source reasoning, and preserves review-only versus review-and-fix authorization.

This slice adds method text and export/navigation tests. It does not add a reviewer service, model panel, runtime permission, automatic PR action or formal gate. Codex and Claude receive the same reference bytes through the existing exporter. Actual host selection and the quality of a host's review remain untested for this new method.

## Sources and adaptation

The upstream source is `cursor/plugins` at `99b609a72323b70204eab407c622f436e858e112`, under `pstack/skills/`. The adapted wording and links are maintained in source attribution (removed).

| Source | Capability retained | OSStack adaptation |
| --- | --- | --- |
| `interrogate/SKILL.md` | Intent, bounded review input, findings synthesis | No fixed model panel; use actual authorized host capabilities |
| `interrogate/references/rubric.md` | Concrete execution path, root cause, integration and behavior checks | Bind findings to the reviewed candidate and actual caller contract |
| `interrogate/references/lead-judgment.md` | Evidence-based disposition and false-positive filtering | Agreement is a signal, not proof; a single supported issue can matter |
| `interrogate/references/code-quality-review.md` | Structural costs and simplification | No file-length blocker or preference-only rewrite |
| `principle-test-behavior-not-implementation/SKILL.md` | Tests catch wrong behavior and tolerate equivalent internals | Distinguish helper coverage from the real user-facing surface |

The upstream opening-a-PR playbook was inspected for context. Its publication, reset, model and automatic readiness rules are not imported. Existing user-reserved approval and merge steps remain in effect.

## Scope and verification

Author development began from PR #295 commit `d63dbdce7f78c2647ad41576c98b6f2df4d41aaf` while that PR was provisional. The author candidate `1d00ac4fd92d7f29c7650332fea61b2f409ea4f2` changed nine files: one new reference, the root skill and four entries, source attribution, export tests, and this record. PR #295 has since merged as main `70924ee44a478f5ef345307b885bda6b936e6662`; both base commits have tree `0541fafbab9c9a96a1695fbb29a0b6bb15e278e1`. The integration candidate `1e9525971176510c4008b3fcea9c6d199147882c` includes ten method-related files: those nine plus the integration owner's two wording updates in `EXPORT.md`. Its complete diff also contains separate project-control and prior-publication records. Exporter production code is unchanged.

The following results are author-reported for `1d00ac4fd92d7f29c7650332fea61b2f409ea4f2`, not claims about a later integration or revision. The focused RED run had 3 passing and 5 failing tests. The absent new reference caused two real export observations to fail; the new routing and attribution checks also failed. The missing-reference negative test initially failed during fixture setup because the method did not exist yet. It was not an exporter-refusal observation at that stage. After implementation, the full exporter test file reported **77 passed, 0 failed, 0 skipped**. It includes actual Codex and Claude exports, all four entry paths reaching the reference, byte/hash checks, and rejection before output allocation when an advertised reference is removed from a scratch copy.

At that same author candidate, separate retained CLI exports produced **56 files per host**, including four byte-identical copies of `code-review.md`. All manifest file lengths and hashes matched. The author reported that the root skill and four entries passed `quick_validate.py`; that check establishes structure, not decision quality. No wording-match test is presented as a model review result.

An author walkthrough reused an existing, previously confirmed checker defect without editing source or generating a new mutant. The original `1038dc9a0f79696d4077064181321de7501b7cb8` checker accepts a retained packet that simultaneously says a case was not run, cleanup was not started, and its fixture was removed. The fixed base rejects the same bytes. Both accept the retained valid control. This gives a concrete trigger and observable contract violation. A preference to rename a short helper supplies neither, so it remains a style suggestion. The walkthrough is informed by prior knowledge; it is not an independent oracle, a new defect report, or a host-consumption experiment.

Those original author records are packaged in `code-review-author-evidence.tar.gz` (SHA-256 `bf76abcdc0bacd47357b30f05ead1b416b97faeaac727a33ba6270b632b1157d`, 148 verified members). The integration owner publishes this immutable bundle with the final evidence archive. Later revision checks must retain separate candidate bindings; they do not replace these results. The original local records remain under the task scratch root at `runtime/method-native-packet-20261028/author-preflight/code-review/`: RED/GREEN commands and output, skill validation, both export manifests and bytes, and the historical walkthrough's unchanged input/source hashes and four actual command results. The independent reviewer froze seven criteria before reading the implementation; the integration owner retains that review and subsequent audit separately. Full-suite validation and actual Sonnet audit belong to the integration owner, not this author check.

## Root delivery

The integrated method revision is `73d446b46e444ff5b8ef9a39c5fab962793967fd`; its four author revision files equal `ac9d8e60` byte-for-byte. Actual Sonnet5.5 first requested revision, then passed the limited B1/N1–N9 closure against supplied final files. Root separately verified every supplied audit file against the committed candidate. Final exporter tests report77 passed/0 failed/0 skipped. Full Node22 regression at earlier `b576aa46` reports7144 passed/5 skipped/0 failed; the later four method/document/test files received targeted checks, and the earlier full result is not relabelled. Published-head CI remains required.

The first full attempt on default Node26.5.0 failed in an unchanged GitHub mutation test because its TypeScript transform mode is no longer accepted. The same107 GitHub tests passed under Node22.22.1, and native SQLite was rebuilt before the successful Node22 full run. Original failure and environment comparison are retained; compatibility debt `card_502e84bf` remains unresolved. No test was skipped or weakened to obtain this result.

See [audit and validation evidence](evidence/manifest.json) and the separately scoped [packet host experiment](../method-packet-host-consumption/README.md). That experiment uses earlier six-method material, not this code-review addition. No native code-review execution or review-quality benefit is claimed by exports, the known-bug walkthrough, or independent text review.
