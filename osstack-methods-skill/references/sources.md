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

The pinned [opening-a-PR playbook](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/opening-a-pr.md) was inspected for context. Its reset, publication and automatic readiness rules are not imported into the review method.

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
