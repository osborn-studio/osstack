# Operator handoff and canonical verification recipe integration

> Historical source-scoped report. For current acceptance, see [v2 status](bridge-phase5-verification/current-v2-status.md) and the [fourth-run evidence](bridge-phase5-verification/fourth-run-v2.md): fourth sandbox v2 `LIVE_5G_ONLY` PASSED 13/13; attempts 1–3 remain failed/unqualified. Old pending, checkout-selection and cold-helper findings below retain their original scope. The fourth cold scenario still cancels before first executor tick, not during an in-flight executor. Production remains CLOSED; no fifth run is authorized.

Branch `codex/bridge-operator-handoff`, base `315e7fc4` (frozen812 plus reviewed
journal-root fix and portable fixtures). This node changes only documentation
and the existing `.cursor/skills/verify-osstack` content. It does not change
package TypeScript, scripts, rulesets, ADR history, default31 UI/CLI cases,
settings or runtime state.

## Selected work and final scope

The five original handoff commits28c784c9,9ab79a95,4eb00b31,bdf9a0c8,df70c700
were selected individually, without their old main/runtime history. Independent
CLI7 ac62e8cf and CLI8 23609599 supply the cloud execution package and the optional
canonical skill recipe. No duplicate `.agents` skill was added or restored.
The four original feature files and every existing helper script remain byte
identical to315e7fc4. The optional recipe has the existing four-section shape
and matches the current nine-file offline CI command.

Final review corrections preserve supplied Bot schedules/dependency grammar,
GitHub as business bus and optional Webhook wake. They update D's minimum to
pull_requests write + metadata read, add whitelisted local sandbox API evidence,
and retain unknown main access/cloud identity. The public Bot numeric IDs are
expected identity values, not proof of a Routine's active App binding. Local
HTTP200 does not attest private repository access or U1/U9/U10. Detailed scope
and hashes are in the [local capability report](2026-11-07-bridge-local-app-cd-capability.md).

The [cloud package](../runbooks/bridge-cloud-operator-execution.md) preserves
ordinary Watcher/Merger/Order/CoS flow. Mission-only coexistence exclusions are
proposed owner decisions requiring owner confirmation and applied-config readback;
App D approval does not replace mandatory counted human approval. The
[Reviewer draft](../runbooks/bridge-reviewer-routine-draft.md) remains disabled,
sandbox-only and COMMENT_ONLY until its stated gates. Nothing was sent to Bots,
installed in cloud or enabled. Existing runtime/runbooks copies were not
activated or overwritten; the parent may synchronize an approved fixed copy.

Mac mini continues to own only osstack runtime, local DB/journals, Codex/Docker
execution and App A/B publication. Existing cloud Bots coordinate GitHub business
state; they do not receive local DB access, private keys or a new platform.

## State and limits

Parent reports #421/#422 CI green; this node did not refresh GitHub or infer
merged state. Real5G attempt1 failed and remains failed. Parent reports attempt2
in progress, with cancelled cold restart and A-two-rounds asserted, B pending;
this node did not independently execute or qualify that run. **Real5G and
production acceptance are not marked complete.** Historical audit snapshots
retain their source bindings and do not certify current behavior.

## Executed validation

- Offline frozen-lock dependency reuse passed, no lock/package-manifest delta.
- Skill quick_validate.py: Skill is valid.
- Governance `osstack-config.test.ts`, max/minWorkers1:1/1 passed. This resolves
  the earlier CLI8 environment's recorded blocked audit only for this tree; it
  does not rewrite that historical failure record.
- Static byte comparison: original4 feature files and all existing helper files
  equal315e7fc4; package/scripts/.agents net diff empty.
- Recipe versus CI: same9 offline files, same order. H1/four required H2 headings
  and Preconditions format preserved.
- Final changed Markdown relative links:59 resolved,0 broken; diff whitespace pass.

No full workspace test, typecheck/build, live probe, serving DB or runtime launch
was used for this docs-only delta. The parent's final runtime tests and real
attempt remain independent. Prepared documentation does not request redundant
approval for already authorized work or certify unknown configuration.

## Main-base PR draft

Title: docs(bridge): hand off existing operators and optional verification recipe.
PR base main; dependency placeholder `merge after #N10_PR_NUMBER` must be replaced
with the actual N10 PR number before publishing, or removed if already merged.
Only this docs/skill delta should remain once that dependency is merged. Parent
owns push, PR and any later configuration actions.
