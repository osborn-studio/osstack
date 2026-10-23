# Real provider transport pilot for once-authorized PR delivery

## Delivered diagnostic

`pnpm smoke:improvement-providers` launches an explicit live Codex Builder / Kimi Evaluator experiment against a newly generated synthetic documentation repository. It uses the production adapters, profile resolver, candidate executor, verifier, patch reconstruction and delivery ledger. GitHub API/push are replaced by a strict local fixture and bare Git repository. **No GitHub PR is created by the pilot.** This diagnostic and its report are being submitted through a normal development PR separately.

The command can incur provider charges. It permits one adapter invocation per role, 120 seconds per stage, no automatic retries, and no dollar-cap claim. It requires installed/authenticated `codex` and `kimi`; binary overrides are rejected. The launcher sets a fresh OSSTACK_HOME and the smoke creates its own disposable control DB; it never opens production state. Native CLIs still load their normal account configuration. This is not OS isolation or proof that unrelated account context was excluded.

The live test is skipped by the ordinary suite/CI unless explicitly enabled. Build workspace packages first (`pnpm build`), then run the command. The printed `osstack-provider-live-*` directory retains `pilot.json`, model evidence, patch and control DB for inspection, including failures. Preserve needed evidence before removing that generated directory. The empty launcher home is removed after either success or failure. The failure exit code propagates. The launcher and live fixture clear an inherited `OSSTACK_SOCKET` override while using their isolated home. A resource scope closes the database and restores prior home/socket values even if setup, execution, or evidence persistence throws; combined failures retain the primary error. Artifact directories remain available for diagnosis.

## What success means

1. A real Codex invocation modifies only `docs/guide.md` in the separate candidate worktree; a native thread receipt and positive completion output tokens are observed.
2. The deterministic gate checks the exact intended bytes, including heading and final newline. An actual Kimi invocation produces a valid structured approved review; its runtime identity is recorded. The adapter enforces the bundled no-tool profile, and the smoke rejects observed tool events. It does not independently attest to silent CLI internals.
3. The saved patch is reconstructed using fresh Git objects/worktree and passes the same gate before simulated delivery. The source repository HEAD and working tree remain unchanged.
4. Replaying the execution returns history. Counters at adapter entry and the simulated delivery transport do not increase. These are application boundary counters, not a network monitor or proof of zero host-wide traffic.
5. Results clearly distinguish `providers: live` from `github_pr_created: false`. Model-reported/configured identity is not relabeled as a provider response ID. Unknown usage, response IDs, actual provider model IDs and cost remain null.

An approved review is necessary for this pipeline's delivery outcome. A valid rejection would be retained as a failed delivery with structured transport evidence, not retried until it becomes approval. A transport observation alone is not sufficient to pass the pipeline smoke.

## Recorded experiments

[Sanitized evidence](2026-09-09-improvement-provider-pilot-evidence.json) contains both manual experiments. They used revised smoke definitions and are **not statistical replicates or a reliability benchmark**.

| Experiment | Definition | Result | Calls | Test elapsed |
|---|---|---|---|---|
| 1 | Production adapters, content gate, reconstruction, replay | Passed | Codex 1 / Kimi 1 | 51.22 s |
| 2 | Exact-byte gate, native Codex evidence, structured review, replay transport counter | Passed | Codex 1 / Kimi 1 | 43.56 s |

Both experiments retained the original source and produced exactly one simulated push/PR operation pair. There were two manually initiated experiments, four adapter invocations in total, and no automatic retries. The second run reported Codex adapter usage of 10,397 input / 362 output tokens; the adapter's input figure excludes cached input. Kimi usage and total dollar cost were not available. CLI/native receipts rely on the installed executable and local PATH being trustworthy, not cryptographic provider attestation.

## Unknowns discovered and next development

- **Codex model binding is incomplete.** The production profile reports its provider/model as `unknown`, with `evidence_source: inferred`. A native thread proves a Codex run occurred but does not establish which configured model/provider executed it. Kimi reports CLI model `kimi-code/k3` and version `0.29.1`; that is CLI identity evidence, not an independent provider reply identity. Do not use this pilot as proof that model identity was frozen in the authorization.
- **Real GitHub remains untested here.** Next pilot must explicitly choose the target repository and approved data boundary, bind current base/permissions and record the actual draft PR. Never replace the simulated URL with a claim of real delivery.
- **Worker isolation remains incomplete.** Process supervision, credential separation and authenticated evidence precede daemon autonomy claims. This smoke does not measure self-improvement, long-running reliability, cross-restart recovery, rate limits or concurrency.

Next slice: explicit Codex model/provider binding with drift detection, followed by a bounded real-GitHub trial and worker isolation. The successful adapter transport experiment removes one uncertainty; it does not complete checkpoint A/M2 or justify auto merge/release.

## Validation

- Two explicit real-provider experiments passed, as above.
- Build, TypeScript checks and lint passed (two existing lint warnings).
- Full ordinary suite: 291 files / 2,584 tests passed; two explicit live/network tests skipped by default.
- Inventory freshness, changeset coverage self-test and launcher syntax passed.
- Launcher verified with a local fake pnpm: exact arguments, opt-in flag, fresh home, home cleanup and both zero/nonzero exit propagation; no extra paid calls for this wrapper check.
- CLI startup: version median 30 ms; full help 83 ms, below 150/500 ms local budgets.

Claude Fable 5.1 actually challenged the generic design twice. [Prompts, responses and decisions](2026-09-09-provider-pilot-fable-review.md) distinguish model reasoning from measured results. No repository code/configuration was exported to that reviewer.


## Pre-approval revision

[Repair and offline failure-injection evidence](2026-09-09-pr223-revision.md) covers resource cleanup, adapter transparency and the real launcher process. These repairs did not initiate more paid provider runs; the two earlier experiments remain historical observations of the earlier smoke definition.
