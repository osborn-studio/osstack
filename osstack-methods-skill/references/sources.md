# Pinned sources and adaptation

These instructions are independently worded OSStack adaptations of engineering practices in pstack, authored by poteto and distributed in `cursor/plugins`. The source consulted is pinned to commit `99b609a72323b70204eab407c622f436e858e112`, pstack version `0.15.32`. This pin identifies the material studied, not an installed dependency or a promise about later upstream versions.

- [Feature playbook](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/feature.md): explicit behavior, domain shape, owned work decomposition and matching-surface verification.
- [Refactoring playbook](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/refactoring.md): baseline behavior pin, smaller structural steps, caller migration and equivalence evidence.
- [Bug-fix playbook](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/bug-fix.md): reproduce, distinguish causes, minimal correction, same-surface verification.
- [Investigation playbook](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/investigation.md): read-only explanation grounded in implementation and history.
- [Create verification skill](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/create-verification-skill/SKILL.md): launch/drive/observe/isolate/cleanup, feature map, actual end-to-end proof.
- [Maintain verification skill](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/maintain-verification-skill/SKILL.md): source and live coverage, failure classification, evidence surviving teardown.

The [blast-radius skill](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/blast-radius/SKILL.md) supplies the change-impact method: identify the key safety assumption, trace consumers beyond symbol search, inspect pinned dependencies and patches, and challenge the assumption with actual code. OSStack distinguishes source reasoning, executable checks and application observations; unproved assumptions remain unproved. Real execution stays within existing isolation and authority. No mandatory arena, model panel or unrestricted run is imported.

The code-review method also draws on these fixed sources:

- [Adversarial review workflow](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/interrogate/SKILL.md): intent, bounded review input and synthesis of findings.
- [Review rubric](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/interrogate/references/rubric.md): reachable execution paths, correctness, boundary and verification checks.
- [Lead judgment](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/interrogate/references/lead-judgment.md): evidence-based disposition, false positives and optional improvements.
- [Code-quality lens](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/interrogate/references/code-quality-review.md): concrete structural costs and simplification using the existing architecture.
- [Behavior-test principle](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-test-behavior-not-implementation/SKILL.md): detect broken observable behavior while tolerating equivalent internal changes.

The pinned [opening-a-PR playbook](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/opening-a-pr.md) was inspected for context. Its reset, publication and automatic readiness rules are not imported into the review method. The PR-readiness adaptation below separately uses its reviewer-facing explanation practices.

The four named entry adaptations also consulted these pinned upstream entrypoints:

- [Mode router](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/SKILL.md).
- [Help entry](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-help/SKILL.md).
- [Setup entry](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/setup-pstack/SKILL.md).
- [Delegated agent method](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/agents/poteto-agent.md).

The repository research lock records upstream as MIT licensed at `docs/reports/2026-10-26-pstack/evidence/source-lock.json`. No upstream executable code or substantial verbatim skill text is included here. OSStack-specific boundaries come from this repository's AGENTS rules, current smoke implementation and existing joint contracts.

Adaptation choices: no Cursor-specific model, subagent or slash-command assumptions; no automatic scheduling/publication; one shared body for both hosts; explicitly separate method guidance from authorization, host receipts and qualification. The frozen joint design still governs future method/runtime integration. These materials do not change it.

For feature/refactoring, delegation follows actual authorization and host availability; no fixed model or mandatory arena is imported. Refactoring preserves existing compatibility obligations. The upstream blanket removal of compatibility shims becomes an explicit, scoped migration decision for OSStack consumers. Existing behavior pins cannot be rewritten to hide a feature or bug fix.

For code review, OSStack preserves concrete path analysis and reasoned dispositions. It does not import fixed model defaults, mandatory multi-model spawning, reviewer votes as proof, a file-length blocker or automatic PR publication/readiness rules. Review-only work stays read-only; an existing review-and-fix authorization remains effective. The review method is shared text, not a native review service or a qualification mechanism.

The performance-measurement method draws on the pinned [benchmark checklist](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/benchmark-checklist/SKILL.md) and [number-explanation principle](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-explain-the-number/SKILL.md). It retains comparable tuning/work, correctness and errors, timing scope, alternating samples, limiter diagnosis and end-to-end significance. Host-available diagnostics replace assumed platform commands. Five samples are a diagnostic start, not a statistical guarantee; a single-run ballpark cannot select an option. Synthetic worked examples are teaching data, not OSStack performance results. No automatic optimization, benchmark service or runtime permission is imported.

The task-framing method combines the pinned [restatement skill](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/in-your-own-words/SKILL.md) and [sharpening skill](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/sharpen/SKILL.md). It preserves the goal, asks what a skilled practitioner would examine, identifies original material and specific methods/tools, and defines evidence beyond agreement. User-owned choices stay open. A prompt-only request does not execute the rewritten task; existing refine-and-execute authority does not need repeated approval. The inspected [MIT license](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/LICENSE) names Copyright (c) 2026 Lauren Tan. The new material is independently worded and does not import slash commands, expert identities or tool/model availability claims.

The caller-first architecture method adapts these pinned original sources:

- [Architect](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/architect/SKILL.md).
- [Architect runner guidance](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/architect/references/runner-prompt.md).
- [Design red flags](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/architect/references/design-red-flags.md).
- [Rationale template](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/architect/references/rationale-template.md).
- [Foundational thinking](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-foundational-thinking/SKILL.md).
- [Domain modeling](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-model-the-domain/SKILL.md).
- [Boundary discipline](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-boundary-discipline/SKILL.md).
- [Type discipline](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-type-system-discipline/SKILL.md).
- [Separate shared state](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-separate-before-serializing-shared-state/SKILL.md).
- [Migrate callers](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md).

