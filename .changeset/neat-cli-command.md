---
"@osstack/cli": minor
---

Add the read-only `osstack neat` / `osstack neat check` command with strict
config and argument validation, deterministic human output, strict Agent
Command Protocol JSON, configurable finding exit thresholds, portable and
atomic `neat review` artifact authoring, a hermetic close-out smoke, and
matching `--review-file` application whose exit policy considers unresolved
findings only, plus local/CI/full-audit user documentation.
Add preview-first `neat fix`; apply requires `--apply --yes`, a complete report,
matching config hash, and execute/auto-apply/docs policy. Emit strict conflict
and before/after hash evidence without replacing existing targets.
