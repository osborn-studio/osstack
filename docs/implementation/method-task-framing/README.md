# Shared task-framing method

This author slice adds a tenth shared method for restating a goal or improving a task prompt without expanding its purpose. A restatement-only request gets a concise understanding. A refinement-only request gets a rewritten prompt, not execution of the task inside it. An existing instruction to refine and then execute remains effective within its original scope.

## Original sources

The full upstream directories at `cursor/plugins` commit `99b609a72323b70204eab407c622f436e858e112` each contain one file:

| Source | SHA-256 | Capability retained |
| --- | --- | --- |
| `pstack/skills/in-your-own-words/SKILL.md` | `fa8ba74e27d7be371dc270ec78bbf816411477d0dfab185356c861ac8dd413ad` | Restate the user's goal and problem in your own words |
| `pstack/skills/sharpen/SKILL.md` | `563dfc460c605d311e650726288e2f1cbd61eab817db178d6e7e29643e07e7a2` | Deepen the approach through professional methods, original materials, specific tools and external evidence; preserve user-owned choices |

The pinned `pstack/LICENSE` is MIT, Copyright (c) 2026 Lauren Tan, SHA-256 `bc957ca6bee02792566a1a028d105e02e247c6e77cf057061674273da77b200e`. The original files and license are retained together in author evidence. Source attribution (removed) links to the pinned originals. The new reference uses independent OSStack wording.

The adaptation distinguishes stated constraints, supported facts, assumptions and unavailable inputs. Proposed tools and acceptance checks cannot be described as available or executed without evidence. It does not invent expert identities, grant new providers or external actions, silently decide user-owned tradeoffs, or demand fresh approval for routine choices already authorized. It supplies no prompt executor, model router or qualification mechanism.

## Author scope and verification

The baseline is merged main `711c45e75264000bde859328bd7dc131f68461d1`. The author changes ten files: the new reference, root skill, four entries, source attribution, export guide, exporter tests and this record. The architecture method and any later integration changes are separate. Exporter production code is unchanged.

The selected RED run recorded **6 passed, 6 failed, 0 skipped** before implementation. The missing method caused failures in existence, actual two-host export observations, route and source-link checks. The negative test that removes the new reference initially failed during fixture setup because the file did not exist; this is not reported as an exporter rejection. The original output is retained.

After implementation, the complete exporter test file recorded **84 passed, 0 failed, 0 skipped**. It exercises actual exports for both host layouts, traverses links from every entry, compares canonical reference bytes and manifest hashes, and rejects a scratch copy with the advertised reference removed before output allocation. These are material-delivery checks, not a test of a model's ability to preserve intent.

Two separate retained CLI exports each produced **68 files**, including four copies of `task-framing.md`; every manifest file length and hash matched. The root skill and four entry skills passed `quick_validate.py`. These results belong to the author-only ten-method package, not a later combined package. Historical host-consumption results remain bound to their original methods.

Raw records are under the task scratch root at `runtime/method-framing-architecture-20261029/framing/`. The author archive retains the fixed upstream sources and license, RED/GREEN commands and outputs, the new reference, tests, export manifests and candidate/source hashes. Duplicate exported reference trees remain in scratch rather than multiplying archive members. The frozen independent criteria precede implementation; independent review, actual Sonnet audit and full-suite validation belong to the integration owner. This author task made no model call, application-driver run or full-repository test run.
