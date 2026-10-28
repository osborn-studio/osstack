# Task framing and caller-first architecture

This D2a delivery adds task framing and architecture design to the shared OSStack method package. Four named entries route eleven methods into Codex and Claude project layouts. These are reusable engineering instructions, not new runtime commands.

Task framing preserves the user's objective, constraints and unresolved choices, names original sources and concrete methods, and asks what observable evidence could disprove the result. A prompt-only request stops at the rewritten prompt; an already-authorized refine-and-execute task continues without a new approval ceremony.

Architecture design starts with real caller use, domain states and ownership. It compares distinct structures against the same constraints, makes lifecycle and migration obligations explicit, and separates an unimplemented sketch from execution proof. The small report-coordinator example is synthetic manual analysis, not an OSStack API or a crash-test result.

## Source and ownership

Baseline main `711c45e75264000bde859328bd7dc131f68461d1` is the user merge of PR297 and has the same tree as published0862bc38. Historical validation keeps its original SHA. Upstream is pinned to `99b609a72323b70204eab407c622f436e858e112`; the [source index](../../../osstack-methods-skill/references/sources.md) preserves original identities, attribution and adaptation choices.

A owns task framing at `01c4977b954635d245799d00172592d76e2cd857` (ten-method intermediate,84exports). B owns architecture material at `6ec4c38a9f4e1bd2351dd0ad3cfd84ebe7fc1e82` (two new files; source/link and explicitly manual synthetic checks). Root integrates the eleventh method at `85d34eb1f8681fb26a8328431fb69f3509596f6b`, then repairs source attribution, entry/experiment scope and synthetic-state explanations at `035285cf26c6fe26a751cbbb93020b2f8cd5c1d8`. Shared files had one writer at each stage.

## Verification

Before authoring, independent reviewer froze12criteria at `637590cc7b487b039e5c4f85469b494fe671aadaef236bbc25886a1a44b2a101`. On85d34, actual independent Codex/Claude exports each contain72files/247local links; four entries reach all eleven methods. All member hashes, lengths, inventory and both new method bytes match. Final035285cf independently re-exported both layouts with the same72files/247local-link counts; four added external source URLs do not increase the local graph count. Prompt-only versus authorized execution and caller/state/lifecycle counterexamples were reviewed statically. These are not model judgments or executed lifecycle tests.

Final automated export tests at85d34:85passed/0failed/0skipped. The package suite at85d34 passed7144/5skipped/0failed, with generated build files and an untracked delivery draft disclosed; this is not a final clean whole-tree claim. After seven document-only corrections,85export tests pass again. Actual Sonnet review and final publication checks are separately bound in [validation](evidence/validation.json). Original failures remain in the [raw evidence manifest](evidence/manifest.json).

## Actual usage limits

No new native-host behavioral outcome is claimed for these methods. An additional task-framing host-probe preparation is a proposal only; it needs independent criteria freeze, final-context/resource checks and explicit root dispatch before calls. Earlier host LIMITED or failed results remain unchanged. Export consistency and static review do not qualify broad host efficacy or J01/J11/runtime gates. User gilberthello retains approval and merge ownership.
