---
"@osstack/loop": minor
"@osstack/cli": minor
"@osstack/agents": minor
---

Loop Engineering upgrade (Increments A–E): first-class evaluation specs with
per-spec verifier results (`--verify` and artifact gates become implicit
specs), feedback-carrying iteration with no-progress escalation, discovery
governance (`--discovery-policy`), budget/stop controls
(`--max-runtime-ms`/`--max-tokens`/`--max-cost-usd`/`--no-progress-limit`,
exit code 2 on budget), and SOP lesson drafts with an
`osstack loop lessons list|show|promote|discard` review workflow. DeepSeek
ds-review/ds-verify now judge evaluation specs per-spec via
`OSSTACK_EVALUATION_SPECS_FILE`/`OSSTACK_EVALUATIONS`. All additive and
opt-in; existing CLI behavior is unchanged.
