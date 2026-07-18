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
| npm package | Published: `@osstack/cli@0.11.0` |
| GitHub release | npm packages: `@osstack/cli@0.11.0`; latest single binary: [`v0.8.1`](https://github.com/gilosbornhello/osstack/releases/tag/v0.8.1) |
| macOS single binary | Published as explicit `public-ad-hoc` archive for `darwin-arm64` |
| Knowledge Cloud | Live on EdgeOne: `https://osstack-knowledge-cloud-1grycf4k.edgeone.cool` |
| License | MIT |
| Monorepo | 16 packages |

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
osstack 0.11.0
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

# Audit repository knowledge without writing files.
osstack neat check --fail-on none

# Run one delivery flow in a git worktree and produce evidence.
osstack deliver "Make a small verified change" \
  --verify "pnpm test" \
  --auto-agent \
  --worktree \
  --json
```

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
| Proof pack | A checksumed evidence bundle containing reports, state, events, verification results, governance findings, diffs, and manifests. |
| Knowledge pack | An osstack-native knowledge artifact with version, license, source provenance, quality metadata, chunks, and retrieval evaluation. |

## Main Commands

### Product Entry

```bash
osstack doctor --workspace .
osstack examples
osstack guide
osstack deliver "Add billing dashboard" --verify "pnpm test" --auto-agent --worktree --json
```

### Loop Engineering

```bash
osstack loop enqueue "Fix the failing auth test" --workspace . --capability code.test
osstack loop run --workspace . --source task_queue --verify "pnpm test" --report --scorecard --proof --json
osstack loop run --workspace . --source git_diff --reviewer ds-review --json
osstack loop start --workspace . --source task_queue --verify "pnpm test" --interval-ms 5000
osstack loop status --workspace .
```

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
osstack governance scan src/**/*.ts --json
osstack contracts check --workspace . --manifest api-contracts.json --json
osstack compliance list --json
osstack compliance render <run_id> --pack engineering-readiness --proof-dir release/osstack-proof-<run_id>
```

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
osstack kanban board
osstack kanban create "Review release proof" --priority 80 --assignee codex-cli
osstack serve
osstack serve --install
osstack status
```

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
| `@osstack/governance` | Deterministic scanner for quality and safety findings. |
| `@osstack/contracts` | Frontend/backend contract validation evidence. |
| `@osstack/compliance` | Compliance mapping packs and audience-specific evidence views. |
| `@osstack/knowledge` | Knowledge pack contracts, local search, cache, sync client. |
| `@osstack/knowledge-cloud` | HTTP service for official and tenant knowledge packs. |

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
