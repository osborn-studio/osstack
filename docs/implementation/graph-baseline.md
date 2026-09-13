# Graph foundation baseline — G00

2026-09-13. Source HEAD: `b476bcc3fbbfcc11953abd3d154e59f7f85c4660` (`codex/graph-readonly-pilot`). Implementation branch: `codex/graph-runtime-foundation`, separate sibling worktree. Source checkout's modified AGENTS.md and untracked planning documents are preserved; see [source status](graph-foundation-evidence/source-status.txt). Planning documents copied into this worktree; no source code changes at baseline.

Node 26.5.0, pnpm 11.4.0, locked dependencies installed with `--frozen-lockfile`; migration 24. Native SQLite loaded against an in-memory DB; [runtime and ABI](graph-foundation-evidence/native-baseline.json). No production DB opened. This macOS baseline does not establish Node 22/Linux compatibility.

- [Build](graph-foundation-evidence/baseline-build.log): all workspace packages passed.
- [Existing Loop tests](graph-foundation-evidence/baseline-loop.log): 35/35 passed (executor and loop-engine).
- [Startup](graph-foundation-evidence/baseline-startup.log): version median 29 ms / 150 ms budget; help median 78 ms / 500 ms budget, five samples each.
- [Fixture RED](graph-foundation-evidence/g00-red.log), [GREEN](graph-foundation-evidence/g00-green.log): fresh temporary homes, refusal of default/reserved homes and symlink aliases. Run `node scripts/graph-test-env.mjs -- COMMAND ...` to isolate any future CLI/test invocation. The wrapper ignores inherited OSSTACK_HOME and owns cleanup only for its fresh home.
- Existing-file/command inventory for all cards is retained in [verified references](2026-09-13-upgrade-plan-review/verified-existing-references.json). Future files and commands are proposals until their card implements them. Historical research/probe results are not implementation validation.

Baseline limitations: complete test suite, RPC latency and Loop tick overhead were not measured in G00; the existing startup gate and targeted tests above passed. Installation warned that local CLI bin targets were missing before the first build; build resolved them. No observed baseline failure is being hidden as a new regression.

## Execution and product boundaries

Code delivery v1 is `artifact_only`. Single implementation returns `implementation_complete`; G16 later freezes a candidate. No automatic git commit/merge/push/deployment belongs to the new primitive. Existing legacy Loop worktree commit/fast-forward behavior remains legacy behavior, and is disabled for this implementation controller (`useWorktree: false` in an already isolated worktree).

This worktree is the only writable implementation target. OSStack's current compiled engine controls explicit tasks and verification from a separate runtime, with a fresh `/tmp` home and bounded iterations/timeouts. No ambient queue scanning, self-improvement publication, skill publication or deployment. The supervising session reviews results and commits accepted changes locally.

Managed repositories: OSStack release and OStag's GitHub/Vercel integration retain their existing owners. A protected-branch merge or push may trigger a release/deployment and is outside this batch. No OStag or OSBot code/configuration changed; no Rakazo deployment. Future Graph admission must register these real effects before granting release authority.
