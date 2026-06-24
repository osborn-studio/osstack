# osstack

**本地优先的 AI 软件开发控制平面。**

osstack 的目标不是再做一个编码模型，而是把 Claude Code、Codex CLI、OpenCode、本地评审器、
DeepSeek 检查器以及你自己的脚本，组织成一套可路由、可循环、可验证、可审计、可发布的工程系统。

它负责 AI 编码工作周围那些最容易被忽略、但真正决定工程质量的事情：

```text
需求 / 任务队列
  -> Agent 路由策略
  -> 循环执行
  -> 测试验证与治理检查
  -> 报告、分数卡、证据包、PR body
  -> 经验沉淀与 Knowledge Cloud
```

**English: [README.md](README.md)**

## 当前状态

| 领域 | 状态 |
|---|---|
| npm 包 | 已发布：`@osstack/cli@0.8.1` |
| GitHub Release | 已发布：[`v0.8.1`](https://github.com/gilosbornhello/osstack/releases/tag/v0.8.1) |
| macOS 单文件二进制 | 已发布 `darwin-arm64` 的显式 `public-ad-hoc` archive |
| Knowledge Cloud | 已部署到 EdgeOne：`https://osstack-knowledge-cloud-1grycf4k.edgeone.cool` |
| License | MIT |
| Monorepo | 16 个 package |

当前主发布验收状态：

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

## 为什么需要 osstack

AI 编码工具越来越强，但很多团队仍然缺一层“工程控制面”：

- 这个任务应该交给哪个 Agent？
- Agent 改完之后有没有真的跑过测试？
- 失败时应该重试、停止、升级，还是交给另一个 Agent？
- 交付给人类 reviewer 的证据是什么？
- 下一次遇到相似失败时，系统能不能记住经验？
- 发布 npm、部署 Knowledge Cloud、上传单文件 release 时，哪些 gate 必须过？

osstack 把这些问题变成一套本地优先、可自动化验证的工程流程：

- **Loop Engineering（循环工程）**：按 `发现 -> 执行 -> 验证 -> 迭代` 的方式持续推进任务，直到通过或明确升级。
- **Agent 路由**：基于 capability、role、cost、可用性和历史成功率选择合适的适配器。
- **证据层**：生成 Markdown report、HTML scorecard、checksum proof pack、合规映射和 GitHub PR body。
- **治理检查**：不用模型裁判，而是用确定性规则扫描 secret、危险 shell、前端低质模式、TypeScript 质量问题等。
- **Knowledge Cloud**：osstack 自有知识包体系，支持官方/团队/项目知识、云端 sync、本地 cache、provenance、feedback 和 retrieval eval。
- **Cockpit + Kanban**：从 CLI/TUI 查看 run、task、证据、知识和下一步行动。
- **Release 操作系统**：通过 `release doctor/status/plan/handoff` 检查 npm、EdgeOne Knowledge Cloud、GitHub Release 和单文件二进制发布状态。

一句话：

> osstack 是 AI 编码团队的本地操作系统：派活、循环、验证、隔离、记录证据、沉淀知识，并把工作变成可交付结果。

## 安装

### 通过 npm 安装

```bash
npm install -g @osstack/cli
osstack --version
osstack doctor --workspace .
```

期望输出：

```text
osstack 0.8.1
```

### 使用 macOS 单文件 archive

从 GitHub Releases 下载：

- [`osstack-0.8.1-darwin-arm64.tar.gz`](https://github.com/gilosbornhello/osstack/releases/tag/v0.8.1)
- `osstack-0.8.1-darwin-arm64.archive.json`
- `osstack-0.8.1-darwin-arm64.sbom.spdx.json`
- `sha256sums.txt`

下载后验证：

```bash
tar -xzf osstack-0.8.1-darwin-arm64.tar.gz
shasum -a 256 -c sha256sums.txt
./osstack-0.8.1-darwin-arm64 --version
```

当前 macOS 单文件版本被明确标记为 `public-ad-hoc`：它已经 ad-hoc 签名，带 checksum、
SBOM 和 archive manifest，可作为便携 release candidate 使用。Apple Developer ID notarization
仍然由 release workflow 支持，只需要在触发 workflow 时设置 `notarize=true`，但默认 npm 安装路径不依赖 Apple 公证。

### 从源码安装

```bash
git clone https://github.com/gilosbornhello/osstack.git
cd osstack
corepack enable pnpm
pnpm install
pnpm build
pnpm test
node packages/cli/dist/bin.js --version
```

## 5 分钟快速上手

```bash
# 1. 检查当前 repo / workspace 是否适合运行 osstack。
osstack doctor --workspace .

# 2. 查看可直接运行的示例。
osstack examples

# 3. 搜索线上 Knowledge Cloud。
osstack knowledge search "proof pack checksum" \
  --cloud-url https://osstack-knowledge-cloud-1grycf4k.edgeone.cool \
  --json

# 4. 检查 Loop Engineering runtime 是否可用。
osstack loop doctor --workspace . --json

# 5. 运行一次带 worktree 隔离和证据输出的交付流程。
osstack deliver "Make a small verified change" \
  --verify "pnpm test" \
  --auto-agent \
  --worktree \
  --json
```

`deliver` 是推荐的新用户入口。它会创建任务队列、执行 loop、运行验证，并生成证据产物，例如：

- `reports/osstack-report-<run_id>.md`
- `release/osstack-scorecard-<run_id>.md`
- `release/osstack-scorecard-<run_id>.html`
- `release/osstack-proof-<run_id>/manifest.json`
- `release/osstack-proof-<run_id>.zip`

## 核心概念

| 概念 | 说明 |
|---|---|
| Control plane（控制平面） | CLI/daemon 层，负责协调 Agent、run、证据、知识库和发布操作。 |
| Loop（循环） | 重复执行“发现工作、执行、验证、继续/停止/升级”的工程周期。 |
| Task（任务） | 来自 prompt、队列文件、git diff、cockpit action 或 daemon request 的工作单元。 |
| Adapter（适配器） | 接入具体执行器或评审器的桥，例如 Codex CLI、Claude CLI、OpenCode、DeepSeek review 或 shell 命令。 |
| Capability（能力） | 类型化技能，例如 `code.write`、`code.test`、`code.review`、`design.prd`、`release.proof`、`research.ml`。 |
| Policy（策略） | 根据能力、成本、匹配度和历史表现选择 Agent 的决策层。 |
| Governance（治理） | 确定性的安全/质量检查，不是模型裁判。 |
| Proof pack（证据包） | 带 SHA-256 checksum 的证据集合，包含 report、state、events、verify、governance、diff、manifest 等。 |
| Knowledge pack（知识包） | osstack 原生知识资产，包含 version、license、source provenance、quality metadata、chunks 和 retrieval eval。 |

## 主要命令

### 产品入口

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

Loop 的基本生命周期是：

```text
discover -> execute -> verify -> iterate
```

可选能力：

- `--worktree`：每个任务在隔离 git worktree 中运行，失败尝试不污染主工作区。
- `--knowledge off|local|cloud`：控制知识注入模式。
- `--govern warn|strict`：运行治理检查；默认可作为 warning，strict 下 high severity 可阻断。
- `--report --scorecard --proof`：把运行结果转成可阅读、可审计的交付物。
- `--goal "<cmd>"`：直到某个命令通过才停止。
- `--max-iter <n>`：失败 N 次后升级，避免无限循环。

### 证据与 PR

```bash
osstack report <run_id> --workspace .
osstack scorecard <run_id> --workspace .
osstack proof <run_id> --workspace . --json
osstack proof view <run_id> --audience engineer
osstack pr <run_id> --dry-run --workspace .
```

证据包通常包含：

- `manifest.json`
- `report.md`
- `scorecard.html`
- `loop-state.json`
- `events.jsonl`
- `policy-decision.json`
- `verify-results.json`
- `governance-results.json`
- `knowledge-trace.json`
- `git-diff.patch`
- `sha256sums.txt`

### 治理、契约与合规映射

```bash
osstack govern check --workspace . --changed --json
osstack governance scan src/**/*.ts --json
osstack contracts check --workspace . --manifest api-contracts.json --json
osstack compliance list --json
osstack compliance render <run_id> --pack engineering-readiness --proof-dir release/osstack-proof-<run_id>
```

说明：osstack 的 compliance pack 是证据映射，不是外部认证声明。它可以帮助工程团队、管理者、审计人员和客户更好地理解一次 run 的证据，但不自动声明 SOC 2、ISO 27001、EU AI Act 或任何第三方认证。

### Knowledge Cloud

```bash
osstack knowledge list --official --json
osstack knowledge search "worktree proof evidence" --official --json
osstack knowledge login --cloud-url https://osstack-knowledge-cloud-1grycf4k.edgeone.cool
osstack knowledge sync --cloud-url https://osstack-knowledge-cloud-1grycf4k.edgeone.cool --json
osstack knowledge search "proof pack checksum" --cloud-url https://osstack-knowledge-cloud-1grycf4k.edgeone.cool --json
osstack knowledge import ./docs --scope team --output ./team-knowledge-pack.json
osstack knowledge publish --pack ./team-knowledge-pack.json --cloud-url <url> --tenant <team>
```

当前生产 URL：

```text
https://osstack-knowledge-cloud-1grycf4k.edgeone.cool
```

当前生产健康检查：

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

Knowledge Cloud 支持：

- 官方 osstack knowledge packs；
- team/private tenant knowledge packs；
- `/v1/search`；
- `/v1/sync`；
- `/v1/publish`；
- `/v1/audit`；
- `/v1/feedback`；
- `/review` UI；
- 在未配置 KV 时使用 EdgeOne Blob 持久化 fallback。

云端不可用时，CLI 可以 fail-open 到本地 bootstrap packs 或本地 cache，不阻断 Loop Engineering 主流程。

### Cockpit、Kanban、Daemon

```bash
osstack cockpit snapshot --workspace . --json
osstack cockpit tui --workspace .
osstack kanban board
osstack kanban create "Review release proof" --priority 80 --assignee codex-cli
osstack serve
osstack serve --install
osstack status
```

Kanban 是 osstack 内置的本地看板。它可以跟踪卡片、状态、评论、事件，并可通过 Hermes/relay 类工具把事件转发到外部消息系统。

### Release 操作

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

Release doctor/status 会检查：

- GitHub CLI auth；
- GitHub Actions 可用性；
- npm publish assets；
- npm scope/token preflight；
- Knowledge Cloud deploy assets；
- EdgeOne deploy credential；
- 生产 `/healthz`、`/v1/search`、`/v1/sync`、`/v1/audit`、feedback summary、review UI；
- single-binary release assets；
- GitHub Release workflow 状态；
- proof pack integrity（当提供 proof dir 时）。

## 系统架构

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

Package 边界：

| Package | 职责 |
|---|---|
| `@osstack/cli` | CLI、daemon、cockpit、release doctor、proof assembly、product entry。 |
| `@osstack/loop` | loop state、scheduler、discovery、verifier、report model、scorecard。 |
| `@osstack/core` | policy、state、kanban、lessons、telemetry、privacy redaction。 |
| `@osstack/agents` | Agent adapters 与 git worktree isolation。 |
| `@osstack/governance` | 确定性的质量/安全扫描器。 |
| `@osstack/contracts` | 前后端 API contract alignment evidence。 |
| `@osstack/compliance` | compliance mapping packs 与 audience-specific evidence views。 |
| `@osstack/knowledge` | knowledge pack contracts、本地搜索、cache、sync client。 |
| `@osstack/knowledge-cloud` | official/team knowledge packs 的 HTTP 服务。 |

## 证据与可信模型

osstack 不要求你相信一段聊天记录。它会记录工程证据：

- loop state 与 run ID；
- Agent 选择原因与 adapter mode；
- verify commands 与 exit status；
- governance findings；
- reviewer/checker output；
- worktree branch/commit 状态；
- knowledge pack/chunk trace；
- report 与 scorecard；
- 带 SHA-256 的 proof manifest；
- PR body draft。

这让 AI 编码结果从“看起来像完成了”变成“有证据说明完成到了什么程度”。

## 本地状态与隐私

默认状态目录：

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

默认设计：

- daemon 监听 Unix socket；
- 状态存储在 SQLite；
- 默认不保存模型 API key；
- 默认 adapter 模型是 subprocess/login-reuse：subprocess adapter 可以复用用户已经登录的 CLI；
- SDK/API-key adapter 属于明确 opt-in paths，适合用户主动选择提供凭据的受控自动化场景；
- 云端知识能力可以关闭，也可以 fail-open 到本地；
- proof 生成会 redaction 常见 secret pattern。

## 开发与验证

```bash
corepack enable pnpm
pnpm install
pnpm lint
pnpm -r build
pnpm test
pnpm smoke:release-plan
pnpm smoke:knowledge-cloud
pnpm smoke:knowledge-cloud:deploy
pnpm smoke:single-binary-release-pack
pnpm smoke:single-binary-release-publish
```

常用上线检查：

```bash
npm view @osstack/cli version --json
gh release view v0.8.1 --repo gilosbornhello/osstack
curl -fsS https://osstack-knowledge-cloud-1grycf4k.edgeone.cool/healthz
```

## 路线图

当前已经完成主控制平面、证据层、Knowledge Cloud、npm 发布和单文件 release 路径。后续重点：

- 更完整的 full-screen cockpit；
- 更大规模的官方知识包；
- 更强的 contract validation；
- team/tenant knowledge operations；
- Knowledge Cloud 生产可观测性；
- 可选的 notarized macOS release channel；
- 更深入的 agent scorecard learning。

## License

MIT
