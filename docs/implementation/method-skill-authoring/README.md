# Skill authoring method

This change adds reusable skill creation and maintenance to the shared OSStack methods. There are fourteen named methods and the same four exported entries. Generic skill authoring has a distinct route from project verification creation and maintenance. It adds no installer, independent native skill registration or runtime integration.

The method starts from a repeated task, a representative request and a nearby nonmatching request. It guides scoped source edits, precise descriptions, useful references and improvements grounded in task evidence. It preserves existing authorization while separating evidence from authority to install or publish. Structural fixes outside a skill-only task remain follow-up work. Format/export checks, host selection and actual task outcomes remain separate claims.

## Sources and adaptation

The original pstack commit is `99b609a72323b70204eab407c622f436e858e112`: `poteto-mode/playbooks/authoring-a-skill.md`, `reflect/SKILL.md`, `correct/SKILL.md`, and `principle-encode-lessons-in-structure/SKILL.md`, all under `pstack/skills/`. Firstmate commit `af1c6817fc47589b162cbc361671c43cdb150933` supplies `.agents/skills/agent-skill-trigger-index/SKILL.md` and `.agents/skills/firstmate-self-repo/SKILL.md`. The [source attribution](../../../osstack-methods-skill/references/sources.md) retains the original links, MIT license attribution and excluded host-specific behavior.

These are independently worded adaptations. They do not import mandatory reviewer models, automatic tracker publication, global transcript collection, cache mutation, Firstmate role machinery or a new approval requirement for already-authorized edits.

## Author validation

The author worked from `50ed89fbe1fa9e7ebba520214390f97725164728`. Before writing the method, three focused source/export checks failed because the new reference did not exist. The original failures were retained.

After implementation, Node 22.22.1 ran `node --test scripts/export-osstack-methods.test.mjs`: 94 passed, no failures or skips. This includes the actual CLI exports, distinct declared routes and rejection of an owned source copy with the new reference removed before an output is created. The script verifies observable file/navigation behavior, not model judgment.

Separate actual Codex and Claude exports each contained 88 manifest payload files and 321 local inline links. All payload sizes/hashes and source hashes were checked. Each of the four entry graphs reached skill authoring and both specialized verification methods. Five frontmatter checks passed with the available skill-creator validator. The exports were not installed. Fragment semantics and remote link availability were not tested.

Raw command records, the original RED, complete GREEN output, source hashes and export manifests are retained in this batch's author evidence for root integration. The author did not run a model or full package suite. No new host discovery, task-performance improvement or runtime qualification is claimed. Later independent review, task fixtures and Sonnet audit results must retain their own candidate bindings.

## Audit revision

The initial author candidate was `b8bfc83ceee2065cf8192e9de083c24707c13976`. The subsequent static audit found that its new navigation test used a greedy expression and overstated the result. A controlled source copy put two method links on one row: the old test passed, while the revised test rejected the mixed row. The revised test collects every link on each table row and checks that the three methods have separate rows. Its name now describes only that navigation property. The root description also explicitly names reusable agent skills to distinguish generic authoring from project verification.

The revised 94-test suite passed. Fresh dual exports and five format checks passed with the same file/link counts. Original failures and audit text remain retained separately. The source-attribution concern was checked against the full file: the encode-lessons link and Firstmate MIT attribution already exist at their fixed pins. No URL-string test was added as a substitute for original-source verification. These results still do not establish model selection or host task success.