OSStack retains real caller traces, structurally distinct designs, state ownership and lifecycle reasoning, deep interfaces, migration and evidence-bound checks. It does not import fixed models, mandatory arena/delegation, arbitrary file-count limits or permission to delete working code. Design-only and already-authorized implementation keep their distinct boundaries; sketches and synthetic comparisons are not implemented APIs or actual execution proof. Static internal types do not replace validation at external database, RPC or IPC boundaries.

Additional architecture sources at the same pin:

- [Idempotent operations](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-make-operations-idempotent/SKILL.md).
- [Distinct design alternatives](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-exhaust-the-design-space/SKILL.md).
- [Encode lessons in structure](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-encode-lessons-in-structure/SKILL.md).
- [Redesign from first principles](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-redesign-from-first-principles/SKILL.md).

Upstream restatement, sharpening and architect entries disable automatic model invocation. OSStack adapts them into shared mode selection instead of copying that host-specific setting. Task framing remains for a requested restatement/refinement; architecture follows the requested design or implementation scope. Selection does not itself authorize execution.

The session-continuity method also draws on these original pstack sources at the same pin:

- [Recall](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/recall/SKILL.md): scoped history and shared records, verified current state and a concise resume capsule.
- [Session pickup](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/session-pickup.md): reuse the prior trail, separate finished and pending work, then verify inherited claims against real artifacts.
- [Pause safely](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/pause-safely.md): explicit pause intent, a safe boundary and durable handoff.
- [Guard context](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-guard-the-context-window/SKILL.md): bounded reads and compact context. The idempotent-operations principle linked above informs reconciliation before retry.

Firstmate, whose inspected MIT license names Kun Chen as copyright holder, was separately inspected at original commit `af1c6817fc47589b162cbc361671c43cdb150933`:

- [Captain-hold lifecycle](https://github.com/kunchenguid/firstmate/blob/af1c6817fc47589b162cbc361671c43cdb150933/.agents/skills/captain-hold-lifecycle/SKILL.md): unresolved decisions survive report completion and cleanup, with an authoritative owner and evidence-based reconciliation.
- [Away/quiet supervision](https://github.com/kunchenguid/firstmate/blob/af1c6817fc47589b162cbc361671c43cdb150933/.agents/skills/away-quiet-supervision/SKILL.md): ongoing responsibility, distinct user-return/internal signals and no authority expansion while away.
- [Actual terminal lifecycle implementation](https://github.com/kunchenguid/firstmate/blob/af1c6817fc47589b162cbc361671c43cdb150933/bin/fm-afk-launch.sh#L455-L523): `fm_afk_launch_close_recorded` checks exact backend absence before removing its record; an unconfirmed teardown preserves the identifier. This is source inspection, not a claim that OSStack implements or executed that backend mechanism.
- [Firstmate MIT license](https://github.com/kunchenguid/firstmate/blob/af1c6817fc47589b162cbc361671c43cdb150933/LICENSE): Copyright (c) 2026 Kun Chen.

OSStack independently expresses these ideas without importing Cursor transcript paths, fixed models, mandatory WIP commits, Firstmate commands/turn-end hooks, automatic replay/unlocking, or a new approval policy. Prior user authorization remains effective. Session status, process liveness, unresolved runtime obligations and verified completion remain separate facts. Existing recovery contracts continue to govern actual runtime operations; this shared method neither grants execution qualification nor adds a principal-certification requirement to file work.

The PR-readiness method adapts the pinned [Babysit playbook](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/babysit.md), the opening-a-PR playbook linked above, and [Bugbot triage](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/references/bugbot-triage.md). It retains current candidate/forge observations, dependency and owner awareness, evidence-based finding dispositions, classified CI failures and concise reviewer-facing explanations.

The adaptation uses one read-only snapshot for a status request and preserves existing authorization for local blocker fixes. It does not import the upstream default drive mode, `/loop`, watch-pr/Origin/Graphite availability, fixed retry implementation, mandatory Ready status, unconditional publication or reset/rebase instructions. Required checks are not weakened. An unchanged failing file does not establish a stale base, and repeated review passes do not justify dismissing a real finding. The Bugbot skip-pattern catalog and blanket ask-by-default policy are not imported; risky dismissals need current concrete disproof, while already-authorized fixes continue. Review text never supplies authority; external feedback and publication follow their existing authorization. Readiness remains distinct from human-reserved approval and merge. There is no new watcher, scheduler, merge service or runtime gate.

The parallel-work supporting guide adapts coverage partition from the pinned [Swarm skill](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/swarm/SKILL.md) and [Orchestrate playbook](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/orchestrate.md), with shared-state separation and actual-result verification from the principles linked above. It supports the existing delegated-work entry; the thirteen named methods are unchanged. It adds no scheduler, authenticated reviewer identity, enforced lock, automatic retry or publication authority.

The concise-report guidance adapts the mode router's Writing the reply section, opening-a-PR explanations, Prove It Works and [Sequence verifiable units](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-sequence-verifiable-units/SKILL.md). It separates a short user-facing result from retained detail while preserving candidate bindings, failed observations and remaining owners. No universal word cap or measured host improvement is implied; historical probe failures remain unchanged.
