# Maintain bilingual documentation with osstack neat

[中文](documentation-maintenance.md) · [Documentation index](../README.md)

`neat` checks repository knowledge surfaces. It does not translate documents or generate a complete README. Use its findings with source, installed CLI help and release evidence. Do not treat exit code 0 alone as proof that every statement is current.

## 1. Establish the baseline

Use the installed CLI. A source checkout must use a private `OSSTACK_HOME`, as described in the [installation guide](install-upgrade.en.md). Run from the repository root. Store reports outside the checkout:

```sh
export OSSTACK_SCRATCH_ROOT="${OSSTACK_SCRATCH_ROOT:-${TMPDIR:-/tmp}/osstack}"
mkdir -p "$OSSTACK_SCRATCH_ROOT/runtime"
DOC_REPORT_DIR="$(mktemp -d "$OSSTACK_SCRATCH_ROOT/runtime/docs-audit-XXXXXX")"
osstack neat check --repo . --all --json --fail-on error > "$DOC_REPORT_DIR/before.json"
```

Read `result.report.completeness`, `summary` and `findings`. Inspect suppressed findings too. A complete deterministic check covers recognized surfaces, references and configured contracts. It does not validate external services, translate content or certify a production deployment.

## 2. Update both languages

Update the English and Chinese files in the same change. Use the [documentation index](../README.md) to find each pair. Keep these facts aligned:

- Published version, source revision and verification date.
- Command names, flags, placeholders and expected output.
- Preconditions, authorization requirements and read/write effects.
- Unverified integrations and recovery limits.

Use short sentences and direct verbs. State the condition before the action. Give one main action per instruction. Keep identifiers unchanged. These principles are inspired by ASD-STE100; they are not a claim of formal standard compliance. Follow the [prompt language policy](prompt-language.md).

Keep dated audit inputs and old reports as historical evidence. Update current guides instead of rewriting old conclusions. Generated inventories must be refreshed with their generator, not translated or edited by hand.

## 3. Check the result

```sh
osstack neat check --repo . --all --json --fail-on error > "$DOC_REPORT_DIR/after.json"
osstack neat check --repo . --base HEAD --json --fail-on warning > "$DOC_REPORT_DIR/changes.json"
git diff --check
```

`--base HEAD` includes current worktree edits. After committing, use `--base origin/main --head HEAD` to check the branch range. Run both scopes: a clean full scan does not replace the change-contract check.

To preview supported repairs, first create the V1 input that `neat fix` accepts:

```sh
osstack neat check --repo . --base HEAD --schema-version 1 --json > "$DOC_REPORT_DIR/fix-input.json"
osstack neat fix --from "$DOC_REPORT_DIR/fix-input.json" --json
```

V1 is deprecated. Use it only for the current fix input contract; use V2 for normal check reports. This is a preview. Review a proposed patch before applying it under repository policy. The default V2 check report is not a compatible fix input. Paid semantic audits and automatic application are separate, explicit operations.

Before opening the PR, verify relative links, compare command examples in both languages, and check commands against CLI help. Record the neat summary and any remaining limitations in the PR.
