# Local skills-check verification

Status: implementation in progress; candidate audit and host-assisted experiments pending. This is an OSStack application of the extracted create-verification and evidence methods. It turns the PR289 regression into a repeatable positive/negative workflow rather than a one-off transcript.

## Use and coverage

Build the repository using its documented `pnpm install --frozen-lockfile` and `pnpm build` commands. Then run `node scripts/smoke-skills-check.mjs --doctor`. The repeatable repository command is `pnpm smoke:skills-check`; CI runs this command after build and ordinary tests. Preflight does not run the product and cannot certify behavior. Run `node scripts/smoke-skills-check.mjs --case all` for the five-case local fixture, or choose one case. An explicit `--evidence-dir` must name a new directory under an existing parent. The script never installs dependencies or repairs configuration.

| Feature | Preconditions and action | Expected product outcome | Failure and ownership |
| --- | --- | --- | --- |
| Healthy source | Owned local Git origin, current blessed SHA; check | Exit 0, up-to-date | Driver owner retains mismatch evidence |
| Missing ref | Same available origin, absent tracked ref; check | Exit 1, one failed source | Keep missing ref missing; passed negative verification does not mean source recovered |
| Drift | Existing ref, older blessed SHA; check | Exit 2, one drift | Keep old blessed SHA; never bless to make the test pass |
| Mixed status | Healthy, absent and drifted sources together | Exit 1, both failed and drift counts | Failure precedence and counts are independently checked |
| Empty manifest | No configured sources | Exit 0, zero counts | Empty input is not source coverage |

Each row requires unchanged input bytes, retained raw stdout/stderr and exit, separately bound source/build files, and owned cleanup. The driver exit and inner product exit are distinct: a correct missing-ref outcome can produce product exit 1 and driver exit 0. A timeout or uncertain child lifecycle must not be reported as clean teardown.

Evidence survives separately from the disposable fixture. Start with the small receipt and evidence manifest; read only the bindings/raw records needed to substantiate a claim. Preserve an original failed attempt when fixing the harness. Revalidate changed predicates and report the new candidate binding rather than relabeling old logs.

## Limits and maintenance

This verifies local file-backed Git sources with isolated configuration. It does not cover network transport, authentication, live providers, arbitrary user repositories, daemon recovery, autonomous host tool use or formal J01/J11 qualification. Codex and Claude host-assisted trials are separately recorded after execution; neither is passed by this document.

When CLI output, source semantics or supported runtime changes, the maintainer should rerun the affected fixed cases, compare original raw failures, update the explicit expectation only when intended product semantics changed, and re-audit the driver. No scheduled execution is enabled by this file.

See [the bounded specification](spec.md) for the interface and evidence contract. Test and audit records will be appended with exact candidate bindings when available.
