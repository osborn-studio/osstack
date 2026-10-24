# Firstmate bilingual README and neat evidence

Checked on 2026-10-25, Asia/Shanghai. This is document hygiene evidence, not a release or live-environment qualification certificate.

Updated `README.md` and `README.zh.md`, added parallel English/Chinese command guides, and registered both READMEs and both guides as required surfaces in `.osstack/neat.yaml`. The guide maps all 24 capability identifiers to the relevant command families, preserving the distinction between reused mechanisms and new functionality. Source package version is 0.21.0; no registry publication was inferred from that version. Independent npm and GitHub queries confirmed CLI 0.21.0 and the separate v0.8.1 binary channel; `release-facts.mjs --remote --json` checks that evidence against the READMEs. These existing releases do not include this unmerged PR merely because the package version matches.

Actual checks used a dedicated scratch `OSSTACK_HOME`, with update checks disabled:

- `osstack neat check --repo <checkout> --all --json`: before editing, complete, 0 errors / 0 warnings / 0 info, 23 existing configured suppressions.
- `osstack neat check --repo <checkout> --all --json --fail-on error`: after editing and required-surface configuration, complete, 0 errors / 0 warnings / 0 info, the same 23 suppressions.
- `osstack neat check --repo <checkout> --base HEAD --schema-version 1 --json` followed by `osstack neat fix --from <report> --json`: successful preview, no patch actions. No automatic content edit or semantic model invocation was performed by neat.
- Actual umbrella help calls for attention, scout, sources, worker, remote-home, follow-up-delivery and homes returned exit 0. Command-specific help and source dispatch additionally establish subcommands omitted from umbrella help. `worker watch --help` and `cockpit --help` are not supported help forms; the docs do not recommend those forms.

The first fix-preview attempts were rejected because default V2 reports are not accepted by the current V1 fix consumer, and an all-surface report lacks the required `diff_id`. They were not counted as successful previews. The guides now show the compatible diff-report sequence and explicitly label V1 compatibility; V1 itself is deprecated.

Neat checks links, configured documentation contracts and instruction surfaces. It does not translate or author arbitrary README content, prove CLI behavior, or execute the external qualification matrix. Content was authored from source/help and independently reviewed with Claude Code; implementation audit and CI are tracked separately in the final PR report.

[中文命令手册](../guides/firstmate-commands.md) · [English command guide](../guides/firstmate-commands.en.md)
