# Shared code-review method

OSStack now supplies one shared code-review method through its existing four entries. It turns a request to review code or a PR into scoped, evidence-based findings. The method pins the candidate, traces reachable inputs, separates observed failures from source reasoning, and preserves review-only versus review-and-fix authorization.

This slice adds method text and export/navigation tests. It does not add a reviewer service, model panel, runtime permission, automatic PR action or formal gate. Codex and Claude receive the same reference bytes through the existing exporter. Actual host selection and the quality of a host's review remain untested for this new method.

## Sources and adaptation

The upstream source is `cursor/plugins` at `99b609a72323b70204eab407c622f436e858e112`, under `pstack/skills/`. The adapted wording and links are maintained in [source attribution](../../../osstack-methods-skill/references/sources.md).

| Source | Capability retained | OSStack adaptation |
| --- | --- | --- |
| `interrogate/SKILL.md` | Intent, bounded review input, findings synthesis | No fixed model panel; use actual authorized host capabilities |
| `interrogate/references/rubric.md` | Concrete execution path, root cause, integration and behavior checks | Bind findings to the reviewed candidate and actual caller contract |
| `interrogate/references/lead-judgment.md` | Evidence-based disposition and false-positive filtering | Agreement is a signal, not proof; a single supported issue can matter |
| `interrogate/references/code-quality-review.md` | Structural costs and simplification | No file-length blocker or preference-only rewrite |
| `principle-test-behavior-not-implementation/SKILL.md` | Tests catch wrong behavior and tolerate equivalent internals | Distinguish helper coverage from the real user-facing surface |

The upstream opening-a-PR playbook was inspected for context. Its publication, reset, model and automatic readiness rules are not imported. Existing user-reserved approval and merge steps remain in effect.

## Scope and verification

Development starts from provisional PR #295 commit `d63dbdce7f78c2647ad41576c98b6f2df4d41aaf`, based on main `42dbdb0a`. This is a dependency record, not a claim that PR #295 was merged at authoring time. The slice changes nine files: one new reference, the root skill and four entries, source attribution, export tests, and this record. Exporter production code is unchanged. The integration owner updates `EXPORT.md` separately.

The focused RED run had 3 passing and 5 failing tests. The absent new reference caused two real export observations to fail; the new routing and attribution checks also failed. The missing-reference negative test initially failed during fixture setup because the method did not exist yet. It was not an exporter-refusal observation at that stage. After implementation, the full exporter test file passed **77/77**. It includes actual Codex and Claude exports, all four entry paths reaching the reference, byte/hash checks, and rejection before output allocation when an advertised reference is removed from a scratch copy.

Separate retained CLI exports produced **56 files per host**, including four byte-identical copies of `code-review.md`. All manifest file lengths and hashes matched. The root skill and four entries passed `quick_validate.py`; that check establishes structure, not decision quality. No wording-match test is presented as a model review result.

An author walkthrough reused an existing, previously confirmed checker defect without editing source or generating a new mutant. The original `1038dc9a0f79696d4077064181321de7501b7cb8` checker accepts a retained packet that simultaneously says a case was not run, cleanup was not started, and its fixture was removed. The fixed base rejects the same bytes. Both accept the retained valid control. This gives a concrete trigger and observable contract violation. A preference to rename a short helper supplies neither, so it remains a style suggestion. The walkthrough is informed by prior knowledge; it is not an independent oracle, a new defect report, or a host-consumption experiment.

Raw author records are retained under the task scratch root at `runtime/method-native-packet-20261028/author-preflight/code-review/`: RED/GREEN commands and output, skill validation, both export manifests and bytes, and the historical walkthrough's unchanged input/source hashes and four actual command results. The independent reviewer froze seven criteria before reading the implementation; the integration owner retains that review and subsequent audit separately. Full-suite validation and actual Sonnet audit belong to the integration owner, not this author check.
