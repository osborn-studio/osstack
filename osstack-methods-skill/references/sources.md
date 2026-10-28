# Pinned sources and adaptation

These instructions are independently worded OSStack adaptations of engineering practices in pstack, authored by poteto and distributed in `cursor/plugins`. The source consulted is pinned to commit `99b609a72323b70204eab407c622f436e858e112`, pstack version `0.15.32`. This pin identifies the material studied, not an installed dependency or a promise about later upstream versions.

- [Feature playbook](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/feature.md): explicit behavior, domain shape, owned work decomposition and matching-surface verification.
- [Refactoring playbook](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/refactoring.md): baseline behavior pin, smaller structural steps, caller migration and equivalence evidence.
- [Bug-fix playbook](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/bug-fix.md): reproduce, distinguish causes, minimal correction, same-surface verification.
- [Investigation playbook](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/investigation.md): read-only explanation grounded in implementation and history.
- [Create verification skill](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/create-verification-skill/SKILL.md): launch/drive/observe/isolate/cleanup, feature map, actual end-to-end proof.
- [Maintain verification skill](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/maintain-verification-skill/SKILL.md): source and live coverage, failure classification, evidence surviving teardown.

The code-review method also draws on these fixed sources:

- [Adversarial review workflow](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/interrogate/SKILL.md): intent, bounded review input and synthesis of findings.
- [Review rubric](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/interrogate/references/rubric.md): reachable execution paths, correctness, boundary and verification checks.
- [Lead judgment](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/interrogate/references/lead-judgment.md): evidence-based disposition, false positives and optional improvements.
- [Code-quality lens](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/interrogate/references/code-quality-review.md): concrete structural costs and simplification using the existing architecture.
- [Behavior-test principle](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-test-behavior-not-implementation/SKILL.md): detect broken observable behavior while tolerating equivalent internal changes.

The four named entry adaptations also consulted these pinned upstream entrypoints:

- [Mode router](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/SKILL.md).
- [Help entry](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-help/SKILL.md).
- [Setup entry](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/setup-pstack/SKILL.md).
- [Delegated agent method](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/agents/poteto-agent.md).

The repository research lock records upstream as MIT licensed at `docs/reports/2026-10-26-pstack/evidence/source-lock.json`. No upstream executable code or substantial verbatim skill text is included here. OSStack-specific boundaries come from this repository's AGENTS rules, current smoke implementation and existing joint contracts.

Adaptation choices: no Cursor-specific model, subagent or slash-command assumptions; no automatic scheduling/publication; one shared body for both hosts; explicitly separate method guidance from authorization, host receipts and qualification. The frozen joint design still governs future method/runtime integration. These materials do not change it.

For feature/refactoring, delegation follows actual authorization and host availability; no fixed model or mandatory arena is imported. Refactoring preserves existing compatibility obligations. The upstream blanket removal of compatibility shims becomes an explicit, scoped migration decision for OSStack consumers. Existing behavior pins cannot be rewritten to hide a feature or bug fix.

For code review, OSStack preserves concrete path analysis and reasoned dispositions. It does not import fixed model defaults, mandatory multi-model spawning, reviewer votes as proof, a file-length blocker or automatic PR publication/readiness rules. Review-only work stays read-only; an existing review-and-fix authorization remains effective. The review method is shared text, not a native review service or a qualification mechanism.
