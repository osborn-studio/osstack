# osstack

**面向软件开发生命周期的命令行项目经理 Agent。**

osstack 是一个 TypeScript CLI + 后台 daemon，它运行一套迭代式的 **Loop Engineering（循环工程）**
运行时、一块内置的 **Kanban（看板）**，以及一个能力 **路由 + 策略引擎**——后者负责决定每个任务
该交给哪个编码子 Agent（Claude Code、Codex CLI……），并从结果中持续学习。

它既可以在你的机器上完全独立运行，也可以作为软件开发技能挂接到
[Hermes](https://github.com/gilosbornhello) Agent 上。

**English：[README.md](README.md)** · 路线图：[docs/V2_REFACTOR_PLAN.md](docs/V2_REFACTOR_PLAN.md)

> 状态：**v0.1.0** —— 10 个 package，GA 骨架（S0–S6）+ Loop Engineering 运行时，测试全绿。

---

## 目录

- [为什么用 osstack](#为什么用-osstack)
- [安装](#安装)
- [快速上手](#快速上手)
- [核心概念](#核心概念)
- [Loop Engineering（循环工程）](#loop-engineering循环工程) ← 旗舰功能
- [Kanban 看板](#kanban-看板)
- [任务编排与项目管理](#任务编排与项目管理)
- [Agent 适配器](#agent-适配器)
- [配置](#配置)
- [Daemon 生命周期与自动升级](#daemon-生命周期与自动升级)
- [Hermes 集成](#hermes-集成)
- [外部技能注册表](#外部技能注册表)
- [环境变量](#环境变量)
- [Monorepo 结构](#monorepo-结构)
- [开发](#开发)
- [许可证](#许可证)

---

## 为什么用 osstack

如今越来越多的编码工作由 *Agent*（Claude Code、Codex……）完成，但**围绕它们的生命周期**
却无人负责：这个任务该派给谁、结果到底有没有通过、该重试还是升级、以及下次能学到什么。
osstack 就是这一层：

- **Loop Engineering** —— 一个 `发现 → 执行 → 验证 → 迭代` 的热循环，持续处理任务队列
  （或一份 `git diff`）直到测试通过；可选 git worktree 隔离，让失败的尝试永不污染你的工作区。
- **Kanban 看板** —— 一块本地看板，跟踪每一次运行，并可（经 Hermes）从 Telegram/Slack 订阅，
  让你在手机上观察 Agent 进度。
- **路由 + 策略引擎** —— 选出最便宜且胜任的 Agent，并依据真实的成功/失败历史重新排序；
  当某个 Agent 不再称职时触发熔断。
- **Daemon + 自动升级** —— 一个常驻本地 daemon，配合干净的 `osstack upgrade` 流程
  （备份 → 排空 → 安装 → 健康检查 → 失败自动回滚）。
- **Knowledge Cloud + proof packs** —— OSSTACK 原生、可云端部署的知识服务，包含官方知识包、
  来源治理、质量元数据，以及 loop/report 证据钩子。

一切以本地优先：状态保存在 `~/.osstack/` 下的单个 SQLite 文件中，daemon 监听 Unix socket，
除非你接入会外呼的 Agent，否则数据不出本机。

---

## 安装

### 环境要求

- **Node.js ≥ 20**（corepack 管理 pnpm）
- 由 launchd 托管 daemon 需要 **macOS**（Linux/systemd 在计划中）。CLI 与循环运行时本身跨平台。
- *（可选）* 一份 Hermes Agent 检出，用于 Telegram/看板桥接。

### 通过 npm

```bash
npm install -g @osstack/cli
osstack --version
osstack loop doctor --workspace .
```

### 从源码（开发者路径）

当你要参与 osstack 自身开发、测试尚未发布的分支，或直接修改
monorepo packages 时，使用这条路径。普通产品用户优先使用上面的 npm
安装方式。

```bash
git clone https://github.com/gilosbornhello/osstack.git ~/Developer/osstack
cd ~/Developer/osstack
corepack enable pnpm
pnpm install
pnpm build
pnpm test          # 可选：验证

# 通过一个小 wrapper 把 CLI 暴露到 PATH：
cat > /opt/homebrew/bin/osstack <<'EOF'
#!/usr/bin/env bash
exec node "$HOME/Developer/osstack/packages/cli/dist/bin.js" "$@"
EOF
chmod +x /opt/homebrew/bin/osstack
osstack --version    # → osstack 0.1.0
```

---

## 快速上手

```bash
# 1. 检查当前工作区是否准备好
osstack doctor --workspace .

# 2. 运行一个产品入口任务，并生成交付证据
osstack deliver "Add one small verified change" \
  --verify "pnpm test" \
  --auto-agent \
  --worktree \
  --report \
  --scorecard \
  --proof

# 3. 打开 cockpit 摘要和终端 TUI 预览
osstack cockpit --workspace .
osstack cockpit tui --workspace .

# 4. 重新渲染最新 proof 的工程师视图
osstack proof view "$(node -e 'const s=require("./LOOP-STATE.json"); process.stdout.write(s.loop_id)')" \
  --audience engineer

# 5. 继续使用看板或查看更多例子
osstack kanban board
osstack examples
```

---

## 核心概念

| 概念 | 含义 |
|---|---|
| **Daemon** | 常驻本地进程（`osstack serve`）。持有 SQLite 状态、运行任务、承载循环会话、通过 Unix socket 暴露 JSON-RPC。 |
| **Task / run（任务/运行）** | 一个工作单元（`task submit` 或队列中的 `tasks/*.json`）。每次执行是一个带 `run_id`、流式事件与最终结果记录的 *run*。 |
| **Capability（能力）** | Agent 声明的类型化技能（`code.write`、`code.test`、`code.review`、`design.prd`、`research.ml`……）。路由按能力匹配任务。 |
| **Adapter（适配器）** | 与某个具体 Agent 的集成（`claude-code`、`codex-cli`、`ds-review`……），声明能力、成本档位与可用性探测。 |
| **Loop session（循环会话）** | 由 daemon 托管的轮询循环，按间隔或 cron 计划反复发现并处理任务。 |
| **Board / card（看板/卡片）** | 内置看板。每次运行都可镜像为一张卡片；卡片可从聊天工具订阅。 |

状态位于 `~/.osstack/`（可用 `OSSTACK_HOME` 覆盖）：

```
~/.osstack/
  state.db              SQLite：runs、events、tasks、kanban、approvals
  daemon.sock           Unix socket（可用 OSSTACK_SOCKET 覆盖）
  daemon.pid            重复实例守护
  config.yaml           基于角色的 Agent 配置
  loop-sessions.json    持久化的 daemon 循环会话（重启后恢复）
  backups/              每次升级前的 state.db 快照
  logs/                 daemon 与升级日志
```

---

## Loop Engineering（循环工程）

旗舰运行时。一个 **Loop** 反复运行以下周期：

```
发现 ──▶ 执行 ──▶ 验证 ──▶ 迭代
 │        │        │        │
找工作   跑命令   跑测试   依据判定结果
（队列   或编码   或评审   继续 / 停止 / 升级
 或diff） Agent    Agent
```

有两种运行方式：**一次性/本地**（`loop run`，无需 daemon）与
**daemon 托管**（`loop start`，后台轮询会话）。

### 发现 —— 工作从哪来

| 来源（`--source`） | 行为 |
|---|---|
| `task_queue` | 读取工作区里的 `tasks/*.json`，每个文件是一个任务（或数组）。 |
| `git_diff` | 依据 `git diff --stat`，为每个改动文件生成一个 `code.review` 任务。 |

**`tasks/*.json` 结构：**

```json
{
  "task_id": "fix-auth",          // 可选，省略则自动生成
  "capability": "code.test",      // 默认 "code.write"
  "prompt": "修复失败的 auth 测试",
  "priority": 80,                  // 0–100，越高越先；默认 50
  "context": { "file": "src/auth.ts" }   // 可选的结构化上下文
}
```

可手写，也可用 `loop enqueue`（见下）。已完成的 `task_id` 在后续周期会被跳过，
因此队列文件可以一直留在 `tasks/` 里而不会被重复执行。

### 执行 —— 谁来做

| 执行器 | 参数 | 行为 |
|---|---|---|
| Shell 命令 | `--execute "<cmd>"` | 在验证前运行一条命令（如修复脚本）。 |
| 指定 Agent | `--agent <id>` | 让每个任务都经由某个适配器（`codex-cli`、`claude-code`……）；适配器收到 prompt + `repo_path`。 |
| 自动选 Agent | `--auto-agent` | 路由找出声明该能力的适配器，策略引擎按成本、能力精确匹配与成功历史排序。 |

### 验证 —— 有没有通过

| 验证器 | 参数 | 行为 |
|---|---|---|
| Shell 门禁 | `--verify "<cmd>"`（可重复） | 任何非零退出 = 失败，所有门禁都须通过。 |
| 评审 Agent | `--reviewer <id>` | 如 `ds-review` 读取 `git diff` 并写入 `reviews/ds-review/latest.md`。 |
| 检查 Agent | `--checker <id>` | 如 `ds-verify` 在工作区运行并写入 `reviews/ds-verify/latest.md`。 |

### 迭代 —— 继续、停止还是升级

- `--goal "<cmd>"` —— 一旦该命令退出 0 就提前停止（“循环到测试变绿为止”）。
- `--cycles <n>` + `--interval-ms <ms>` —— 有限轮询循环。
- `--stop-when-idle` —— 某一周期没发现任务后停止。
- `--max-iter <n>` —— 单任务失败 N 次后升级，而不是无限循环。

### `loop run` —— 一次性 / 本地周期

本地运行一个（或 `--cycles N` 个）完整周期，**无需 daemon**。

| 参数 | 默认 | 含义 |
|---|---|---|
| `--workspace <path>` | 当前目录 | 要扫描/操作的目录。 |
| `--source <src>` | — | `task_queue` 或 `git_diff`（可重复）。 |
| `--execute <cmd>` | — | 验证前运行的 shell 命令。 |
| `--agent <id>` | — | 指定执行器适配器。 |
| `--auto-agent` | 关 | 让路由+策略选择执行器。 |
| `--verify <cmd>` | — | 验证命令（可重复；非零=失败）。 |
| `--reviewer <id>` | — | 执行后运行的评审 Agent（可重复）。 |
| `--checker <id>` | — | 执行后运行的检查 Agent（可重复）。 |
| `--goal <cmd>` | — | 该命令退出 0 时提前停止。 |
| `--max-iter <n>` | — | 单任务升级前的尝试上限。 |
| `--cycles <n>` | 1 | 运行的周期数。 |
| `--interval-ms <ms>` | 0 | 周期间延时（启用多周期模式）。 |
| `--once` | — | 单次、空闲即停的周期简写。 |
| `--stop-when-idle` | 关 | 某周期无任务即停止。 |
| `--archive-completed` | 关 | 把成功的单任务队列文件移动到 `tasks/archive/YYYY-MM-DD/`。 |
| `--worktree` | 关 | 在隔离 git worktree 中运行每个任务（见下）。 |
| `--state <path>` | `LOOP-STATE.json` | 机器可读状态文件。 |
| `--markdown <path>` | `STATE.md` | 人类可读状态文件。 |
| `--json` | 关 | 向 stdout 输出机器可读摘要。 |
| `--daemon` | 关 | 经由运行中的 daemon RPC 执行，而非进程内执行。 |

**示例：**

```bash
# 队列驱动：先修复，再用测试验证
osstack loop run --source task_queue --execute "node scripts/fix.js" --verify "pnpm test"

# 持续循环（最多 10 周期）直到 build+测试 通过
osstack loop run --source task_queue --execute "pnpm build" --goal "pnpm test" \
  --cycles 10 --interval-ms 2000

# 让 osstack 自动选择编码 Agent
osstack loop run --source task_queue --auto-agent --verify "pnpm test"

# 用 DeepSeek 评审器审查工作区 diff
osstack loop run --source git_diff --reviewer ds-review
```

**退出码：** `0` 一切正常 · `1` 配置/命令错误 · `2` 有任务失败、升级或未通过验证。

### 独立运行器（`osstack-loop`，无需 daemon、无需 CLI）

循环层也可经由 `@osstack/loop` 自带的 `osstack-loop` 二进制独立运行。这条路径
既不需要 `@osstack/cli`、daemon、Hermes，也不需要 daemon RPC——只用到本地任务队列、
shell 命令、状态文件与可选 git worktree：

```bash
pnpm --filter @osstack/loop build
pnpm --filter @osstack/loop exec osstack-loop enqueue "Run local checks" --capability code.test
pnpm --filter @osstack/loop exec osstack-loop run --source task_queue --execute "pnpm build" --verify "pnpm test"
pnpm --filter @osstack/loop exec osstack-loop status
pnpm --filter @osstack/loop exec osstack-loop doctor
```

它写出与 `osstack loop run` 相同的 `LOOP-STATE.json` / `STATE.md`，并支持相同的本地
安全原语（验证命令、有限周期、`--stop-when-idle`、`--archive-completed`、`--worktree`）。
Agent 适配器选择、daemon 托管的后台会话与 Hermes 集成仍保留在完整的 `osstack loop` 命令上。

### Worktree 隔离（`--worktree`）

当执行器会改动代码时，`--worktree` 会在一个 `osstack/loop/<loop_id>/...` 分支的
临时 worktree 中运行每个任务：

1. 从当前 `HEAD` 创建 worktree。
2. 在其中运行执行器。
3. **通过** → 提交并快进合并回工作区。
4. **失败 / 升级** → 丢弃 worktree，不做任何合并。

每个周期前后都会清理该循环分支前缀下的孤立 worktree，崩溃也不会把你的仓库弄脏。

```bash
osstack loop run --source task_queue --worktree \
  --execute "node scripts/fix-failing-test.js" --verify "pnpm test"
```

### `loop enqueue` —— 入队一个任务

```bash
osstack loop enqueue "<prompt>" [--capability <kind>] [--priority <n>] \
  [--context-json '{"file":"src/app.ts"}'] [--workspace <path>]
```

向 `tasks/` 写入一个单任务 JSON 文件。`--capability` 默认 `code.write`，`--priority` 默认 `50`。

### `loop doctor` —— 工作区预检

检查工作区是否存在、队列 JSON 是否合法、git/worktree 支持是否就绪，
以及（加 `--daemon` 时）daemon socket 是否可达。

```bash
osstack loop doctor --workspace "$PWD"
osstack loop doctor --workspace "$PWD" --daemon --json
```

### `loop status` —— 渲染当前状态

```bash
osstack loop status                       # 把本地 LOOP-STATE.json 渲染为 STATE.md
osstack loop status --daemon --workspace "$PWD"
```

`LOOP-STATE.json` 保存持久的机器状态（loop id、完成任务及其结果/迭代数/Agent/耗时、指标）；
`STATE.md` 是据此生成的人类可读表格。

### Daemon 托管的循环 —— `loop start` / `loop list` / `loop stop`

需要一个持续扫描 `tasks/*.json` 的后台轮询循环时：

```bash
osstack serve &                                            # daemon 须在运行

# 每 5 秒轮询一次，测试通过即停止
osstack loop start --workspace "$PWD" --source task_queue --goal "pnpm test" --interval-ms 5000

# 或按 cron 计划运行（每天 06:00）
osstack loop start --workspace "$PWD" --source task_queue --schedule "0 6 * * *"

osstack loop list                          # 列出运行中的会话
osstack loop stop loop_session_abc12345    # 停止某个会话
```

`loop start` 接受与 `loop run` 相同的执行器/验证器/worktree 参数，外加
`--schedule <cron>`、`--interval-ms <ms>`、`--cycles <n>`、`--once`、`--stop-when-idle`。
会话持久化在 `~/.osstack/loop-sessions.json` 中，并在 **daemon 重启后恢复**
（此前已停止的会话保持停止）。

daemon 运行时用 `osstack stats` 可查看每个循环的周期总数、成功/失败/升级计数、
token 总量与平均周期耗时。

### 可复用的 Loop Engineering 技能

该运行时也被打包为 [`loop-engineering/`](loop-engineering/) 下的仓库内技能，
供其他 Agent/平台用稳定的 wrapper 调用，而无需直接调 TS CLI：

```bash
loop-engineering/scripts/loop-doctor.sh
LOOP_VERIFY="pnpm test" loop-engineering/scripts/loop-run.sh
LOOP_GOAL="pnpm test"   loop-engineering/scripts/loop-daemon-start.sh
```

`scripts/osstack-loop.sh` 会从 `OSSTACK_REPO`、`OSSTACK_CLI` 或全局 `osstack`
二进制中解析 CLI。`references/` 记录了参数、任务队列 JSON 与 CI 集成模式。
该技能同样可安装进 Claude Code（`~/.claude/skills/loop-engineering`）
与 Codex（`~/.codex/skills/loop-engineering`）。

---

## Kanban 看板

osstack 自带一块由 SQLite 支撑的看板。每次运行都可镜像为一张卡片，
卡片还可（经 Hermes 中继）**从 Telegram/Slack 订阅**，让你在手机上观察 Agent 工作。

**列（从左到右）：** `triage → todo → ready → running → blocked → done → archived`

| 命令 | 说明 |
|---|---|
| `osstack kanban board [--archived]` | 显示各列与卡片（`--archived` 含归档列）。 |
| `osstack kanban create <title> [--priority N] [--assignee A]` | 创建卡片（始于 `triage`）。 |
| `osstack kanban move <card_id> <status> [reason]` | 移动卡片；移到 `blocked` 时 `reason` 成为阻塞原因。 |
| `osstack kanban comment <card_id> <text>` | 添加评论。 |
| `osstack kanban subscribe <card_id> <platform> <chat_id> [thread_id]` | 把某聊天频道订阅到卡片事件。 |
| `osstack kanban events [--since N]` | 排空 id 大于 `N` 的待发事件（供 Hermes → Telegram 中继）。 |

```bash
osstack kanban create "发布 v0.2" --priority 90 --assignee claude-code
osstack kanban move card_ab12cd34 running
osstack kanban subscribe card_ab12cd34 telegram 123456789
osstack kanban events --since 0          # 中继排空新事件
```

卡片携带 `title`、`priority`、`assignee`、`blocked_reason`、时间戳，以及可选的
回链到运行的 `task_id`。仅当设置了 `HERMES_KANBAN_BOARD` 时才启用到 Hermes 的看板同步。

---

## 任务编排与项目管理

把一次性的编码任务直接提交给 daemon；路由 + 策略引擎选择 Agent，运行结果以事件流回传。

| 命令 | 说明 |
|---|---|
| `osstack task submit <prompt> [flags]` | 提交任务；流式输出 `HermesEvent` JSON 帧。 |
| `osstack task status <run_id>` | 某次运行的当前状态。 |
| `osstack task cancel <run_id>` | 中止运行中的任务。 |
| `osstack task observe <run_id> [seq]` | 从日志中 `seq` 之后重放事件。 |

**`task submit` 参数：** `--kind <K>`（能力路由提示，如 `research.ml`）、
`--agent <id>`（指定适配器）、`--tag <T>`、`--max-iter <N>`、`--repo <path>`
（后三者经 `context` 喂给 autoresearch 循环）。

```bash
osstack task submit "重构 payload 解析器以提升可读性" --kind code.refactor
osstack task submit "运行 Karpathy autoresearch 循环" --kind research.ml --agent autoresearch --max-iter 50
osstack task observe run_9f8c2a11
```

### 路由 + 策略引擎

当任务按 *kind* 路由（而非指定具体 Agent）时，策略引擎为每个声明该能力的可用适配器打分：

| 规则 | 效果 |
|---|---|
| **成功率** | 该能力上完成率高，最多 **+50** |
| **近期失败** | 过去 24h 每次失败 **−15**（上限 −45） |
| **成本偏好** | 低成本档 **+15**、中 **+5**、高 **0**（用于打破平局） |
| **能力精确匹配** | 适配器能力 id 与 kind 精确匹配时 **+10** |
| **冷启动** | 无历史运行的适配器 **+5**（冷启动微调） |

一个 **handoff 熔断**会标记近期失败率超阈值的 Agent 以便降级。`osstack killswitch`
报告策略层是否触发得足够频繁、值不值得保留。任何 prompt 在抵达适配器前都会做 PII 脱敏，
每次运行的结果都会被记录，使排序随时间改进。

---

## Agent 适配器

`osstack agent list` 列出已注册适配器、它们的能力，以及在本机是否可用
（`isAvailable()` 会探测底层 SDK/二进制）。

**凭证模型：** osstack 默认不保存模型 API key。默认 CLI 适配器使用
`subprocess/login-reuse`，复用用户本机已经登录的 CLI 会话。SDK/API-key
适配器属于明确选择的高级路径；不要把 provider key 粘贴到 prompt、任务、issue
或 proof artifact 中。

| 适配器 | 能力 | 备注 |
|---|---|---|
| `claude-code` | `code.write`、`code.refactor`、`code.test`、`code.debug` | 经 `@anthropic-ai/claude-agent-sdk`。 |
| `codex-cli` | `code.write`、`code.test`、`code.review` | 无头 `codex exec --json` 子进程。 |
| `autoresearch` | `research.ml` | 单 GPU 训练循环（Karpathy autoresearch 变体）。 |
| `ds-review` | `review.code` | DeepSeek 评审器；读取 `git diff`，写 `reviews/ds-review/latest.md`。 |
| `ds-verify` | `code.review` | DeepSeek 检查器；在工作区运行，写 `reviews/ds-verify/latest.md`。 |
| `claude-design` | `design.prd`、`design.architecture`、`design.review` | 设计角色适配器。 |
| `google-stitch` | `design.*` | Stitch 设计集成。 |

每个适配器都声明一个 **成本档位**（`low`/`mid`/`high`），喂给策略引擎的成本偏好。

---

## 配置

基于角色的配置把三个生命周期 **角色** 映射到具体 Agent，并支持按机器划分的 **profile**，无需 daemon。

**角色：** `coding`（编码）· `test-verify`（测试验证）· `design`（设计）

| 命令 | 说明 |
|---|---|
| `osstack config [show]` | 显示活动 profile，以及每个角色如何解析。 |
| `osstack config doctor` | 探测哪些 Agent 已安装/可用。 |
| `osstack config pick` | 交互式为每个角色选择主 Agent。 |
| `osstack config init` | 写入默认配置到 `~/.osstack/config.yaml`。 |
| `osstack config use <profile\|auto>` | 设置活动 profile（`auto` = 按主机名匹配）。 |
| `osstack config bind <profile>` | 把本机主机名绑到某个 profile。 |
| `osstack config get [path]` | 打印配置或某个点路径。 |
| `osstack config set <profile>.<role>.<primary\|fallback> <value…>` | 设置某个值。 |

```bash
osstack config init
osstack config set mac-mini.coding.primary claude-code
osstack config set mac-mini.coding.fallback codex-cli
osstack config get mac-mini.coding.primary      # → claude-code
osstack config show
```

`config.yaml` 含 `profiles`（每个带主机名 `match` 规则与每角色的 `primary`/`fallback`）
以及无匹配时使用的 `defaults` 块。

---

## Daemon 生命周期与自动升级

| 命令 | 说明 |
|---|---|
| `osstack serve` | 启动 daemon（Unix socket；直到 SIGTERM/SIGINT 才退出）。 |
| `osstack health` | daemon 健康：版本、运行时长、内存、适配器、活动运行数。 |
| `osstack status` | CLI ↔ daemon 版本握手 + 升级可用性。 |
| `osstack stats` | 每 Agent 运行指标 + 每循环会话指标。 |
| `osstack killswitch` | 检查策略层是否称职（F4）。 |
| `osstack upgrade [flags]` | 带备份 + 自动回滚的自更新。 |

daemon 通过 pidfile 防止重复实例，最多每 24h 探测一次 npm registry
（设 `OSSTACK_UPDATE_CHECK=0` 可禁用），并在 `health` 中透出 `update_available`。
CLI 与 daemon 在连接时交换 `protocol_version`，不匹配时 `osstack status` 会告警。

### `osstack upgrade`

```bash
osstack upgrade --dry-run                 # 显示将发生什么
osstack upgrade                           # latest 通道
osstack upgrade --channel canary          # 尝鲜通道
osstack upgrade --auto                    # 无人值守（供 cron/launchd）
```

升级是事务性的：**解析目标版本 → 备份 `state.db`（保留最近 5 份）→ 排空并停止 daemon →
`npm i -g @osstack/cli@<target>` → 重启 → 健康检查 → 失败自动回滚到上一版本。**
launchd 模板（`packages/cli/launchd/`）可每周运行 `osstack upgrade --auto`。

---

## Hermes 集成

osstack 可独立运行，也可作为 Hermes 的软件开发技能。一个薄薄的 Python wrapper
（`osstack_bridge.py`）通过 Unix socket 与 daemon 通信，并把事件流回 Hermes 会话。

| 命令 | 说明 |
|---|---|
| `osstack hermes health` | 显示看板同步桥接状态。 |
| `osstack hermes dashboard` | 在浏览器中打开 Hermes WebUI。 |
| `osstack hermes register-cron` | 打印示例 `hermes cron` 配方。 |

相关环境变量：`HERMES_BIN`（二进制路径）、`HERMES_AGENT_HOME`（Hermes 仓库根，用于定位桥接二进制）、
`HERMES_KANBAN_BOARD`（看板 slug；未设则不同步）、`HERMES_WEBUI_HOST`/`HERMES_WEBUI_PORT`
（默认 `127.0.0.1:8787`）。

---

## 外部技能注册表

跟踪外部技能生态（GStack、Everything Claude、Anthropic Skills……），并检测它们何时偏离已认可（blessed）提交。

| 命令 | 说明 |
|---|---|
| `osstack skills list` | 列出已跟踪源及其 blessed SHA。 |
| `osstack skills check` | 把各 `blessed_sha` 与 origin `HEAD` 对比（漂移时退出 2）。 |
| `osstack skills add <id> <origin> [ref]` | 跟踪新源（ref 默认 `main`）。 |
| `osstack skills bless <id>` | 把当前 origin `HEAD` 钉为 blessed。 |

---

## 环境变量

| 变量 | 用途 | 默认 |
|---|---|---|
| `OSSTACK_HOME` | 存储根目录 | `~/.osstack` |
| `OSSTACK_SOCKET` | daemon socket 路径 | `$OSSTACK_HOME/daemon.sock` |
| `OSSTACK_UPDATE_CHECK` | 设 `0` 禁用每日升级探测 | 启用 |
| `HERMES_BIN` | Hermes 二进制路径 | 自动探测 |
| `HERMES_AGENT_HOME` | Hermes 仓库根（看板桥接二进制） | `~/.hermes` |
| `HERMES_KANBAN_BOARD` | 看板同步 slug（未设则不同步） | — |
| `HERMES_WEBUI_HOST` / `HERMES_WEBUI_PORT` | Hermes WebUI 地址 | `127.0.0.1` / `8787` |
| `OSSTACK_DS_REVIEW_BIN` / `OSSTACK_DS_VERIFY_BIN` | 覆盖 DeepSeek 评审/检查二进制 | 自动 |
| `LOOP_VERIFY` / `LOOP_GOAL` / `LOOP_WORKTREE` | `loop-engineering/` 脚本的默认值 | — |
| `OSSTACK_REPO` / `OSSTACK_CLI` | `loop-engineering/` 脚本的 CLI 解析 | — |

---

## Monorepo 结构

| Package | 角色 |
|---|---|
| [`@osstack/cli`](packages/cli) | `osstack` 二进制（daemon、全部命令、循环运行器、升级）。 |
| [`@osstack/loop`](packages/loop) | Loop Engineering 运行时：发现 → 执行 → 验证 → 迭代。 |
| [`@osstack/core`](packages/core) | 编排器、路由、策略引擎、看板、记忆、隐私、可观测性、SQLite 状态。 |
| [`@osstack/agents`](packages/agents) | 子 Agent 适配器（claude-code、codex-cli、ds-review/verify……）+ worktree 工具。 |
| [`@osstack/config`](packages/config) | 基于角色的 Agent 配置 + profile。 |
| [`@osstack/hermes-adapter`](packages/hermes-adapter) | Hermes Run-Adapter 契约：事件、状态 FSM、socket 分帧。 |
| [`@osstack/skill-registry`](packages/skill-registry) | 外部技能摄取 + blessed-SHA 漂移检测。 |
| [`@osstack/skills`](packages/skills) | 生命周期技能模板 + `osstack init` 脚手架。 |
| [`@osstack/plugins`](packages/plugins) | 插件槽位定义（runtime/agent/workspace/tracker/notifier/reviewer/verifier）。 |
| [`@osstack/runtime`](packages/runtime) | 可选 Zellij/终端工作区管理器。 |

专业服务 Agent 垂直（Elon/Jobs/Linus/Turing/Bezos/Qian 人格、intent 引擎、审批台）
位于 **独立仓库** [partner-os](https://github.com/gilosbornhello/partner-os)，
它构建在这些 `@osstack/*` package 之上。

---

## 开发

```bash
git clone https://github.com/gilosbornhello/osstack.git ~/Developer/osstack
cd ~/Developer/osstack
corepack enable pnpm
pnpm install
pnpm build          # 构建所有 package（CLI 用 tsup，库用 tsc）
pnpm test           # 跨所有 package 的 vitest
pnpm typecheck      # tsc --noEmit
pnpm lint           # Biome
```

**循环演示与冒烟测试：**

```bash
pnpm demo:loop          # 用 loop run 修复一个坏掉的 add()，并打印工作区
pnpm demo:loop:daemon   # 同样的修复，经由真实的 osstack serve + daemon RPC
pnpm smoke:loop         # 端到端：队列、worktree、评审器、cron、重启恢复
pnpm coverage:loop      # 对 @osstack/loop 强制 ≥80% 覆盖率门槛
```

**发布** 用 [changesets](https://github.com/changesets/changesets) 管理：
用 `pnpm changeset` 添加 changeset，发布工作流会打开一个 "Version Packages" PR，
合并后发布到 npm。双周发布列车流程见 [RELEASING.md](RELEASING.md)。

发布 npm、部署 Knowledge Cloud 或上传单文件 release assets 之前，先运行：

```bash
osstack release doctor --json
osstack release plan --target all --output release-plan.md --json
osstack release handoff --cloud-url <EdgeOne URL> --output-dir release-handoff --json
```

这些命令会检查 GitHub auth、仓库 secrets（`NPM_TOKEN`、`EDGEONE_API_TOKEN`）、
本地 npm auth、npm 发布资产、EdgeOne Knowledge Cloud 部署资产，以及单文件 release
资产，避免把部分发布/部署误认为生产就绪。当前 Knowledge Cloud 正式上线以 EdgeOne
为主路径，首选部署凭证是 `EDGEONE_API_TOKEN`；`EDGEONE_DEPLOY_HOOK_URL` 仍作为
hook 项目的 fallback 保留。Fly.io 只保留为可选参考，不再要求 `FLY_API_TOKEN`。

当 GitHub Actions minutes 紧张时，优先使用 `release handoff` 生成的
`next-actions.sh`。它只打印操作者清单，不会执行 secret 写入、Release rerun 或 EdgeOne
部署；其中会把本地验证、GitHub 只读查询、会消耗 Actions minutes 的远端 workflow
命令分开列出。

---

## 许可证

MIT。见 [LICENSE](LICENSE)。
