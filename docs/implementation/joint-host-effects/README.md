# Codex and Claude: observed method use

Two actual, bounded CLI investigations used method files from PR288 `10629495aafe7b3aca0de4c920bcaec40b083d7b` and historical skills-check RED/GREEN evidence. Both executions were read-only; neither reran product tests or drove a live provider. Inputs and expected judgments were recorded before invocation. The prompts and evidence subsets differ, so this is not a controlled head-to-head comparison.

| Host | Actual observation | Limit or correction |
| --- | --- | --- |
| Codex CLI 0.160.1 | One call, exit 0, five read-only shell commands; correctly identified discarded failure entries and why exit 0→1 fixes the CLI while the missing ref remains missing | Default model not overridden; resolved model not attested. Read a 2,335-entry build binding list, producing 198,949 input tokens including 163,072 cached tokens across the call. This is not an efficiency success |
| Claude CLI, actual modelUsage `claude-sonnet-5-5` | One call, exit 0, 28 Read calls and one Glob; correctly diagnosed the bug and proposed failure/drift/healthy exit criteria | Incorrectly said the input manifest was not supplied: it was supplied but unread. Also overstated two recorded source hashes as evidence that only one file changed across the entire run |

The original responses remain in [the archive](evidence.tar.gz), alongside prompts, input manifests, tool transcripts, CLI versions, frozen expectations and explicit evaluations. [The publication manifest](evidence-manifest.json) hashes each archived file and identifies the narrow machine-path redaction; original unredacted bytes remain in external scratch. Codex's `assessment.json` and Claude's `evaluation.json` record limitations separately from the raw reports. Neither model is an authenticated independent oracle.

## Changes driven by these observations

The common evidence instructions now start with an index/manifest/summary and targeted fields, while retaining the original paths and hashes. A projection cannot stand in for verification of omitted data. The instructions also distinguish absent, supplied-but-unread, read-but-unverified, and verified-against-a-predicate evidence. A missing-evidence assertion must first check the input inventory and named path; read failure remains a separate observation.

These wording changes have not yet been tested in another live host run. We have observed useful investigation behavior, with errors and overhead preserved; we have not demonstrated that these methods caused an improvement. No no-material control, automatic discovery, installation, implementation journey, behavioral equivalence, MethodBinding, runtime activation or formal J gate pass is claimed.

## Next bounded experiment

After the current PRs settle, freeze a small new bug fixture and a concise evidence index, then let each host select a bounded verification action. A host-controlled action record and resulting raw observation are needed before claiming execution support. Keep each host's commands and private resources separate, use the same behavior predicate, include a positive control, and retain failed attempts. A no-method control is required before making a causal value claim. This is a queued experiment, not a completed capability.
