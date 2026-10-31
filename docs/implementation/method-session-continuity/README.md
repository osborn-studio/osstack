# Session continuity method

This adds the twelfth shared OSStack method to the four existing entries. It covers scoped recall, authorized continuation, handoff and explicit pause. The implementation is method material and exported navigation, not session persistence, a background supervisor or runtime recovery.

The author branch starts at main `a9e480d39b9fcff206f356cee75a72cc9cc4d9e4`. The new method is `osstack-methods-skill/references/session-continuity.md`. Root/mode/help/agent link it directly; setup reaches it through mode. The exporter implementation is unchanged.

## Original sources and adaptation

pstack sources and Firstmate attribution (removed) preserve original authors and exact revision URLs. The author read Git objects, not a secondary report in place of original sources:

| Original source | Retained capability | Adaptation boundary |
| --- | --- | --- |
| pstack `99b609a72323b70204eab407c622f436e858e112`: `recall/SKILL.md`, `poteto-mode/playbooks/session-pickup.md` | Scoped history, bounded reads, durable decisions, reuse valid checks and verify inherited claims | No assumed transcript location, connector, model or blanket replay |
| Same pin: `poteto-mode/playbooks/pause-safely.md` | Explicit pause, safe boundary and resume note | No mandatory WIP commit or cancellation of another owner's work; repository scratch rules apply |
| Same pin: context-window and idempotent-operations principles | Bounded context and reconciliation before repeated effects | Advice does not establish a safe retry or authorize a lock release |
| Firstmate `af1c6817fc47589b162cbc361671c43cdb150933`: `.agents/skills/captain-hold-lifecycle/SKILL.md` and `away-quiet-supervision/SKILL.md` | Pending decisions survive completion of a report, ongoing responsibility and owner-aware state | No copied Firstmate command, turn-end hook, new approval policy or ordinary D2a identity gate |
| Same Firstmate pin: `bin/fm-afk-launch.sh`, lines 455–523 | Actual implementation separates close request from exact backend absence; unconfirmed teardown retains its ID | Source observation only; OSStack does not claim that mechanism was implemented or exercised here |

The inspected licenses are MIT: pstack Copyright (c) 2026 Lauren Tan; Firstmate Copyright (c) 2026 Kun Chen. Material is independently worded. The source snapshot preserves both licenses and full original bytes/hashes. Frozen joint recovery requirements remain unchanged.

## Concrete semantic examples

These are author walkthroughs, not model-run results or formal recovery tests:

- A handoff says “PR merged” but the forge still shows open and the current head differs. Retain the historical report, record the current observation, and do not claim that main contains the work. Resume independent authorized work; recheck tests affected by the changed candidate.
- A paused chat has no command receipt and its backend is unavailable. Preserve the run identifier and unknown state. Do not replay the command, release its lock or report successful cleanup. This is distinct from an observed backend absence.
- The user previously authorized implementation and now says “continue.” A known exclusive file boundary can resume without a new identity approval. A recap-only request returns the capsule instead of executing its next step.
- A review report is finished but a user decision remains held. Preserve the unresolved decision and its owner; archiving the report does not resolve the hold.

## Author validation and limits

Commands use Node 22.22.1 and the repository scratch root. The retained records bind the base and tested file hashes; the final candidate SHA is recorded separately after commit.

- Initial focused RED: 8 passed, 6 failed. It established the missing method/navigation. The missing-reference negative case initially failed during fixture removal because the method did not yet exist; this was not an exporter rejection.
- `node --test scripts/export-osstack-methods.test.mjs`: 88 passed, 0 failed, 0 skipped. Real CLI graph tests reach the method from all four entries on both layouts, preserve source bytes and reject a missing advertised reference before creating output.
- Actual Codex and Claude exports each produced 76 files. Every manifest member's size and SHA-256 was independently recomputed. One first export failed because its owned output parent did not exist; that failure was preserved, then the parent was created and both exports succeeded.
- `quick_validate.py` accepted the source skill and four entries. This checks skill format only.

The author evidence is under the task-owned `method-continuity-20261029/author` scratch area, with source hashes, original RED/GREEN output, export receipts/manifests and validation records. Root owns final archival publication, independent review, actual Sonnet audit and the full-suite queue. No native model invocation, process stop/recovery, real provider, runtime gate or control-plane database was exercised by this slice. Historical host experiments do not qualify this new material.

## Audit revision

The actual Sonnet review of author candidate `0ed5bbb799df22048ef058e59861c86640c7b788` requested two corrections. The revision traces the goal and authority to current trusted instructions or an authorized task record, checks the action/candidate, and obtains ownership from current assignment rather than a handoff claim. It preserves visibly authorized work without repeated approval. The handoff now records base, dirty-file owners and the next observer/trigger or explicit coverage gap.

The revision also makes review-only scope explicit, distinguishes failed backend queries from absence, preserves resumable scratch, links the authoritative ledger without completing the parent, and removes unexplained qualification jargon from exported guidance. Source attribution names the inspected copyright holder and links the exact implementation lines. No semantic wording-presence tests were added. The existing structural source-link check follows the anchored URL.

Revision validation separately ran all 88 exporter tests and two fresh 76-file exports with complete member hash/size checks. These results do not replace the original RED/GREEN records. The original review and item dispositions remain in the task evidence; root owns their published archive and final audit closure.
