# osstack

**A local-first AI software development control plane.**

osstack turns coding agents such as Claude Code, Codex CLI, OpenCode, local
reviewers, and custom tools into a repeatable engineering workflow:

```text
intent / task queue
  -> agent routing policy
  -> loop execution
  -> verification and governance
  -> report, scorecard, proof pack, PR body
  -> lessons and Knowledge Cloud
```

It is not another coding model. It is the layer around coding agents: the
project manager, loop runner, evidence recorder, release checker, and knowledge
surface that makes AI coding work visible and auditable.

**中文说明：[README.zh.md](README.zh.md)**

## Current Status

| Area | Status |
|---|---|
| npm package | Published: `@osstack/cli@0.17.2` |
| GitHub release | npm packages: `@osstack/cli@0.17.2`; latest single binary: [`v0.8.1`](https://github.com/gilosbornhello/osstack/releases/tag/v0.8.1) |
| macOS single binary | Published as explicit `public-ad-hoc` archive for `darwin-arm64` |
| Knowledge Cloud | Live on EdgeOne: `https://osstack-knowledge-cloud-1grycf4k.edgeone.cool` |
| Probe | CLI lifecycle shipped in `@osstack/cli@0.17.2`; report-only is gate behavior, not a background job. The two-week real-use checkpoint remains open. |
| License | MIT |
| Monorepo | 21 workspace packages |

The main release gate currently reports:

```json
{
  "ready": true,
  "completion": {
    "code_verified": true,
    "npm_publish": true,
    "knowledge_cloud_deploy": true,
    "single_binary_release": true
  },
  "external_blockers": []
}
```

## Current Capability Map

The current `main` branch is no longer just a loop runner. It is a local-first
control plane with these shipped surfaces:

| Capability | Current implementation | Main commands / package |
|---|---|---|
| Product entry | One command can turn an intent into a verified local delivery run with reports, scorecards, proof packs, and optional worktree isolation. | `osstack deliver`, `@osstack/cli` |
| Guarded Git autonomy | Classifies R0-R4 before and after the diff, requires external signed approval for R3, permanently blocks R4, and automatically delivers eligible R1/R2 changes through PR, CI, merge, and two-stage proof. | `osstack deliver --autonomy guarded-git`, `osstack autonomy ...`, `@osstack/autonomy` |
| Loop Engineering | Task discovery, execution, verification, iteration, budgets, stop reasons, reports, scorecards, lesson drafts, and daemon-managed loop sessions. | `osstack loop ...`, `@osstack/loop` |
| Portfolio supervision | Repo registry, maturity scan, portfolio report, feedback assets, improvement proposals, evaluator epochs, and machine-actionable recommendations. | `osstack supervise`, `feedback`, `improve`, `evaluator`, `daily`; `@osstack/supervisor` |
| Daily operating brief | Reads the repo registry, summarizes CI/PR/maturity deltas, emits owner decisions, and can run on a 24h daemon schedule. | `osstack daily`, `osstack daily schedule` |
| Contract-gated execution | Creates execution contracts, blocks execution under observe policy, records approvals, and emits the exact follow-up command after approval. | `osstack start`, `osstack control` |
| Policy kernel | Loads `.osstack/repo.yaml` and `.osstack/policy.yaml`, enforces `observe` / `propose` / `execute`, budgets, and approval categories. | `osstack policy check`, `@osstack/core` |
| Agent routing | Routes to adapters such as Claude Code, Codex CLI, OpenCode, Kimi Code review/verify, DeepSeek review/verify, shell subprocesses, and specialized design/research adapters. | `@osstack/agents`, `@osstack/core` |
| Evidence and release trust | Persists run state, events, governance, diffs, proof manifests, PR body drafts, release handoff, and release readiness checks. | `report`, `scorecard`, `proof`, `pr`, `release` |
| Cockpit and dashboard | Local dashboard/TUI snapshots for daemon health, recent runs, kanban, evidence, quality, and next actions. | `osstack cockpit`, `osstack dashboard` |
| Remote gateway hook | Exposes dashboard URLs and transport-agnostic kanban subscriptions/events so a host bot can relay progress to Telegram, Feishu/Lark, Slack, webhooks, or another chat surface. | `dashboard url`, `kanban subscribe`, `kanban events`, `KanbanNotifier` |
| Knowledge Cloud | Official/team/project knowledge packs, cloud sync, local cache fallback, search, publish, audit, feedback, and review UI. | `osstack knowledge`, `@osstack/knowledge-cloud` |
| Four-quadrant elicitation | Persists implementation-changing unknowns, asks one question at a time, renders portable ledgers, evaluates readiness, and feeds reviewed decisions into implementation gates. | `osstack probe ...`, `@osstack/governance`, `@osstack/core`; optional repo-local `probe-skill` |
| Protocol/conformance | Stable cross-process agent command, result, policy, evidence, approval, run, and event schemas with conformance tests. | `@osstack/protocol`, `@osstack/conformance` |

### Remote Gateway Status

osstack has the **control-plane side** of a remote progress gateway, but it does
not currently ship a full Feishu/Lark or Telegram bot server in this repository.

What exists today:

- `osstack dashboard url` returns a local cockpit URL that a chat bot can send
  back to the user.
- `osstack kanban subscribe <card_id> <platform> <chat_id> [thread_id]`
  records a chat subscription. `platform` is intentionally free-form, so it can
  be `telegram`, `feishu`, `lark`, `slack`, or another relay.
- `osstack kanban events --since <id>` exposes incremental card events.
- `KanbanNotifier` in `@osstack/core` formats card progress and advances the
  subscription cursor only after an injected transport reports successful
  delivery.
- The Hermes skill bridge has Telegram-facing commands and can act as the host
  relay when Hermes owns the actual messaging integration.

What does **not** exist in this repo yet:

- a built-in Telegram Bot API process;
- a built-in Feishu/Lark bot webhook or event-subscription service;
- a public cloud tunnel/auth layer for accessing the local cockpit remotely;
- a mobile-first approval UI.

So if you remember a "gateway" being configured, that memory is mostly right:
the osstack-side gateway primitives are present. The missing product slice is
the concrete message transport and remote access wrapper that turns those
primitives into "ask a bot from my phone and see project progress."

## Why osstack Exists

AI coding tools are powerful, but most teams still lack the operational layer
around them:

- Which agent should handle this task?
- Did the result pass real verification?
- Should the system retry, stop, escalate, or open a PR?
- What evidence can a human reviewer trust?
- Which past failures should be remembered next time?
- How do we ship a repeatable release instead of a pile of chat logs?

osstack answers those questions with a local-first control plane:

- **Loop Engineering**: `discover -> execute -> verify -> iterate` until the
  work is done or clearly escalated.
- **Agent routing**: pick adapters by capability, role, cost tier, availability,
  and run history.
- **Evidence layer**: generate Markdown reports, HTML scorecards, checksumed
  proof packs, compliance mappings, and PR bodies.
- **Governance verifier**: deterministic safety and quality checks that can run
  in warning mode or strict mode.
- **Recursive control plane** (opt-in): supervise a portfolio of repos on an
  L0–L6 closed-loop ladder, distill feedback assets from failed runs, raise
  risk-rated improvement proposals under human-in-the-loop gates, and control
  versioned evaluators with anchor-case epochs (Red Queen). See
  [docs/product/14_RECURSIVE_CONTROL_PLANE.md](docs/product/14_RECURSIVE_CONTROL_PLANE.md).
- **Knowledge Cloud**: osstack-native official/team/project knowledge packs with
  cloud sync, local cache fallback, provenance, feedback, and retrieval evals.
- **Cockpit and Kanban**: inspect runs, tasks, evidence, knowledge, and next
  actions from CLI/TUI surfaces.
- **Remote gateway hooks**: expose dashboard URLs, kanban subscriptions, and
  incremental events that external bots can relay to Telegram, Feishu/Lark,
  Slack, or webhooks.
- **Release operations**: npm, EdgeOne Knowledge Cloud, and single-binary release
  readiness are checked by `osstack release doctor/status/plan/handoff`.

## Install

### npm

```bash
npm install -g @osstack/cli
osstack --version
osstack doctor --workspace .
```

Expected:

```text
osstack 0.17.2
```

### macOS Single-Binary Archive

The single-binary channel is cut separately and may lag the npm version; the
latest binary release is `v0.8.1`. Download from GitHub Releases:

- [`osstack-0.8.1-darwin-arm64.tar.gz`](https://github.com/gilosbornhello/osstack/releases/tag/v0.8.1)
- `osstack-0.8.1-darwin-arm64.archive.json`
- `osstack-0.8.1-darwin-arm64.sbom.spdx.json`
- `sha256sums.txt`

Verify after download:

```bash
tar -xzf osstack-0.8.1-darwin-arm64.tar.gz
shasum -a 256 -c sha256sums.txt
./osstack-0.8.1-darwin-arm64 --version
```

The current macOS binary is intentionally marked `public-ad-hoc`: it is ad-hoc
signed, has checksum and SBOM evidence, and is suitable as a portable release
candidate. Apple Developer ID notarization remains supported by the release
workflow via `notarize=true`, but is not required for the default npm path.

### From Source

```bash
git clone https://github.com/gilosbornhello/osstack.git
cd osstack
corepack enable pnpm
pnpm install
pnpm build
pnpm test
node packages/cli/dist/bin.js --version
```

## Five-Minute Quickstart

```bash
# Check the current repository/workspace.
osstack doctor --workspace .

# See runnable workflows.
osstack examples

# Search the live Knowledge Cloud.
osstack knowledge search "proof pack checksum" \
  --cloud-url https://osstack-knowledge-cloud-1grycf4k.edgeone.cool \
  --json

# Run a local readiness check for the loop engine.
osstack loop doctor --workspace . --json

# Inspect the explicit Probe session workflow; Probe does not auto-start.
osstack probe --help

# Audit repository knowledge without writing files.
osstack neat check --fail-on none

# Opt-in, evidence-bound semantic audit (requires an isolated judge provider).
osstack neat semantic --dimensions narrative,contradiction,drift,memory-overlap

# Build a reviewable remediation transaction; writes still require approval.
osstack neat narrative plan --repo . --findings FINDING_FINGERPRINT

# Run one delivery flow in a git worktree and produce evidence.
osstack deliver "Make a small verified change" \
  --verify "pnpm test" \
  --auto-agent \
  --worktree \
  --json
```

`neat` now ships honest V2 coverage, isolated semantic review, recoverable
memory/narrative transactions, and cross-repository obligation tracking as an
**auditable semantic hygiene beta**. The frozen Khazix parity protocol remains
fail-closed until an independent custodian supplies the hidden corpus, pinned
model adapters, and blind quality judgments; current releases do not claim
Khazix semantic parity. See
[`eval/neat-parity/README.md`](eval/neat-parity/README.md) for the evidence gate.

The `deliver` command is the product entry point. It creates a task queue,
executes the loop, verifies the result, and produces evidence artifacts such as:

- `reports/osstack-report-<run_id>.md`
- `release/osstack-scorecard-<run_id>.md`
- `release/osstack-scorecard-<run_id>.html`
- `release/osstack-proof-<run_id>/manifest.json`
- `release/osstack-proof-<run_id>.zip`

## Core Concepts

| Concept | Meaning |
|---|---|
| Control plane | The CLI/daemon layer that coordinates agents, runs, evidence, knowledge, and release operations. |
| Loop | A repeatable cycle: discover work, execute it, verify it, then continue, stop, or escalate. |
| Task | A unit of work from a prompt, queue file, git diff, cockpit action, or daemon request. |
| Adapter | A bridge to a concrete executor or reviewer, such as Codex CLI, Claude CLI, OpenCode, DeepSeek review, or a shell command. |
| Capability | A typed skill such as `code.write`, `code.test`, `code.review`, `design.prd`, `release.proof`, or `research.ml`. |
| Policy | The routing decision layer that selects an agent based on capability, cost, fit, and history. |
| Governance | Deterministic safety/quality checks. It is a verifier, not a model-based judge. |
| Probe | A persistent four-quadrant elicitation session that turns unknowns into reviewable decisions, destinations, and readiness evidence. |
| Proof pack | A checksumed evidence bundle containing reports, state, events, verification results, governance findings, diffs, and manifests. |
| Knowledge pack | An osstack-native knowledge artifact with version, license, source provenance, quality metadata, chunks, and retrieval evaluation. |

## Main Commands

### Product Entry

```bash
osstack doctor --workspace .
osstack examples
osstack guide
osstack deliver "Add billing dashboard" --verify "pnpm test" --auto-agent --worktree --json

# Bounded R1/R2 GitHub delivery. Requires strict repo/policy config and gh auth.
osstack deliver "Add account summary" \
  --profile mac-mini \
  --autonomy guarded-git \
  --expected-path src/account/summary.ts \
  --verify "pnpm test" \
  --json
```

See [Guarded Git Autonomy Runbook](docs/runbooks/guarded-git-autonomy.md) for
the risk matrix, external signed R3 approval, recovery, proof stages, and
rollback to `guarded-local`.

### Governed Resumable Sessions

```bash
osstack session start --request-id task-123 --agent codex-cli --repo "$PWD" \
  --title "Task 123" --text "Report the next safe step" --json
osstack session snapshot <session_id> --json
osstack session send <session_id> --runtime codex-cli --turn <turn_id> \
  --message-id task-123-owner-002 --expected-version <version> \
  --text "Proceed with the approved option" --json
```

The relay persists bounded public state without exposing native provider
session IDs. Replays are locally idempotent; ambiguous crash-window delivery
fails closed instead of automatically resending an instruction. See the
[session relay guide](docs/guides/session-relay.md).

For project-allowlisted staging/production deployment, automatic rollback and
freeze, Mac Mini LaunchAgent operation, named machine/production authority
gates, and the seven-day real-task soak, see the
[Kimi Mac Mini 24x7 Autonomy Runbook](docs/runbooks/kimi-mac-mini-autonomy.md).

### Loop Engineering

```bash
osstack loop enqueue "Fix the failing auth test" --workspace . --capability code.test
osstack loop run --workspace . --source task_queue --verify "pnpm test" --report --scorecard --proof --json
osstack loop run --workspace . --source git_diff --reviewer ds-review --json
osstack loop start --workspace . --source task_queue --verify "pnpm test" --interval-ms 5000
osstack loop status --workspace .
```

### Kimi Code Reviewer (Experimental)

Kimi Code is initially available only as a reviewer and release verifier; it
is not a Builder and does not advertise code-writing or debugging capability.
Install Kimi Code, complete its local login, then check the non-model readiness
probes:

```bash
osstack agent list
osstack config doctor
```

`config doctor` distinguishes `kimi_not_installed`,
`kimi_not_authenticated`, and `kimi_available`. The `OSSTACK_KIMI_BIN`,
`OSSTACK_KIMI_MODEL`, `OSSTACK_KIMI_PROVIDER`, `OSSTACK_KIMI_TIMEOUT_MS`,
`OSSTACK_KIMI_OUTPUT_LIMIT`, and `OSSTACK_KIMI_REVIEW_AGENT_FILE` variables
select binary/model/runtime behavior only. Do not put API keys or login
credentials in osstack configuration or these variables; authentication is
reused from Kimi's own local login.

Only a schema-valid `approved` review can pass the Kimi gate. Deterministic
tests remain authoritative, while malformed output, a non-approved verdict,
secret/forbidden review input, timeout, or any detected reviewer workspace
mutation blocks delivery. Structured review Markdown and JSON are redacted and
checksummed in the proof pack.

The built-in Mac profiles prefer `kimi-code` for the `test-verify` role, with
Claude Code or Codex CLI retaining the Builder role. Public defaults match Mac
hardware model hints and do not embed private hostnames; use `osstack config
bind` for a machine-specific hostname.

Adapter separation is only the baseline independence check. If Claude Code or
Codex is routed through Kimi, record its provider and model honestly in
`agent_runtime`. Configured or inferred identity is useful diagnostics but
cannot prove RISK-R2 provider/model independence; that requires identities
reported by both runtimes.

### Recursive Control Plane (opt-in)

```bash
osstack supervise register . --role business_product --priority 90 --verify "pnpm test"
osstack supervise scan --json          # L0-L6 closed-loop maturity per repo
osstack supervise report --json        # portfolio health (read-only)
osstack supervise init-loop-doc --repo <id>
osstack feedback assets --repo <id> --json
osstack improve propose --repo <id> --json
osstack improve apply --proposal <id>          # DRY RUN by default
osstack improve apply --proposal <id> --yes    # low-risk only, after gates pass
osstack evaluator challenge --repo <id> --incumbent A --challenger B ...   # advisory
osstack evaluator promote  --repo <id> ... --yes   # blocked without anchor cases
osstack loop run --workspace . --self-improvement --repo-id <id> --verify "pnpm test"
```

### Portfolio Daily and Contract Gates

```bash
# Read-only portfolio brief from the machine-level repo registry.
osstack daily --json

# Run the daily brief every 24h through the daemon; restored after daemon restart.
osstack daily schedule --interval-ms 86400000 --schedule "every 24h"
osstack daily sessions --json

# Turn a goal into an execution contract. observe mode refuses execution;
# propose/execute modes create a reviewable contract and approval request.
osstack start "Refactor model run history" --repo-id osborn-model --json

# Inspect, approve, revise, or stop a contract. Approval returns the exact
# follow-up delivery command instead of silently executing it.
osstack control <contract_id> status --json
osstack control <contract_id> approve --actor owner --json
```

### Evidence

```bash
osstack report <run_id> --workspace .
osstack scorecard <run_id> --workspace .
osstack proof <run_id> --workspace . --json
osstack proof view <run_id> --audience engineer
osstack pr <run_id> --dry-run --workspace .
```

### Governance, Contracts, Compliance

```bash
osstack govern check --workspace . --changed --json
osstack loop run --workspace . --govern strict --govern-scope baseline --proof
osstack governance scan src/**/*.ts --json
osstack contracts check --workspace . --manifest api-contracts.json --json
osstack compliance list --json
osstack compliance render <run_id> --pack engineering-readiness --proof-dir release/osstack-proof-<run_id>
```

### Four-Quadrant Elicitation (Probe)

Probe is an explicit, persistent pre-build and mid-build workflow. It does not
create sessions in the background. Start one for each real specification and
link it to the corresponding task so the kanban readiness guard can find it.
Replace the example paths and identifiers before running:

```bash
osstack probe start \
  --input docs/spec.md \
  --task TASK-123 \
  --doc-type tech \
  --depth standard \
  --actor-kind human \
  --actor-id owner \
  --idempotency-key TASK-123-probe-start \
  --json

osstack probe status --repo . --json
osstack probe gate --session <session_id> --json
```

The optional repository policy makes the rollout state visible in review:

```yaml
# .osstack/probe.yaml
schema_version: 1
enforcement: report
```

If `.osstack/probe.yaml` is absent, the built-in policy is already
`enforcement: report`. In both cases, **report-only means that an evaluated
gate reports readiness violations without blocking**. It is not a daemon,
scheduler, or automatic dogfood switch; with no Probe session there is nothing
to evaluate.

The deterministic CLI lifecycle is included in the npm release. The natural
one-question-at-a-time agent experience lives in [`probe-skill/`](probe-skill/)
and is not automatically installed into a Codex/agent skill directory by the
CLI package. Install or link that skill separately before invoking
`$probe-skill`. The two-week report-only dogfood, five real rough-spec runs, and
manual `restate` review remain empirical checkpoints rather than release claims;
see the [Probe v2 design and checkpoint record](docs/2026-07-17-probe-four-quadrant-elicitation-design.md#13-checkpoints发布与回滚).
`--govern-scope baseline` records a full scan of the pre-run Git revision as
non-blocking evidence, then applies the selected `--govern` mode only to
changed-file findings that were not present in that baseline. The changed set
includes working-tree, staged, untracked, and commits created since the run
started, including isolated-worktree merges.

### Knowledge Hygiene

```bash
# Current worktree; report findings without changing the exit status.
osstack neat check --fail-on none

# CI range; fail on warnings or errors and emit a strict JSON envelope.
osstack neat check --base origin/main --head HEAD --json --fail-on warning

# Full repository audit, including non-Git repositories.
osstack neat check --all --fail-on none

# Record and apply explicit review evidence for an exact report diff.
osstack neat review --report /tmp/neat-report.json --finding khf_... \
  --outcome reviewed_no_change --reason "Reviewed" --actor osborn \
  --output /tmp/neat-review.json
osstack neat check --review-file /tmp/neat-review.json --fail-on warning

# Preview first; apply only under an execute/docs auto-apply policy.
osstack neat fix --from /tmp/neat-report.json
osstack neat fix --from /tmp/neat-report.json --apply --yes

# Persist normalized history only when explicitly requested.
osstack neat check --record --json --fail-on none

# Explicit, read-only Claude Code auto-memory audit for one directory.
osstack neat check --all --adapter claude-code \
  --claude-memory-dir "$HOME/.claude/projects/PROJECT/memory"

# Explicit, metadata-only Codex generated-memory audit for one directory.
osstack neat check --all --adapter codex-local \
  --codex-memory-dir "$HOME/.codex/memories"

# Event-derived history (no composite score).
osstack neat trend --repo-id osstack

# Optional non-gating close-out evidence after a successful loop.
osstack loop run --workspace . --source task_queue --neat-finalize --json

# Preview repeated high-confidence findings as stable human-reviewed drafts.
osstack neat propose --db "$OSSTACK_HOME/state.db" --json
# Persist drafts only after explicit confirmation and policy authorization.
osstack neat propose --db "$OSSTACK_HOME/state.db" --yes
```

The optional `.osstack/neat.yaml` declares canonical instruction sources,
required docs, budgets, and change-review contracts. Checks are read-only and
make no semantic prose guesses; `neat review` writes only an explicit portable
artifact, and `neat fix` defaults to a closed safe-patch preview. See the
[neat user and config guide](docs/guides/neat.md).

### Knowledge

```bash
osstack knowledge list --official --json
osstack knowledge search "worktree proof evidence" --official --json
osstack knowledge login --cloud-url https://osstack-knowledge-cloud-1grycf4k.edgeone.cool
osstack knowledge sync --cloud-url https://osstack-knowledge-cloud-1grycf4k.edgeone.cool --json
osstack knowledge search "proof pack checksum" --cloud-url https://osstack-knowledge-cloud-1grycf4k.edgeone.cool --json
osstack knowledge import ./docs --scope team --output ./team-knowledge-pack.json
osstack knowledge publish --pack ./team-knowledge-pack.json --cloud-url <url> --tenant <team>
```

### Cockpit, Kanban, Daemon

```bash
osstack cockpit snapshot --workspace . --json
osstack cockpit tui --workspace .
osstack cockpit next --workspace . --status blocked
osstack dashboard url --workspace .
osstack dashboard snapshot --workspace . --json
osstack kanban board
osstack kanban create "Review release proof" --priority 80 --assignee codex-cli
osstack kanban move <card_id> running
osstack kanban comment <card_id> "Waiting for CI"
osstack kanban subscribe <card_id> telegram <chat_id> [thread_id]
osstack kanban events --since 0
osstack serve
osstack serve --install --profile mac-mini \
  --write-concurrency 2 \
  --read-concurrency 8 \
  --power-policy none
osstack status
```

The daemon is local-first. `osstack serve --install` installs a macOS launchd
service that keeps the daemon alive across restarts. A process-bound
`--power-policy process_assertion` is available only after explicit Owner
machine authorization; OSStack never changes persistent `pmset` settings.
Chat and phone access should be layered through a separate trusted host such as
Hermes, Feishu/Lark bot, Telegram bot, Slack app, webhook relay, or a named
tunnel that can call the dashboard/kanban commands above.

### Release Operations

```bash
osstack release status --target all \
  --cloud-url https://osstack-knowledge-cloud-1grycf4k.edgeone.cool \
  --json

osstack release doctor --target primary \
  --cloud-url https://osstack-knowledge-cloud-1grycf4k.edgeone.cool \
  --json

osstack release plan --target all --json

osstack release handoff \
  --cloud-url https://osstack-knowledge-cloud-1grycf4k.edgeone.cool \
  --output-dir release-handoff \
  --json
```

## Architecture

```text
CLI / cockpit / Hermes skill
        |
daemon RPC / local command path
        |
LoopEngine + task discovery + router
        |
agent adapters / local executor
        |
verifiers / governance / reviewers
        |
state.db + LOOP-STATE.json + reports/proof
        |
Knowledge Cloud / release handoff / GitHub PR evidence
```

Package boundaries:

| Package | Role |
|---|---|
| `@osstack/cli` | CLI, daemon, cockpit, release doctor, proof assembly, product entry. |
| `@osstack/loop` | Loop state, scheduler, discovery, verifier, report model, scorecards. |
| `@osstack/core` | Policy, state, kanban, lessons, telemetry, privacy redaction. |
| `@osstack/agents` | Agent adapters and git worktree isolation. |
| `@osstack/protocol` | Cross-process command/result/event/evidence/approval schemas. |
| `@osstack/governance` | Deterministic scanner for quality and safety findings. |
| `@osstack/contracts` | Frontend/backend contract validation evidence. |
| `@osstack/compliance` | Compliance mapping packs and audience-specific evidence views. |
| `@osstack/knowledge` | Knowledge pack contracts, local search, cache, sync client. |
| `@osstack/knowledge-cloud` | HTTP service for official and tenant knowledge packs. |
| `@osstack/supervisor` | Portfolio maturity, repo registry, feedback assets, proposals, evaluator epochs. |

## Knowledge Cloud

Production URL:

```text
https://osstack-knowledge-cloud-1grycf4k.edgeone.cool
```

Current production health:

```json
{
  "ok": true,
  "service": "osstack-knowledge-cloud",
  "runtime": "edgeone-cloud-functions",
  "publish_storage": "edgeone-blob",
  "storage_binding": "osstack-knowledge-cloud-packs",
  "kv_binding": "missing"
}
```

The cloud service supports:

- official osstack knowledge packs;
- tenant/private knowledge packs;
- `/v1/search`;
- `/v1/sync`;
- `/v1/publish`;
- `/v1/audit`;
- `/v1/feedback`;
- `/review` UI;
- EdgeOne Blob persistence fallback when KV is not configured.

Cloud failure is designed to fail open: the CLI can use local bootstrap packs or
cached packs instead of blocking the loop.

## Evidence and Trust Model

osstack does not ask you to trust a chat transcript. It records evidence:

- loop state and run IDs;
- agent selection and adapter mode;
- verification commands and exit status;
- governance findings;
- reviewer/checker output;
- worktree branch/commit state;
- knowledge pack/chunk trace;
- generated reports and scorecards;
- proof pack manifest with SHA-256 checksums;
- PR body draft.

Compliance packs are internal mappings, not external certifications. osstack can
render evidence for engineering readiness, internal audit, and customer-facing
review, but it does not claim SOC 2, ISO 27001, EU AI Act, or any third-party
certification by itself.

## Local State and Privacy

By default, osstack is local-first:

```text
~/.osstack/
  state.db
  daemon.sock
  daemon.pid
  config.yaml
  loop-sessions.json
  backups/
  logs/
```

Design defaults:

- The daemon listens on a Unix socket.
- State is stored in SQLite.
- osstack does not store model API keys by default.
- The default adapter model is subprocess/login-reuse: subprocess adapters can
  reuse already logged-in CLIs such as Codex CLI or Claude Code.
- SDK/API-key adapters are explicit opt-in paths, intended for controlled
  automation where the operator has chosen to provide credentials.
- Cloud knowledge features can be disabled or allowed to fail open.
- Proof generation redacts common secret patterns.

## Development

```bash
corepack enable pnpm
pnpm install
pnpm lint
pnpm -r build
pnpm test
pnpm smoke:neat
pnpm eval:neat-goldens
pnpm smoke:release-plan
pnpm smoke:knowledge-cloud
pnpm smoke:knowledge-cloud:deploy
pnpm smoke:single-binary-release-pack
pnpm smoke:single-binary-release-publish
```

Useful release checks:

```bash
npm view @osstack/cli version --json
gh release view v0.8.1 --repo gilosbornhello/osstack
curl -fsS https://osstack-knowledge-cloud-1grycf4k.edgeone.cool/healthz
```

## Roadmap

The current product has shipped the main control-plane, evidence, Knowledge
Cloud, npm, single-binary release paths, and the opt-in recursive control plane
(repo supervision, feedback assets, gated improvement proposals, evaluator
epochs, and the loop self-improvement hook). Next priorities:

- richer full-screen cockpit;
- broader official knowledge packs;
- stronger contract validation slices;
- team/tenant knowledge operations;
- more production observability for Knowledge Cloud;
- optional notarized macOS release channel;
- deeper agent scorecard learning.

## License

MIT
