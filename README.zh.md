# OSBORN stack (osstack) — 中文 README

> 一个跑在你 Mac 上的「**本地项目经理 Agent**」。
> TypeScript daemon + 多种入口（终端 / Hermes / 自定义客户端 / launchd），调度 Claude Code 和 Codex 等子 agent CLI，覆盖软件开发的全生命周期。

---

## 目录

- [一、它是什么](#一它是什么)
- [二、定位与架构](#二定位与架构)
- [三、osstack 调度哪些子 agent CLI](#三osstack-调度哪些子-agent-cli)
- [四、osstack 怎么被驱动（4 个入口）](#四osstack-怎么被驱动4-个入口)
- [五、安装](#五安装)
- [六、快速开始](#六快速开始)
- [七、命令参考](#七命令参考)
- [八、配置（环境变量）](#八配置环境变量)
- [九、几种典型工作流](#九几种典型工作流)
- [十、可观测性与运维](#十可观测性与运维)
- [十一、安全与隐私](#十一安全与隐私)
- [十二、当前状态与下一步](#十二当前状态与下一步)
- [十三、仓库结构](#十三仓库结构)

---

## 一、它是什么

osstack 是一个**跑在你自己机器上的本地项目经理 Agent**。

它**不是**对话式 AI（不是 ChatGPT），也**不是**写代码的 AI（不是 Claude Code），而是**调度多个写代码 AI、做出选择、跟踪历史、暴露指标**的那一层。

osstack 专门做四件 Hermes 不擅长的事：

1. **判断该用哪个子 agent**：基于历史成功率、成本、最近失败、能力匹配给出打分。
2. **跨任务记忆**：每个 run 的 task_id / agent_id / capability / duration / tokens / outcome 落到本地 SQLite。
3. **失败学习 / 杀手开关**：累积失败率超阈值触发 handoff，要求人工介入；30 天内 policy 没被有效使用就报 TRIPPED。
4. **外部 skill 生态吸收**：监控 GStack、Everything Claude Code、Anthropic Skills 等 TS 生态，normalize 为 Hermes 兼容的 SKILL.md。

---

## 二、定位与架构

osstack 在产品上是 **Hermes 的"软件开发生命周期"专项 skill**——借力 Hermes 的 cron / messaging / memory / dashboard / kanban，自己只专心做调度层。

技术上是**双形态**：TypeScript daemon 主体 + Python 薄包装（Hermes skill）。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  入口 1：Hermes session           入口 2：直接终端                            │
│   $ hermes chat                      $ osstack task submit "..."            │
│     (skill 调用)                                                            │
│                                                                              │
│  入口 3：自定义客户端              入口 4：launchd 自启动                    │
│   你写的 Python/Go/Bash 程序        ai.osstack.daemon.plist                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                  ↓
                  Unix socket  ~/.osstack/daemon.sock
                  length-prefixed JSON 协议（与 LSP / MCP 同款）
                                  ↓
   ┌──────────────────────────────────────────────────────────────────┐
   │  osstack daemon（Node.js，常驻进程）                                │
   │                                                                    │
   │  PII redactor → orchestrator → policy engine → AgentAdapter        │
   │                                                       ↓             │
   │                                          ├─ claude-code (SDK)       │
   │                                          └─ codex-cli (headless)    │
   │                                                                    │
   │  写入：SQLite (~/.osstack/state.db, WAL mode)                      │
   │  支撑：Hermes bridge / GBrain adapter / OTel exporter（均可选）      │
   └──────────────────────────────────────────────────────────────────┘
```

---

## 三、osstack 调度哪些子 agent CLI

**已实现（S1-S2，真活验证）**：

| Adapter ID | 显示名 | 调用方式 | 默认能力 | 成本档 |
|---|---|---|---|---|
| `claude-code` | Claude Code (Anthropic Agent SDK) | npm 包 `@anthropic-ai/claude-agent-sdk`，daemon **直接 SDK 调用**（不 spawn 子进程） | code.write / code.refactor / code.test / code.debug | high |
| `codex-cli` | OpenAI Codex CLI（headless） | spawn `codex exec --json --skip-git-repo-check -s read-only <prompt>` 子进程，逐行解析 JSONL | code.write / code.refactor | mid |

**计划中（按需添加，避免给 0 个真活用户写 adapter）**：

| Adapter | 何时添加 |
|---|---|
| DeepSeek TUI | 当你真用 DeepSeek 跑 review/verify 时 |
| DeepCode CLI | 当 DeepCode 进入你的真实工作流时 |
| MiniMax CLI | 同上 |
| Kimi CLI | 同上 |

**怎么加新 adapter**：实现 `AgentAdapter` 接口（`packages/agents/src/base.ts`），声明 capabilities，提供 `isAvailable()` 和 `invoke(task, signal)` 流式生成器。注册到 daemon 即可。整个新 adapter 通常 100-200 行 TS。

---

## 四、osstack 怎么被驱动（4 个入口）

**重要：osstack 不是只能被 Hermes 控制。** 它是一个本地常驻 daemon，**4 种入口任选**：

### 入口 1：Hermes Agent（主路径）

Hermes session 加载 `~/.hermes/skills/software-development/osstack/` 这个 skill，通过 `osstack_bridge.py` 调用 daemon。

```python
# Hermes session 内部
from osstack_bridge import _daemon_call
result = _daemon_call("task.submit", {"prompt": "写个 fib(n) TS 函数"})
```

**适用**：你已经在用 Hermes，想让它把 dev 任务委派给 osstack。

### 入口 2：直接终端 CLI（不依赖 Hermes）

```bash
osstack task submit "写一个 React 组件"
osstack stats
osstack task observe run_abc123
```

**适用**：Hermes 离线、脚本化 CI、shell 用户。osstack 完全独立运转。

### 入口 3：任意自定义客户端

osstack 的 Unix socket 协议是公开的（length-prefixed JSON，4-byte big-endian 长度头 + JSON payload，与 LSP/MCP 同款）。任何能讲这个协议的程序都能驱动：

```python
import socket, struct, json
s = socket.socket(socket.AF_UNIX); s.connect('~/.osstack/daemon.sock')
body = json.dumps({'id': 1, 'method': 'task.submit',
                   'params': {'prompt': '...'}}).encode()
s.sendall(struct.pack('>I', len(body)) + body)
# 之后读取多个 length-prefixed response 帧直到 terminal=true
```

**适用**：自写的 GUI 客户端、Telegram bot 派单、CI pipeline 触发、跨语言集成。

### 入口 4：launchd 自启动

```bash
bash ~/Developer/osbstack/packages/cli/launchd/install.sh
```

之后 `ai.osstack.daemon` 作为系统服务自启，崩溃 10 秒后自动拉起（`KeepAlive = SuccessfulExit: false`）。配合上面 3 种入口任意使用。

**适用**：Mac mini 7×24 运行场景。

---

**简言之**：Hermes 是**最自然**的入口（已配 skill），**绝不是唯一**的入口。所有能力都暴露在 Unix socket 协议层。如果 Hermes 哪天挂了，`osstack task submit "..."` 在终端照常工作。

---

## 五、安装

### 前置

- macOS（其他 Unix 应该可用，未验证）
- Node.js ≥ 20（用 corepack 自动管理 pnpm，**不需要预装 pnpm**）
- 至少装上 Claude Code 或 Codex CLI 之一，否则 daemon 起得来但没法干活

可选依赖：
- Hermes Agent（如果你想走入口 1）
- OpenTelemetry collector（想要 OTel trace 导出）
- GBrain（想 KG 同步）

### 步骤

```bash
# 1. 克隆代码
git clone https://github.com/gilosbornhello/osbstack.git ~/Developer/osbstack
cd ~/Developer/osbstack
git checkout v2/typescript

# 2. 装依赖 + 构建
corepack enable pnpm
pnpm install
pnpm build
pnpm test               # 应该看到 55/55 passing

# 3. 把 Hermes skill 软链到 ~/.hermes（如果用 Hermes）
bash hermes-skill/scripts/osstack_install.sh

# 4. 把 daemon 装成 launchd 服务（推荐）
bash packages/cli/launchd/install.sh

# 5. 验证
osstack health
```

---

## 六、快速开始

```bash
# 如果没走 launchd，手动启动 daemon
osstack serve &

# 提交一个 dev 任务
osstack task submit "在当前目录写一个 fib.ts，含 vitest 测试"

# 观察实时事件流（submit 时已经在流式输出；这里是事后重放）
osstack task observe run_xxxxxxxx

# 看汇总指标
osstack stats

# 任意时刻看运行状态
osstack task status run_xxxxxxxx

# 取消一个正在跑的任务
osstack task cancel run_xxxxxxxx

# daemon 健康
osstack health

# F4 杀手开关检查：policy 是不是在赚它的工资
osstack killswitch
```

---

## 七、命令参考

### Daemon / 健康

| 命令 | 作用 |
|---|---|
| `osstack serve` | 启动 daemon（Unix socket 在 `~/.osstack/daemon.sock`） |
| `osstack health` | daemon 健康快照（含 otel / hermes / gbrain 开关状态） |
| `osstack stats` | per-(agent, capability) 指标表 |
| `osstack killswitch` | F4 杀手开关：30 天内 policy 是否被有效使用 |
| `osstack agent list` | 列出所有注册的子 agent + 能力 |

### 任务管理

| 命令 | 作用 |
|---|---|
| `osstack task submit <prompt>` | 提交任务，流式打印事件直到 terminal |
| `osstack task status <run_id>` | 任意时刻看任务现状 |
| `osstack task cancel <run_id>` | 取消运行中的任务（发 AbortSignal） |
| `osstack task observe <run_id> [seq]` | 从指定 cursor 重放事件 |

### 项目脚手架

| 命令 | 作用 |
|---|---|
| `osstack init [dir]` | 铺 OSBORN 项目骨架：`.agent/PROJECT_CONTEXT.md`、`docs/{PRD,ARCHITECTURE,SPRINTS}.md`、`AGENTS.md`、`tasks/`（V1 osb-init 的 V2 等价） |

### Hermes 集成

| 命令 | 作用 |
|---|---|
| `osstack hermes health` | Hermes 桥配置 + 可达性检查 |
| `osstack hermes dashboard` | 浏览器打开 Hermes WebUI（默认 `http://127.0.0.1:8787`） |
| `osstack hermes register-cron` | 打印 `hermes cron add` 配方供你复制 |

### 外部 skill 注册表

| 命令 | 作用 |
|---|---|
| `osstack skills list` | 列出跟踪的外部 skill 仓库 |
| `osstack skills add <id> <origin> [ref]` | 增加新源 |
| `osstack skills remove <id>` | 移除源 |
| `osstack skills check` | git ls-remote 对比 blessed_sha 是否漂移（exit 2 = 有漂移） |
| `osstack skills bless <id>` | 把当前 origin HEAD 锁为可信版本 |

### V1 兼容

| 命令 | 作用 |
|---|---|
| `bash legacy-python/install-v1-shims.sh` | 安装 11 个 V1 命令的 shim 到 `~/bin/`（osb-init 等会路由到 V2，其余仍走 V1 Python） |

---

## 八、配置（环境变量）

osstack 完全用环境变量配置——**没有传统配置文件**（除 `~/.osstack/skills.config.yaml` 是 skill 注册表，可手编辑）。

### 路径

| 变量 | 默认值 | 作用 |
|---|---|---|
| `OSSTACK_HOME` | `~/.osstack` | 数据根目录（SQLite、日志） |
| `OSSTACK_SOCKET` | `~/.osstack/daemon.sock` | daemon Unix socket 路径 |
| `OSSTACK_CODEX_BIN` | `codex` | codex 二进制路径 |

### Hermes 集成（默认全关）

| 变量 | 默认值 | 作用 |
|---|---|---|
| `HERMES_HOME` | `~/.hermes` | Hermes 数据根目录 |
| `HERMES_BIN` | 自动探测 | hermes 二进制路径 |
| `HERMES_KANBAN_BOARD` | **未设** | **设了**就启用 kanban sync（默认关，避免污染你的 board） |
| `HERMES_WEBUI_HOST`/`HERMES_WEBUI_PORT` | `127.0.0.1` / `8787` | dashboard 命令打开的 URL |

### GBrain 知识图谱（默认关）

| 变量 | 默认值 | 作用 |
|---|---|---|
| `OSSTACK_GBRAIN` | `0` | 设 `1` 启用每 run 写 gbrain page |
| `OSSTACK_GBRAIN_BIN` | `gbrain` | gbrain 二进制路径 |

### OpenTelemetry（默认关）

| 变量 | 默认值 | 作用 |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | **未设** | 设了就启用 OTel/HTTP trace 导出，每个 RPC 一个 span |

### Claude / Codex 认证

| 变量 | 默认值 | 作用 |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Claude SDK 直连 key；不设则尝试用 Hermes auth |

**重要约定**：所有跨产品集成（Hermes kanban / GBrain / OTel）**默认都是关的**，环境变量设了才打开。这是为了避免新用户莫名其妙踩到副作用。

---

## 九、几种典型工作流

### 9.1 个人开发：终端直接跑 Claude Code

```bash
osstack task submit "重构 src/auth.ts，把回调改成 async/await，加 vitest 测试"
# → policy 自动挑 claude-code（test 任务它强）
# → 流式输出 token.delta / tool.started / tool.done / done
# → SQLite 记录 run + tokens + duration
osstack stats     # 看刚才那次任务的指标
```

### 9.2 通过 Hermes 派单（手机 / 任意 surface）

Telegram → Hermes bot：「osstack 跑一下：升级我的 ESLint 配置」
→ Hermes session 加载 osstack skill
→ 远程调你 Mac mini 的 daemon
→ Claude Code 或 Codex 执行
→ 结果通过 Hermes 通知系统回 Telegram

### 9.3 自动定期跑

通过 Hermes cron：
```bash
hermes cron add --schedule "0 9 * * 1" --name weekly-pr-review -- \
  osstack task submit "审查我所有 PR 队列里的代码"
```

或纯系统 crontab：
```cron
0 9 * * 1  /usr/local/bin/osstack task submit "审查 PR"
```

### 9.4 多 agent 路由 + 学习

```bash
osstack task submit "..." --kind code.refactor
# policy 在 claude-code 和 codex-cli 之间选
# 累积几十个 run 后，policy 自动学到哪个 adapter 在 refactor 上更稳
osstack stats     # per-agent 成功率一目了然
```

### 9.5 跨设备协同（Mac mini ↔ MacBook Pro）

- osstack daemon 跑在 Mac mini（永远开机）
- MacBook Pro 通过 SSH tunnel 或 Hermes WebUI 远程调
- 不需要 osstack 在两台机器都装——daemon 只跑在一台

---

## 十、可观测性与运维

- **日志**：daemon stderr 写 `~/.osstack/logs/daemon.error.log`（launchd 配置）。Pino 结构化 JSON。
- **指标**：`osstack stats` 现成；OTel 导出可加（设 `OTEL_EXPORTER_OTLP_ENDPOINT`）。
- **任务历史**：直接 `sqlite3 ~/.osstack/state.db`；表结构见 [`packages/core/src/state/migrations.ts`](packages/core/src/state/migrations.ts)。
- **杀手开关**：30 天内 policy 触发 < 30 次时 `osstack killswitch` 返回 exit 2，可挂监控。
- **崩溃恢复**：launchd KeepAlive 自动拉起；socket 启动时清理 stale；任务 step-level checkpoint 在 `runs.last_step` 字段。
- **优雅停机**：SIGTERM → 终止所有 active run（发 AbortSignal）→ 关闭 SQLite → 删 socket → 退出。

---

## 十一、安全与隐私

- **PII 脱敏（G2）**：所有 prompt 入库前过 `PIIRedactor`，7 个默认 pattern（email / phone / SSN / IPv4 / Anthropic key / OpenAI key / AWS key），**ReDoS 防护 100ms 预算**。模式集合手编审核避免回溯爆炸。
- **静态加密**：依赖 macOS FileVault（v1.0）；SQLCipher 留作 v1.x 可选项。
- **API key 管理**：复用 Hermes auth pooled credentials（D17），osstack 不自己存 key。
- **Socket 权限**：`~/.osstack/daemon.sock` 强制 `0600`，只有本用户能连。
- **磁盘满兜底（G1）**：每次写库前 preflight，剩余空间 < 100 MiB 直接拒写 + 抛 `DiskFullError`——**永不静默丢任务**。
- **沙箱**：Codex CLI adapter 默认 `--sandbox read-only`，要写文件得显式提权。

---

## 十二、当前状态与下一步

### 已交付（v2/typescript 分支，2026 年 5 月）

- ✅ Sprint S0-S6 全部完成
- ✅ 13 commits 推到 `origin/v2/typescript`
- ✅ 55/55 tests 通过
- ✅ 端到端 live 在 Mac mini 验证：Claude SDK、Codex CLI、Hermes kanban、GBrain page render、git ls-remote、policy 决策、cancel、observe replay

### 设计上明确推迟

- skill-registry 的 LLM ingester / PR proposer / npm batcher——等有真外部 skill 要消化再做
- approval / clarify 主动暂停-恢复流——持久化已就位，等 adapter 真发起 approval 再活化
- 失败学习自动调权——攒几周真数据再改 policy
- 中文生态 4 个 adapter（DeepSeek / MiniMax / Kimi / DeepCode）——按真实需求加

### 你下一步应该做的

1. `bash packages/cli/launchd/install.sh` 把 daemon 装为 launchd 服务（自启 + 崩溃自拉起）
2. 在一个真项目里挂 osstack 用一周，让 policy 攒数据
3. 一周后看 `osstack stats` + `osstack killswitch`，验证项目经理 Agent 在你工作流里值不值这碗饭

---

## 十三、仓库结构

```
osbstack/
├── docs/V2_REFACTOR_PLAN.md           # CEO + Eng Review 双 cleared 计划（18 决策）
├── legacy-python/                      # V1 全部代码 + 安装脚本归档
├── packages/
│   ├── cli/                            # osstack 二进制：daemon + RPC + CLI 子命令
│   ├── core/                           # 调度引擎：state/policy/privacy/observability/kg/hermes
│   ├── agents/                         # AgentAdapter 接口 + claude-code + codex-cli
│   ├── hermes-adapter/                 # Hermes Run Adapter Contract（13 事件 + 7 控制 + 10-status FSM + framing）
│   ├── skills/                         # 生命周期 skill 模板（osstack init 等）
│   ├── plugins/                        # 7 槽位插件（runtime/agent/workspace/tracker/notifier/reviewer/verifier）
│   ├── skill-registry/                 # 外部 skill ingestion（S6 manifest + watcher）
│   └── runtime/                        # Zellij 5-tab workspace（V1 osb-runtime 保留）
├── hermes-skill/                       # Hermes skill 源，符号链到 ~/.hermes
│   ├── SKILL.md
│   └── scripts/
│       ├── osstack_bridge.py           # Python ↔ daemon Unix socket 桥
│       └── osstack_install.sh          # 软链安装器
└── README.zh.md                        # 你正在读的这份
```

---

## 许可

MIT — 见 [LICENSE](LICENSE)。
