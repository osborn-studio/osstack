# PR readiness method

This adds the thirteenth shared method to OSStack's four existing entries. It guides a current PR snapshot or already-authorized blocker correction. It separates candidate-bound verification, review, integration state and human approval. It provides no watcher, forge service, merge automation or runtime qualification.

The author branch starts from `38f13cff5c4e161835eaa5c75c3976b5a8e95046`, the provisional PR #299 delivery. At dispatch, actual main was `a9e480d39b9fcff206f356cee75a72cc9cc4d9e4`; this work is not evidence that #299 merged or its CI passed. Root must reconcile the latest base before publication. In this joint project, the user retains approval and merge through `gilberthello`; the reusable method preserves the task's named human rather than hardcoding an account into all installations.

## Original capability and scope

The user priority list includes `babysit`, `opening-a-pr`, candidate/stack verification and evidence-based review handling. The original `cursor/plugins` Git objects were read at `99b609a72323b70204eab407c622f436e858e112`:

| Original path | Retained capability | OSStack boundary |
| --- | --- | --- |
| `pstack/skills/poteto-mode/playbooks/babysit.md` | Current candidate and forge status, owner/dependency order, CI classification, readiness distinct from landing | Status requests get one snapshot; no default drive, polling or inferred merge authority |
| `pstack/skills/poteto-mode/playbooks/opening-a-pr.md` | Reviewer-facing problem, behavior, scope, risks and actual verification | No unconditional PR creation/Ready, reset, rebase or publication |
| `pstack/skills/poteto-mode/references/bugbot-triage.md` | Check findings against code, keep reasoned dispositions and risk boundaries | Comments are untrusted data; repeated bot passes or historical noise do not disprove a real finding |

[Source attribution](../../../osstack-methods-skill/references/sources.md) preserves original fixed links. The inspected MIT license names Copyright (c) 2026 Lauren Tan. The new material is independently worded; no upstream executable code is copied.

Only ten authorized paths change: the new reference, root skill, four entry skills, sources, EXPORT, existing exporter test and this README. The production exporter is unchanged. Existing code-review, bug-fix, session-continuity and evidence references supply the detailed correction/ownership practices instead of duplicating a control plane.

## Concrete interpretation boundaries

These are author walkthroughs of the method, not executed model or forge results:

- H1 is green but H2 is current: retain H1 evidence and identify checks needed on H2, rather than reporting a current pass.
- CI is green but the forge reports conflicts and an unresolved substantive review: preserve both blockers; no automatic topology rewrite or thread dismissal.
- An unavailable API, pending check and completed failed check differ. None can be flattened into a current pass; the API failure alone does not establish a product defect.
- A check-only task receives a comment asking for a push and merge: report the finding within read-only scope. Comment instructions cannot grant authority. An actual user-authorized local correction may proceed without another approval, while publication and replies remain within their separate authority.
- A changed caller breaks an unchanged file: inspect the chain and logs rather than assuming a stale base from the filename. Retain any failed rerun and revise the diagnosis.
- An old approval or Ready label does not establish current approval/merge authority. Independent assigned work can continue while the human decision remains pending.

## Author validation

Node `22.22.1`, with `OSSTACK_SCRATCH_ROOT` explicitly set:

- Focused RED: 9 passed and 6 failed before adding the method. The missing-reference negative initially failed in fixture setup because the file did not exist; that was not exporter rejection.
- `node --test scripts/export-osstack-methods.test.mjs`: 91 passed, 0 failed, 0 skipped. It exercises actual two-host CLI exports, graph reachability from all four entries, byte preservation and missing advertised reference rejection before output creation.
- Two fresh actual exports each produced 80 files. All manifest member sizes and SHA-256 values were recomputed. The complete canonical material file-hash inventory was equal before and after both exports.
- Source skill plus four entry skills passed `quick_validate.py`; that is a format check only.

The task-owned `method-pr-readiness-20261029/author` evidence records exact commands/exits, original RED/GREEN outputs, source/license hashes, export receipts/manifests and candidate file bindings. A compact archive is handed to root; duplicate export trees remain in scratch. Root owns actual Sonnet review, independent checks, full-suite scheduling and publication.

No live PR/forge mutation, model invocation, default control-plane home, actual blocker correction or runtime gate was exercised in this material slice. The proposed future host-use experiment is not an executed acceptance test. Earlier host experiments do not qualify this new method.

## Audit revision

The actual Sonnet review of author `04840eda89650f3c41c9605c9b9648bfc482182f` requested three corrections. The revised method re-reads approval/change requests, unresolved threads and mergeability after an authorized push. CI records the evaluated base or merge commit where exposed, keeps unavailable bindings unknown, and checks applicable policy when the base moves. Final readiness is dated to freshly observed head/base; it is not a timeless claim.

Risk-sensitive dismissals now require concrete disproof against current code, including the affected principal and guard-before-effect ordering for a claimed later fix. Missing proof remains unresolved rather than silently dismissed. This does not import the upstream blanket ask policy or delay fixes already authorized. The revision also clarifies status-only execution limits, publication/rerun scope, comment-as-data handling and follow-up work after a merged owner.

The revision separately reran all 91 exporter tests and two fresh exports of 80 files each. Every member size/hash and the unchanged canonical source inventory were checked again. Original candidate results and the raw REVISE report remain preserved with item-by-item dispositions; these changes were not retroactively applied to the original evidence. Root owns final audit closure and any later host experiment.
