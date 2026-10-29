# Preserve legacy GitHub status outcomes in stack ingestion

At main6c9a3e8f, the existing stack mapper parsed CheckRun conclusion/status but discarded StatusContext.state. Offline reproduction using the real compiled mapper and an injected forge runner showed SUCCESS, FAILURE and ERROR all mapped to pending. This is a current parser defect, separate from the new bounded snapshot tool. No live forge or DB write was used to reproduce it; downstream card storage effects are source inference, not a demonstrated DB incident.

The scoped repair is limited to stack.ts and its behavior tests, with root-owned release metadata and evidence. Preserve existing neutral/skipped CheckRun policy, failure precedence and graph topology; unrecognized StatusContext values must not become green. The independent criteria and36 vectors were frozen before author implementation. Original RED and same-path GREEN, production/source hashes, independent observations and actual Sonnet5.5 review will be bound to exact commits.

This contributes to PS18, supports PS17/J07, and uses J20 only as design context. It does not add a watcher, auto-approval, runtime activation or named method. Whole capabilities and formal milestones remain incomplete.

Upstream inspiration: pstack99b609a72323b70204eab407c622f436e858e112 watch-pr/github.ts distinguishes CheckRun and StatusContext; its local policy is not copied wholesale. pstack is by Lauren Tan under MIT, and OSStack retains attribution. Original source snapshots are retained with the independent freeze.
