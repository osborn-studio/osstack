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

## 从这里开始

- [Graph Engineering 怎么用](#graph-engineering)：执行流程、支持范围和命令。
- [完整 Graph 上手与参数手册](docs/guides/graph-quickstart.md)：准备配置、验证、运行、结果、取消和恢复。
- [当前能力范围](#当前能力范围) · [安装](#安装) · [主要命令](#主要命令)。
- [按任务选命令及常用参数](docs/guides/command-reference.md) · [完整顶层命令清单](docs/inventory/CLI_COMMANDS.md)。

[Prompt 写作约定（中文 / English）](docs/guides/prompt-language.md)：借鉴 ASD-STE100，写清指令、条件和结果。

## Firstmate 能力与命令

当前开发分支已为 Firstmate 的 24 项能力建立实现或复用路径，主要入口如下。**这不是 24/24 已上线声明：PR #244 与前序依赖的审计、CI、合并及真实环境资格是独立条件。**

| 用途 | 命令入口 |
|---|---|
| 监督与决策 | `attention status/watch/inbox/get/answer/recovery` |
| 简报与低打扰 | `attention brief/cockpit/posture/seen/foreground` · `daily` · `cockpit` |
| 回合与监督登记 | `attention handoff/turn-end/claude-hook/loop/ci` |
| 调查转交付 | `scout inspect/promote` · `deliver` · `start` · `control` |
| 验证与保全 | `graph validate/run/status/result/cancel/reconcile/resume` · `loop enqueue/run/status` |
| 工作进程视图 | `worker list/inspect/watch/open/logs` |
| 来源与连续性 | `sources inspect/observe/events/acknowledge` |
| 远程 home | `remote-home inspect/issue-cancel-grant/cancel/query` · `remote-export --stdio` · `remote-control --stdio` |
| 上下文、记忆与路由 | `attention context/lesson/triage/routing-eval` · `deliver --execution-context FILE` |
| 对外承诺 | `follow-up-delivery prepare/list/inspect/issue-grant/authorize/revoke/dispatch/reconcile` |
| 多 home 升级 | `homes inspect/plan-upgrade/upgrade-status/prepare-managed-installation/apply-upgrade/reconcile-upgrade` |

查看[完整中文命令手册](docs/guides/firstmate-commands.md)与[English guide](docs/guides/firstmate-commands.en.md)，包含参数示例、只读/写操作边界、授权前提和未完成的真实环境资格。文档通过 `osstack neat check` 检查；该检查不代表部署或功能验收。

## 当前状态

| 领域 | 状态 |
|---|---|
| npm 包 | 待发布版本：`@osstack/cli@0.22.1`；2026-10-25（北京时间）检查时 npm latest 为 0.21.0。请用 `npm view @osstack/cli version` 确认发布状态 |
| GitHub Release | 计划发布的包版本：`@osstack/cli@0.22.1`；最新单文件二进制：[`v0.8.1`](https://github.com/osborn-studio/osstack/releases/tag/v0.8.1) |
| macOS 单文件二进制 | 已发布 `darwin-arm64` 的显式 `public-ad-hoc` archive |
| Knowledge Cloud | 已部署到 EdgeOne：`https://osstack-knowledge-cloud-1grycf4k.edgeone.cool` |
| Probe | CLI 生命周期已随 CLI 0.19.0 发布；report-only 是 gate 行为，不是后台任务。两周真实使用 checkpoint 仍未完成。 |
| License | MIT |
| Monorepo | 22 个 workspace package |

**版本边界：** 当前源码的 CLI 包版本为 0.22.1；源码版本不等于公共发布或本机已安装版本。请用 `osstack --version` 与 `npm view @osstack/cli version` 分别核对；Firstmate 本轮能力以分支及 PR 交付状态为准。

## 当前能力范围

当前源码已经不只是一个 loop runner，而是一个本地优先的研发控制平面：

| 能力 | 当前实现 | 主要命令 / package |
|---|---|---|
| 产品入口 | 一条命令把目标变成带验证、report、scorecard、proof pack 和可选 worktree 隔离的交付流程。 | `osstack deliver`, `@osstack/cli` |
| Graph Engineering（内部 beta） | 固定工程图：隔离实现、冻结候选、并行 review/tests、按候选汇合、有界修复、检查点与动作账本。只交付 artifact。 | `osstack graph ...`、`@osstack/graph` |
| 知识卫生 | 确定性文档/指令检查，以及显式启用的语义审计与审阅后修复。 | `osstack neat ...` |
| Loop Engineering | 任务发现、执行、验证、迭代、预算、停止原因、报告、分数卡、lesson draft、daemon 托管 loop session。 | `osstack loop ...`, `@osstack/loop` |
| 多 repo 监督 | repo registry、成熟度扫描、portfolio report、feedback assets、改进 proposal、evaluator epoch、结构化 recommendation。 | `osstack supervise`, `feedback`, `improve`, `evaluator`, `daily`; `@osstack/supervisor` |
| 每日运营简报 | 读取 repo registry，总结 CI/PR/maturity 变化，生成 owner decisions，并可由 daemon 每 24h 定时运行。 | `osstack daily`, `osstack daily schedule` |
| 合同门控执行 | 创建 execution contract，在 observe policy 下阻断执行，记录 approval，批准后返回精确后续命令。 | `osstack start`, `osstack control` |
| Policy kernel | 读取 `.osstack/repo.yaml` 和 `.osstack/policy.yaml`，执行 `observe` / `propose` / `execute`、预算和审批类别。 | `osstack policy check`, `@osstack/core` |
| Agent 路由 | 接入 Claude Code、Codex CLI、OpenCode、DeepSeek review/verify、shell subprocess、design/research adapter。 | `@osstack/agents`, `@osstack/core` |
| 证据与发布可信 | 持久化 run state、events、governance、diff、proof manifest、PR body draft、release handoff、release readiness。 | `report`, `scorecard`, `proof`, `pr`, `release` |
| Cockpit / Dashboard | 本地 dashboard/TUI 展示 daemon、recent runs、kanban、evidence、quality、next actions。 | `osstack cockpit`, `osstack dashboard` |
| 远程 gateway hook | 提供 dashboard URL、kanban subscription/events，方便外部 bot 把进展转发到 Telegram、飞书/Lark、Slack、webhook 或其他 IM。 | `dashboard url`, `kanban subscribe`, `kanban events`, `KanbanNotifier` |
| Knowledge Cloud | 官方/团队/项目知识包、cloud sync、本地 cache fallback、search、publish、audit、feedback、review UI。 | `osstack knowledge`, `@osstack/knowledge-cloud` |
| 四象限需求探询 | 持久化会改变实施的未知项、一次一题、导出 portable ledger、评估 readiness，并把人审后的决策接入实施门禁。 | `osstack probe ...`、`@osstack/governance`、`@osstack/core`；可选 repo-local `probe-skill` |
| Protocol / Conformance | 跨进程 agent command、result、policy、evidence、approval、run、event schema 和 conformance tests。 | `@osstack/protocol`, `@osstack/conformance` |

### 远程 Gateway 状态

osstack 现在已经有**控制平面侧的远程进展 gateway 底座**，但这个仓库目前还没有内置完整的飞书/Lark 或 Telegram bot 服务端。

现在已经存在：

- `osstack dashboard url` 可以返回本地 cockpit URL，外部 chat bot 可以把它发回给用户。
- `osstack kanban subscribe <card_id> <platform> <chat_id> [thread_id]` 可以记录一个聊天订阅。`platform` 是 free-form，所以可以是 `telegram`、`feishu`、`lark`、`slack` 或其他 relay。
- `osstack kanban events --since <id>` 可以增量读取卡片事件。
- `@osstack/core` 里的 `KanbanNotifier` 会格式化卡片进展，并且只在外部 transport 成功投递后推进 subscription cursor。
- Hermes skill bridge 里有 Telegram-facing 命令；如果 Hermes 拥有真实消息集成，它可以作为 relay host。

现在还没有：

- 内置 Telegram Bot API 常驻进程；
- 内置飞书/Lark bot webhook 或 event subscription 服务；
- 面向公网访问本地 cockpit 的 tunnel/auth 层；
- 手机端优先的审批 UI。

所以你印象里的 “gateway 已经配置好” 大方向是对的：osstack 侧的 gateway primitives 已经在。真正缺的是把这些 primitives 接到具体消息通道上的 product slice，也就是“我在手机上问 bot，它能告诉我项目进展并给我可点击证据”的那一层。

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
- **递归控制平面**：监督多个 repo 的 L0-L6 闭环成熟度，把失败 run 提炼成 feedback assets，生成需人工门控的改进 proposal，并管理 evaluator epoch。
- **Knowledge Cloud**：osstack 自有知识包体系，支持官方/团队/项目知识、云端 sync、本地 cache、provenance、feedback 和 retrieval eval。
- **Cockpit + Kanban**：从 CLI/TUI 查看 run、task、证据、知识和下一步行动。
- **远程 gateway hook**：暴露 dashboard URL、kanban subscription 和增量事件，方便外部 bot 转发到 Telegram、飞书/Lark、Slack 或 webhook。
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

0.22.1 源码构建或 npm 完成发行后的期望输出：

```text
osstack 0.22.1
```

### 使用 macOS 单文件 archive

单文件二进制通道独立发布，可能落后于 npm 版本；当前最新二进制 release 为
`v0.8.1`。从 GitHub Releases 下载：

- [`osstack-0.8.1-darwin-arm64.tar.gz`](https://github.com/osborn-studio/osstack/releases/tag/v0.8.1)
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
git clone https://github.com/osborn-studio/osstack.git
cd osstack
corepack enable pnpm
pnpm install
pnpm build
pnpm test
# 为当前源码 checkout 创建私有 home，不使用生产 home。
export OSSTACK_HOME="$(mktemp -d /tmp/osstack-dev-XXXXXX)"
chmod 700 "$OSSTACK_HOME"
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

# 5. 查看显式 Probe session 工作流；Probe 不会自动启动。
osstack probe --help

# 6. 只读审计当前仓库的知识卫生。
osstack neat check --fail-on none

# 7. 运行一次带 worktree 隔离和证据输出的交付流程。
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
| Probe（探询） | 持久化的四象限探询会话，把未知项转成可审阅的决策、目标文档和 readiness 证据。 |
| Proof pack（证据包） | 带 SHA-256 checksum 的证据集合，包含 report、state、events、verify、governance、diff、manifest 等。 |
| Knowledge pack（知识包） | osstack 原生知识资产，包含 version、license、source provenance、quality metadata、chunks 和 retrieval eval。 |

## Graph Engineering

Graph 将一个工程任务组织成明确的节点、输入输出和停止规则；Loop 负责发现任务和循环推进，agent 负责具体实现或评审。`graph explain` 只诊断已有关系，`graph run` 才会执行。

```text
注册任务 + 精确 baseRevision + 验收命令 + 权限/预算
  → 隔离 writer 工作区 → implement / repair → 确认停止 → 冻结 candidate
  → 独立 review 工作区 ──评审──┐
  → 独立 tests 工作区  ──验收──┴→ join（必须是同一 candidate）
  → ready + artifact / 有界修复 / 失败或保留未知状态
```

**目前能做：** 固定 `code-delivery-v1` 图，并行评审与测试、条件修复、持久检查点、取消与可信对账。当前 bounded writer/reviewer 支持 Anthropic、DeepSeek；writer 每次替换一个登记的 UTF-8 文件，最大 4 KiB。

**当前边界：** 不是任意 DAG 编辑器；不自动把所有 Loop adapter 变成 Graph 执行器；`artifact_only` 不会自动推送、开 PR、合并或部署。`ready` 意味着候选通过指定的评审/验收，不意味着已上线。Bun 单文件不支持 Graph 执行。

先按[完整上手手册](docs/guides/graph-quickstart.md)生成配置与请求，并启动具有授权的独立 daemon，再使用：

```sh
osstack graph validate --spec /absolute/spec.json --json
osstack graph run --request /absolute/start.json --json
osstack graph status --run RUN_ID --scope /absolute/scope.json --json
osstack graph result --run RUN_ID --scope /absolute/scope.json --json
osstack graph cancel --request /absolute/cancel.json --json
osstack graph reconcile --request /absolute/cancel.json --json
osstack graph resume --request /absolute/resume.json --json
```

这些 JSON 文件不是任意 prompt；需要严格 v1 schema、显式 scope、幂等键以及当前 host 授权。`run` 返回不代表完成；继续查询 `status`，再读 `result`。退出码 `2` 表示提交结果未知，只能重试同一个请求。完整字段、预算、状态与错误处理见[参数手册](docs/guides/graph-quickstart.md)。

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

### 受治理的可恢复会话

```bash
osstack session start --request-id task-123 --agent codex-cli --repo "$PWD" \
  --title "Task 123" --text "请给出下一步安全动作" --json
osstack session snapshot <session_id> --json
osstack session send <session_id> --runtime codex-cli --turn <turn_id> \
  --message-id task-123-owner-002 --expected-version <version> \
  --text "按已批准方案继续" --json
```

该能力持久化有界的公开会话状态，不暴露 Codex/Claude 原生 session ID。
相同消息在本地幂等；若 daemon 在外部模型可能已收到指令、但结果尚未落库时中断，
系统会返回 `delivery_uncertain` 并停止自动重发，交由 owner 核验后决定。
完整说明见 [session relay 指南](docs/guides/session-relay.md)。

### Portfolio Daily 与合同门控

```bash
# 从 machine-level repo registry 生成只读 portfolio brief。
osstack daily --json

# 通过 daemon 每 24h 自动跑 daily brief；daemon 重启后会恢复 session。
osstack daily schedule --interval-ms 86400000 --schedule "every 24h"
osstack daily sessions --json

# 把目标转成 execution contract。observe mode 会拒绝执行；
# propose/execute mode 会生成可审查合同和 approval request。
osstack start "Refactor model run history" --repo-id osborn-model --json

# 查看、批准、修订或停止合同。批准后返回精确 delivery 命令，而不是静默执行。
osstack control <contract_id> status --json
osstack control <contract_id> approve --actor owner --json
```

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

### 四象限需求探询（Probe）

Probe 是显式、持久化的开发前/开发中工作流，不会在后台自动创建 session。
每个真实 spec 都要主动启动，并通过 `--task` 关联对应任务，kanban readiness
guard 才能找到它。运行前请替换下面的示例路径和标识：

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

建议在仓库中显式提交 rollout policy，方便 PR 审阅：

```yaml
# .osstack/probe.yaml
schema_version: 1
enforcement: report
```

即使没有 `.osstack/probe.yaml`，内置策略也已经是 `enforcement: report`。
但 **report-only 的含义只是：gate 被执行时报告 readiness violation、但不阻断**。
它不是 daemon、scheduler 或自动 dogfood 开关；没有 Probe session 时就没有可评估内容。

确定性的 CLI 生命周期已经包含在 npm 版本中。一次一题的自然语言 Agent 体验位于
[`probe-skill/`](probe-skill/)，CLI 不会自动把它安装进 Codex/Agent 的 skills
目录；调用 `$probe-skill` 前必须另行安装或链接。两周 report-only dogfood、
5 个真实粗糙 spec 和 `restate` 人工抽查仍是经验性 checkpoint，不能当作已完成的
发布结论。详见
[Probe v2 设计与 checkpoint 记录](docs/2026-07-17-probe-four-quadrant-elicitation-design.md#13-checkpoints发布与回滚)。

### 知识卫生（neat）

**任务完成后可以用它做文档收尾检查。** `osstack neat` 等价于只读的 `neat check`：检查指令、文档引用、知识合同和上下文预算。它不会自动总结全部代码改动、重写 README、格式化源代码、提交 Git 或发布 GitHub。代码是否正确仍需测试与 review。

- 未提交改动：`osstack neat check --repo . --json --fail-on none`。
- 当前分支相对主线：`osstack neat check --base origin/main --head HEAD --json --fail-on warning`。
- 全仓文档健康：`osstack neat check --all --json --fail-on none`；不检查 Git 变更合同。
- Loop 成功后附带检查：`osstack loop run ... --neat-finalize`，结果作为非阻断证据，不自动应用修复。

[任务结束后的完整收尾流程](docs/guides/task-closeout.md)包含 Git diff、neat、README 更新、验证和提交的顺序；[neat 完整指南](docs/guides/neat.md)解释 semantic、review、fix、history 与事务权限。

```bash
# 检查当前工作树；完整展示 finding，但不因 finding 改变退出码。
osstack neat check --fail-on none

# CI 比较范围；warning/error 都阻断，并输出严格 JSON envelope。
osstack neat check --base origin/main --head HEAD --json --fail-on warning

# 全仓审计，也支持非 Git 仓库。
osstack neat check --all --fail-on none

# 为精确的报告 diff 记录并应用显式审阅证据。
osstack neat review --report /tmp/neat-report.json --finding khf_... \
  --outcome reviewed_no_change --reason "已审阅" --actor osborn \
  --output /tmp/neat-review.json
osstack neat check --review-file /tmp/neat-review.json --fail-on warning

# 默认只预览；仅在 execute/docs 自动应用策略下显式写入。
osstack neat fix --from /tmp/neat-report.json
osstack neat fix --from /tmp/neat-report.json --apply --yes

# 仅在显式请求时记录规范化历史。
osstack neat check --record --json --fail-on none
```

可选的 `.osstack/neat.yaml` 用来声明权威指令文件、必备文档、预算和变更审阅合同。
检查全程只读且不猜测一般散文的语义；`neat review` 只写入调用方显式指定的便携证据文件，`neat fix` 默认仅生成封闭的安全补丁预览。完整字段、规则与边界见
[neat 使用与配置指南](docs/guides/neat.md)。

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
osstack serve --install
osstack status
```

Kanban 是 osstack 内置的本地看板。它可以跟踪卡片、状态、评论、事件，并可通过 Hermes/relay 类工具把事件转发到外部消息系统。daemon 默认本地优先；`osstack serve --install` 会安装 macOS launchd 服务，让 daemon 跨重启存活。手机/远程访问应由独立可信 host 承担，例如 Hermes、飞书/Lark bot、Telegram bot、Slack app、webhook relay 或 named tunnel，再调用上面的 dashboard/kanban 命令。

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
- npm Trusted Publishing（OIDC）、公开包首次发布状态、逐包 trust 映射与本地恢复权限预检；
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
| `@osstack/protocol` | 跨进程 command/result/event/evidence/approval schema。 |
| `@osstack/governance` | 确定性的质量/安全扫描器。 |
| `@osstack/contracts` | 前后端 API contract alignment evidence。 |
| `@osstack/compliance` | compliance mapping packs 与 audience-specific evidence views。 |
| `@osstack/knowledge` | knowledge pack contracts、本地搜索、cache、sync client。 |
| `@osstack/knowledge-cloud` | official/team knowledge packs 的 HTTP 服务。 |
| `@osstack/supervisor` | portfolio maturity、repo registry、feedback assets、proposal、evaluator epoch。 |

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
pnpm smoke:neat
pnpm eval:neat-goldens
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
