# Pinned sources and adaptation

These instructions are independently worded OSStack adaptations of engineering practices in pstack, authored by poteto and distributed in `cursor/plugins`. The source consulted is pinned to commit `99b609a72323b70204eab407c622f436e858e112`, pstack version `0.15.32`. This pin identifies the material studied, not an installed dependency or a promise about later upstream versions.

- [Bug-fix playbook](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/bug-fix.md): reproduce, distinguish causes, minimal correction, same-surface verification.
- [Investigation playbook](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/investigation.md): read-only explanation grounded in implementation and history.
- [Create verification skill](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/create-verification-skill/SKILL.md): launch/drive/observe/isolate/cleanup, feature map, actual end-to-end proof.
- [Maintain verification skill](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/maintain-verification-skill/SKILL.md): source and live coverage, failure classification, evidence surviving teardown.

The four named entry adaptations also consulted these pinned upstream entrypoints:

- [Mode router](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/SKILL.md).
- [Help entry](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-help/SKILL.md).
- [Setup entry](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/setup-pstack/SKILL.md).
- [Delegated agent method](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/agents/poteto-agent.md).

The repository research lock records upstream as MIT licensed at `docs/reports/2026-10-26-pstack/evidence/source-lock.json`. No upstream executable code or substantial verbatim skill text is included here. OSStack-specific boundaries come from this repository's AGENTS rules, current smoke implementation and existing joint contracts.

Adaptation choices: no Cursor-specific model, subagent or slash-command assumptions; no automatic scheduling/publication; one shared body for both hosts; explicitly separate method guidance from authorization, host receipts and qualification. The frozen joint design still governs future method/runtime integration. These materials do not change it.
