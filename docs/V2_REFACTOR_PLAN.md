# OSBORN stack (osstack) V2 重构方案 — Draft for Review

> Status: **DRAFT v0.6** — Plan Eng Review 完成，工程层 3 个决策落地 (E1-E3)，2 个 CRITICAL GAP 加进 S1 验收
> Author: Osborn + Claude（Opus 4.7）
> Date: 2026-05-16

---

## ✅ CEO Review 决策摘要（v0.4 累加）

| # | 决策 | 选择 | 影响 |
|---|---|---|---|
| D1 | osstack 身份 | **项目经理 Agent**（非纯编排器） | 必须有 policy / memory / learning 三层 |
| D2 | Sprint 顺序 | **分段建造，每层有真数据** | Sprint 1-2 先跑数据，Sprint 3 才写 judgment |
| D3 | Hermes 状态 | **已存在，有现有接口** | osstack 适配 Hermes，Sprint 1 前置需要拿到 Hermes spec |
| D4 | V1 命令兼容 | **保留 shim** | 11 个老命令名继续可用，背后调 V2 |
| D5 | 升级模式 | **包级 npm semver + daemon restart from checkpoint** | Sprint 1 必须实现 checkpoint 恢复；不需要进程内热加载复杂度 |
| D6 | 外部 skill 抽象处理 | **半自动（normalize → PR 提案 → 首次人审 → 后续小版本自动）** | 需要 skill-registry 模块、PR 通道（GitHub Actions 或本地）、版本签名 |
| D7 | Watch 触发 *（默认）* | 每日 cron 检查 + `osstack skills check` 手动 | 沿用 gstack-update-check 模式，1 天延迟可接受 |
| D8 | Skill 来源白名单 *（默认起步）* | GStack / SuperPower / Everything Claude / Anthropic Skills | `~/.osstack/skills.config.yaml` 显式扩展 |
| **D11** | **集成模型**（v0.4 新增） | **C：osstack = Hermes 的 skill/plugin** | 装到 `~/.hermes/skills/software-development/osstack/`；借力 Hermes cron/memory/messaging |
| **D12** | **实现语言**（v0.4 新增） | **C-TS-Bridge：主体 TS + Python 薄 skill wrapper** | TS daemon（npm 发布）+ Python skill `osstack_bridge.py`（subprocess + JSON-line stdio）|
| **D13** | **skill-registry 范围**（v0.4 新增） | **保持 v0.3 全量** | 接受与 Hermes skills 双轨成本；osstack 是外部 TS 生态 → Hermes Python 生态的 normalize 桥梁 |
| **D14** | **可观测性深度**（v0.5 新增） | **中等：OTel 导出 + Hermes kanban + pino** | 不部 Grafana；Sprint 5 加 `@opentelemetry/sdk-node`，导出 OTLP；用户可后接 Tempo/Jaeger/Honeycomb |
| **D15** | **WeChat 派单**（v0.5 新增） | **v1.0 不做** | Telegram via Hermes 已够；未来用多了再走 OpenClaw 集成 |
| **D16** | **跨设备协同**（v0.5 默认） | **osstack 仅 Mac mini，借力 Hermes 跨设备** | 零代码工作；文档加"双设备工作流" recipe |
| **D17** | **API key 管理**（v0.5 默认） | **复用 `hermes auth` pooled credentials** | osstack 不存自己一份 key；轮换由 Hermes 管 |
| **D18** | **PII 脱敏**（v0.5 默认） | **必做，跨 Sprint** | Sprint 1 加 `PIIRedactor` 中间件（`presidio-analyzer` 或轻量正则）；prompt/log 入库前过滤 |
| **D19** | **静态加密**（v0.5 默认） | **v1.0 依赖 macOS FileVault** | v1.x 评估 SQLCipher（仅 multi-user 场景必要） |
| **D20** | **知识图谱**（v0.5 新增） | **用 GBrain（不自建）** | Sprint 5 加 `GBrainAdapter` 50-100 行；每个 run 写 page，gbrain self-wire 实体边 |
| **E1** | **Capability schema 标准**（v0.6 Eng） | **Zod schema** | TS 原生体验，编译期发现错误；导出 JSON Schema 供 Python wrapper 用 |
| **E2** | **Policy DSL**（v0.6 Eng） | **TS 函数 + 优先级打分** | 每条规则 = `(task, history) => Score \| null`；可单测、可外部调 lib |
| **E3** | **LLM Eval harness Sprint 位置**（v0.6 Eng） | **S3 随 policy engine 一起** | 数据驱动，eval case 从 S1-S2 真实记录抽取；S1-S2 期间 prompt 改动靠 code review 兜底 |

## 🔄 v0.4 重大转向摘要

**之前（v0.3 及更早）的关键假设**：
- osstack 是独立 daemon，自带 HTTP+SSE，Hermes 通过 JSON-RPC 调用
- 自建 cron / memory / messaging / dashboard
- TS-only 生态

**v0.4 现实**：
- Hermes 是完整的 self-hosted Agent，已有 40+ CLI 子命令、launchd 服务、MCP server、cron、kanban、memory、dashboard
- Hermes 本身已能编排 Claude Code / Codex（无需中介）
- Hermes 的所有 skill 全是 Python（采样 20+ 个，零反例）
- Hermes 有完整的 [Run Adapter Contract RFC](file:///Users/osborn/hermes-webui/docs/rfcs/hermes-run-adapter-contract.md)：13 个事件家族 + 7 类控制 + reconnect 语义

**故 osstack 的实际定位**：
- 是**软件开发生命周期专项 skill**——Hermes 的 dev-task 大脑
- **借力 Hermes**：cron / memory / messaging / dashboard / kanban / checkpoint
- **专心做 Hermes 不做的**：项目经理判断 (policy)、跨任务历史 (memory schema 复用 Hermes 但表层加 dev-specific)、子 agent 路由、生命周期编排、外部 TS skill 生态 normalize

**裁掉的 V0.1 内容**：
- ❌ 6 个 adapter 全列入 S0-S5 → 改为：S1 只写 claude-code，S2 加 codex-cli，其余推迟到"有真实需求"
- ❌ Hermes 协议由 osstack 单方面定义 → 改为：先拿 Hermes 现有 spec，osstack 适配
- ❌ "TS 化全部 V1 命令"是终点 → 改为：V2 同时提供 shim，让老脚本不破

**新增的 V0.1 缺失内容**：
- ➕ policy engine（判断该用哪个 agent）
- ➕ cross-task memory（历史哪个 agent 擅长哪类任务）
- ➕ failure learning（失败案例反哺判断）

---

## 0. 一行定义（v0.4 修订）

**OSBORN stack（osstack）是 Hermes Agent 的一个软件开发生命周期专项 skill/plugin。技术上：一个 TypeScript 写的常驻 daemon + 一个 Python skill wrapper（`~/.hermes/skills/software-development/osstack/`），Hermes 调用 wrapper、wrapper 通过 stdio JSON-line 与 daemon 通信。osstack 负责"项目经理 Agent"职责：判断该用哪个子 agent（Claude Code / Codex / 其他）、记忆任务历史、学习失败案例、把外部 TS skill 生态（GStack / SuperPower / Everything Claude）normalize 成 Hermes Python skill 格式。**

---

## 1. 战略转向（V1 → V2）

V1 文档明确写"不做 Hermes 集成、不做多 agent 调度、不做自治"——V2 把这条边界推开。V1 在本地用了一段时间，已经验证：
- **真正的瓶颈不是单个 agent 的能力，而是 Workflow Manager 缺失**（V1 自己也总结过这一点）
- 人工搬运上下文太累，需要常驻 agent 接住 Hermes 的指令

| 维度 | V1 osbstack | V2 osstack |
|---|---|---|
| 形态 | 11 个独立 shell 命令 | **CLI Agent（可常驻进程）** |
| 角色 | 工具集 | **项目经理 Agent** |
| 语言 | Python stdlib + bash | **TypeScript / Node.js LTS ≥20** |
| 入口 | 人手敲命令 | **Hermes Agent 下发 → osstack 调度** |
| 编排对象 | DeepSeek（review/verify） | **Claude Code / Codex / DeepSeek TUI / DeepCode / MiniMax / KimiCode** |
| 生命周期 | 命令拼接 | **YAML workflow + checkpoint 持久化** |

---

## 2. 不重复造轮子：直接 Fork + 借鉴

经过开源社区调研，确定基础栈：

### 2.1 内核：Fork [moazbuilds/CodeMachine-CLI](https://github.com/moazbuilds/CodeMachine-CLI)
- npm 安装、Node.js 18+
- 已经实现：YAML workflow、agent pool、step 依赖、parallel group、context passing、retry/fallback、incremental checkpoint、`workflow resume`
- 已经支持的 engine：Claude Code、OpenAI Codex、Cursor（headless）
- **Fork 后我们补**：Hermes RPC 接入、中文生态 4 个子 agent（DeepSeek/DeepCode/MiniMax/Kimi）的 adapter、osstack 项目模板、Zellij runtime

### 2.2 子 agent 调用：[@anthropic-ai/claude-agent-sdk](https://github.com/anthropics/claude-agent-sdk-typescript)
- TS SDK 自带 Claude Code 二进制 → 不用单独装
- `query()` 返回 `AsyncIterable<Message>` → 直接桥接 SSE
- 内建 Hook（PreToolUse / PostToolUse / SessionStart / SessionEnd）→ 落审计日志
- Subagent 通过 `agents` option 声明 + 工具白名单
- Session 通过 `resume: sessionId` 续接
- **明确不要做**：spawn Claude Code CLI 进程（用 SDK 更稳）

### 2.3 三层 API 抽象：仿 [larksuite/cli](https://github.com/larksuite/cli)
```
Shortcuts (osstack +ship)    ← 用户高频日常组合
    ↓
Skills (osstack design.prd)  ← 单一职责的 capability
    ↓
Raw Adapter (osstack agent.invoke claude-code --prompt ...)  ← 最底层
```

### 2.4 插件槽位：仿 [ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator)
7 个可插拔槽位（每个一个 TS interface + `PluginModule` 默认实现）：
| 槽位 | 作用 | 默认实现 |
|---|---|---|
| Runtime | 子进程隔离 | tmux on macOS |
| Agent | 编码 agent | claude-code |
| Workspace | 工作区隔离 | git worktree |
| Tracker | 任务追踪 | local sqlite |
| Notifier | 通知 | macOS desktop |
| Reviewer | 评审 | deepseek |
| Verifier | 对齐校验 | deepseek |

---

## 3. 技术栈（已决策）

| 关注点 | 选择 | 理由 |
|---|---|---|
| 语言/运行时 | **TypeScript / Node.js ≥20** | 用户要求 |
| 包管理 | **pnpm workspaces** monorepo | CodeMachine + Composio 共同选择 |
| CLI 框架 | **Commander.js** | 成熟、TS 友好、零仪式 |
| 子进程 | **execa**（仅非-SDK 场景） | 流式 stdio、信号处理 |
| HTTP 服务 | **Hono + SSE** | 轻、快、Bun/Node 通吃 |
| 协议 | **JSON-RPC 2.0 over HTTP** | Hermes 友好 |
| 存储 | **better-sqlite3** | 同步、嵌入式、查询快 |
| 日志 | **pino** | 结构化 JSON |
| Schema | **zod** | 协议与配置同源 |
| 测试 | **vitest** | 比 jest 快、ESM 原生 |
| 打包 | **tsup**（esbuild） | 秒级构建 |
| Claude 调用 | **`@anthropic-ai/claude-agent-sdk`** | 官方 SDK |
| Workflow 引擎 | **fork CodeMachine-CLI 内核** | 不重复造 |

---

## 4. 架构（v0.4 双形态）

### 4.1 形态 A：Hermes Skill 包（Python 薄包装）

```
~/.hermes/skills/software-development/osstack/
├── SKILL.md                       # Hermes skill manifest (YAML frontmatter + Markdown body)
│                                   # name: osstack, description: "Use when: 软件开发任务...
│                                   # version 与下方 TS daemon 的 npm package 同步
├── scripts/
│   ├── osstack_bridge.py          # 主 entry — Hermes import 此模块
│   │                                 # 1. 探测 osstack daemon 是否运行
│   │                                 # 2. 不在则 spawn `osstack serve --daemon`（launchctl 自动拉起更佳）
│   │                                 # 3. 用 socket / pipe 发 JSON-line 请求到 daemon
│   │                                 # 4. 流式接收 daemon 事件，转 Hermes Run Adapter event format
│   ├── osstack_install.py         # 安装：检测 Node.js、npm install -g @osstack/cli、注册 launchctl
│   └── osstack_health.py          # health check (Hermes doctor 命令的入口)
├── references/
│   ├── capability_schema.md       # osstack 内部 capability schema 定义
│   ├── lifecycle_phases.md        # 10 阶段生命周期
│   └── hermes_event_mapping.md    # osstack 内部事件 → Hermes Run Adapter event 映射表
└── templates/
    └── osborn_project.yaml        # OSBORN 项目模板（V1 osb-init 等价）
```

### 4.2 形态 B：TS Monorepo（osstack core daemon，npm 发布）

```
osstack/                            # GitHub: gilosbornhello/osstack
├── packages/
│   ├── cli/                       # @osstack/cli — `osstack` 二进制
│   │   └── src/
│   │       ├── bin.ts             # commander 主入口
│   │       ├── commands/          # task / agent / skills / runtime / serve / stats / shim ...
│   │       ├── daemon.ts          # `osstack serve` 常驻进程（launchctl-managed）
│   │       └── bridge-server.ts   # ✨ NEW: Unix socket / named pipe server for Python bridge
│   │
│   ├── core/                      # @osstack/core — 编排引擎
│   │   └── src/
│   │       ├── workflow/          # YAML 解析、step 执行、checkpoint（S4+ 才补）
│   │       ├── lifecycle/         # discover → design → arch → plan → code → review → test → build → release → retro
│   │       ├── orchestrator/      # 能力 → 子 agent 路由
│   │       ├── policy/            # judgment engine — 选哪个 agent + 何时升级到人
│   │       ├── memory/            # cross-task memory — 谁擅长什么类型任务
│   │       ├── learning/          # failure learning — 失败案例反哺 policy
│   │       ├── privacy/           # ✨ NEW (v0.5/D18): PIIRedactor 中间件 + presidio 包装
│   │       ├── observability/     # ✨ NEW (v0.5/D14): OTel sdk-node 初始化 + 自定义 metrics
│   │       ├── kg/                # ✨ NEW (v0.5/D20): GBrainAdapter — 任务事件 → gbrain page
│   │       ├── state/             # SQLite repo（tasks/runs/events/agents）
│   │       └── events/            # 事件总线 → SSE
│   │
│   ├── agents/                    # @osstack/agents — 子 agent 适配器
│   │   └── src/
│   │       ├── base.ts            # AgentAdapter 接口
│   │       ├── registry.ts        # 能力 + 成本注册
│   │       └── adapters/
│   │           ├── claude-code.ts # 用 @anthropic-ai/claude-agent-sdk
│   │           ├── codex-cli.ts   # spawn codex CLI（headless）
│   │           ├── deepseek-tui.ts
│   │           ├── deepcode.ts
│   │           ├── minimax.ts
│   │           └── kimicode.ts
│   │
│   ├── hermes-adapter/            # ✏️ RENAMED from hermes-rpc — Hermes Run Adapter Contract 实现
│   │   └── src/
│   │       ├── event-envelope.ts  # 13 个事件家族的 zod schema（照 RFC）
│   │       ├── controls.ts        # 7 类控制：observe/status/cancel/queue/approval/clarify/goal
│   │       ├── replay.ts          # at-least-once replay + Last-Event-ID/after_seq cursor
│   │       ├── status-fsm.ts      # 11 个 status: queued→running→completed/failed/cancelled/...
│   │       └── stdio-server.ts    # Unix socket / stdio 协议层（Python bridge 接入点）
│   │
│   ├── skills/                    # @osstack/skills — 三层架构的中间层
│   │   └── src/
│   │       ├── design/{prd, review, brief}
│   │       ├── architecture/{sync, adr}
│   │       ├── plan/{task, sprint}
│   │       ├── review/{ds-review, ds-verify}
│   │       └── release/{check, runbook}
│   │
│   ├── plugins/                   # @osstack/plugins — 7 槽位插件
│   │   └── src/{runtime, agent, workspace, tracker, notifier, reviewer, verifier}
│   │
│   ├── skill-registry/            # ✨ NEW (S6): @osstack/skill-registry — 外部 skill 集成与升级
│   │   └── src/
│   │       ├── watcher/           # 监控 GStack/SuperPower/Everything Claude 等仓库的新 release
│   │       ├── ingester/          # 拉源 → 解析 SKILL.md → 抽取能力描述（半自动 normalize）
│   │       ├── proposer/          # 生成集成 PR（首次集成） / 自动合入（小版本）
│   │       ├── batcher/           # 累积 N 个 skill 更新 → 触发 osstack 自己的 npm release
│   │       ├── manifest/          # 维护 skills.config.yaml + 锁定版本
│   │       └── compat/            # 集成后兼容性测试（capability schema 是否破坏）
│   │
│   └── runtime/                   # @osstack/runtime — Zellij 工作区
│       ├── layouts/aimate.kdl     # 5-tab，V1 保留
│       └── src/launcher.ts
│
├── apps/
│   └── dashboard/                 # （P2 之后）Web 监控面板
│
├── legacy-python/                 # V1 capabilities/ 归档于此（git mv）
│
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── package.json
└── README.md
```

---

## 5. 核心抽象

### 5.1 AgentAdapter 接口
```ts
export interface AgentAdapter {
  readonly id: AgentId;                       // 'claude-code'
  readonly capabilities: Capability[];        // ['code.write', 'code.review', 'design.prd']
  readonly cost: CostProfile;                 // { tier: 'high'|'mid'|'low', tokensPerMin? }
  isAvailable(): Promise<boolean>;
  invoke(task: AgentTask): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
}
```

### 5.2 生命周期阶段机
```
Discover → Design → Architecture → Plan → Code → Review → Test → Build → Release → Retrospect
   ↑                                                                                    ↓
   └─────────────────────── feedback loop ─────────────────────────────────────────────┘
```
每阶段定义：输入契约、可调用 capabilities、退出标准、人工 gate 点。

### 5.3 Hermes 集成协议（v0.4 修订：照搬 Hermes Run Adapter Contract）

**通信路径**：
```
Hermes session
    ↓ (Python import)
~/.hermes/skills/software-development/osstack/scripts/osstack_bridge.py
    ↓ (Unix socket: ~/.osstack/daemon.sock)
osstack daemon (TS, launchctl-managed)
    ↓ (in-process)
core/orchestrator → agents/claude-code → @anthropic-ai/claude-agent-sdk
```

**事件协议**（照搬 [Hermes Run Adapter Contract RFC](file:///Users/osborn/hermes-webui/docs/rfcs/hermes-run-adapter-contract.md)）：

事件 envelope（13 个家族共用）：
```json
{
  "event_id": "run_123:42",
  "seq": 42,
  "run_id": "run_123",
  "session_id": "20260514_...",
  "type": "tool.updated",
  "created_at": 1778750000.0,
  "terminal": false,
  "payload": {}
}
```

13 个事件家族：`run.started` / `status` / `token.delta` / `reasoning.delta` / `reasoning.done` / `progress` / `tool.started` / `tool.updated` / `tool.done` / `approval.requested` / `approval.resolved` / `clarify.requested` / `clarify.resolved` / `title.updated` / `usage.updated` / `usage.final` / `error` / `done`

7 类控制：`observe` / `status` / `cancel` / `queue/continue` / `approval` / `clarify` / `goal`

11 个 status：`queued` / `running` / `awaiting_approval` / `awaiting_clarify` / `paused` / `cancelling` / `cancelled` / `failed` / `completed` / `expired`

Reconnect：`Last-Event-ID` / `after_seq` cursor、at-least-once replay、dedup by `(run_id, seq)`

---

## 6. 分阶段交付（v0.4 Hermes-skill 修订版）

| Sprint | 时长 | 目标 | 关键产出 | 前置依赖 |
|---|---|---|---|---|
| **S0** | 2-3 天 | 双仓库脚手架 + Hermes skill manifest | (a) pnpm monorepo 骨架 + tsup + vitest；(b) `~/.hermes/skills/software-development/osstack/SKILL.md` v0；(c) Python `osstack_bridge.py` Hello World；(d) 验证 Hermes 能加载并调到 daemon | Hermes Run Adapter Contract RFC（✅ 已拿到） |
| **S1** | 1.5 周 | 单 agent 闭环 + Hermes 事件契约 + PII + 两条 CRITICAL GAP | (a) claude-code adapter（`@anthropic-ai/claude-agent-sdk`）；(b) memory schema（SQLite WAL + Hermes home 检测）；(c) **完整实现 13 个 Hermes 事件家族 + 7 类控制 + 11 status FSM**；(d) Python bridge ↔ TS daemon Unix socket（length-prefixed framing）；(e) `osstack stats` 命令；(f) **PIIRedactor 中间件 + ReDoS 防护**（CRITICAL GAP-2）；(g) **SQLite disk full 兜底** = preflight 检查 + 写失败 → Hermes 通知（CRITICAL GAP-1）；(h) launchctl plist + KeepAlive + stale socket cleanup（F1） | S0 |
| **S2** | 3-4 天 | judgment 有 2 选 1 + 控制完整 | (a) codex-cli adapter；(b) basic capability routing；(c) **完整实现 7 类控制**（cancel/approval/clarify 等） | S1 |
| **S3** | 1 周 | judgment 层（规则版） | policy engine + 基于 S1-S2 真实任务记录的规则集 + handoff gate（升级人审） | S2（需要真数据） |
| **S4** | 3 天 | Hermes 高级集成 | 注册 Hermes cron 任务、Hermes kanban 同步、Hermes dashboard 嵌入 | S3 |
| **S5** | 1.5 周 | 学习层 + V1 迁移 + shim + 杀手开关 + 可观测 + 知识图谱 | failure learning + V1 11 个命令的 TS skill 实现 + 老命令名 shim + F4 kill switch + **OTel sdk-node 集成（D14）** + **GBrainAdapter（D20，每 run 写 page）** | S4 |
| **S6** | 1.5 周 | Skill 集成与升级机制（全量） | skill-registry 6 个子模块：watcher / ingester (TS→Python SKILL.md normalize) / proposer / batcher / manifest / compat | S5 |
| **S7+** | TBD | 按需扩展 | 中文 CLI adapter（DeepSeek/MiniMax/Kimi/DeepCode）按真实需求加 | 真实使用证据 |

**关键变更说明（v0.4 修订）**：
- **新增** S0 双形态脚手架：Python bridge skill + TS daemon
- **S1 加重**：必须完整实现 Hermes 13 个事件家族（Hermes WebUI 已依赖此契约）
- **S2 加重**：完整 7 类控制（approval/clarify 是 Hermes 工作流核心）
- **S4 改变**：原"Hermes HTTP+SSE 升级"删除（不再需要 HTTP，走 Unix socket + Hermes skill 系统）；改为"深度集成 Hermes（cron + kanban + dashboard）"
- **S5 加 F4**：杀手开关首次成为 Sprint 级别交付物
- **S6 加重**：skill-registry 仍是 v0.3 全量（D13）+ 新增 TS→Python SKILL.md normalize 输出

总计：约 5.5-6.5 周 human time，CC+gstack 压缩到 11-16 天

---

## 7. 仓库与命名（v0.4 修订 — 双仓库策略）

### 仓库 1：TS daemon 主仓库
- **位置**：现 `gilosbornhello/osbstack` 开 `v2/typescript` 分支
- `git mv capabilities/ legacy-python/`
- 主目录建 TS monorepo
- 保留完整 git 历史
- V2 ship 后打 tag `v1-final` 后 merge 到 main
- npm 发布：`@osstack/cli` + workspace packages

### 仓库 2：Hermes skill（薄包装）
- **位置**：与 Hermes skill marketplace 集成（提交到 hermes-agent skills/ 或自建独立仓库分发）
- 内容：SKILL.md + 3 个 Python scripts（共 < 200 行）
- 安装：用户 `hermes skills install osstack` 或 git clone 到 `~/.hermes/skills/software-development/osstack/`

### 命名
- **TS CLI 二进制**：`osstack`（在 `~/bin/`）
- **Hermes skill 名**：`osstack`
- **npm scope**：`@osstack/*`
- **Python wrapper 模块**：`osstack_bridge`

### 配置目录
- `~/.osstack/`（TS daemon 自管）
  - `config.yaml`
  - `state.db`（SQLite）
  - `logs/`
- `~/.hermes/skills/software-development/osstack/`（Hermes 管理）
  - `SKILL.md` + `scripts/`
- 桥接：daemon 启动时探测 `HERMES_HOME` 环境变量，无则用 `~/.hermes` 默认

---

## 7.5 外部 Skill 集成与升级机制（v0.3 新增）

### 7.5.1 数据流图（happy path）

```
   外部 skill 仓库                  osstack skill-registry              osstack core
  ┌────────────────────┐         ┌───────────────────────────┐      ┌──────────────────┐
  │ GStack/SuperPower/ │         │ watcher (cron daily)       │      │ policy engine    │
  │ Everything Claude/ │ ──tag──▶│   ↓                         │      │   ↑              │
  │ Anthropic Skills   │         │ ingester (read SKILL.md +  │      │ capability       │
  │ ...                │         │   abstract via LLM)         │      │ registry         │
  └────────────────────┘         │   ↓                         │      └──────────────────┘
                                  │ proposer:                   │              ▲
                                  │   - first time? open PR     │              │
                                  │   - minor bump? auto merge  │              │
                                  │   ↓                         │              │
                                  │ batcher (累 ≥3 个 skill 更新)│              │
                                  │   ↓                         │              │
                                  │ release: bump @osstack/*    │              │
                                  │   ↓                         │              │
                                  │ user: `npm i -g`            │──reload─────▶│
                                  │   daemon 从 checkpoint 恢复 │              │
                                  └───────────────────────────┘              │
```

### 7.5.2 阴影路径（shadow paths）

| 路径 | 触发 | 处理 |
|---|---|---|
| 上游仓库消失 | GitHub repo 404 | watcher 标记为 stale，30 天不可达自动从 manifest 移除 |
| SKILL.md 解析失败 | LLM 抽出格式无效 | proposer 不生成 PR，落 error log，下次 cron 重试 |
| 新版本破坏 capability schema | 输入/输出契约变了 | compat 模块拦截：标 BREAKING，强制人工审 |
| 用户拒绝 PR | reviewer 关 PR | manifest 记录 skip-until-version，下次跳到 N+2 再试 |
| daemon 升级中收到 Hermes 指令 | 临时不可用 | Hermes 收到 503 + Retry-After 头；任务排队 |

### 7.5.3 与已锁决策的交互

- **D1（项目经理 Agent）**：每集成一个新 skill = 给 policy 加一个候选 capability。policy 必须 graceful 处理"没历史数据的新 capability"——默认低权重，逐步学习。
- **D2（分段建造）**：S6 是独立 sprint，不阻塞 S1-S5 主线
- **D5（包级升级）**：batcher 触发的是 npm release，符合 D5
- **F1（单点故障）**：升级期间 daemon 重启窗口 = 单点故障窗口。launchctl/PM2 自动拉起 + Hermes Retry-After = 用户无感
- **F4（杀手开关）**：新 skill 如果触发率持续为 0，也走 30 天 kill switch 流程

### 7.5.4 关键约束（写进代码契约）

1. **零中断保证 = SLA 而非强保证**：升级窗口 < 60s 重启 + Hermes 排队；不承诺真正 zero-downtime
2. **签名机制**：每个 normalize 后的 skill manifest 必须带 sha256 + 来源 commit hash，防 supply chain 攻击
3. **回滚通道**：`osstack skills rollback <skill> <version>` 必须能在 30 秒内切回上版本
4. **首次集成强制人审**：不靠 LLM 自信度判定，统一走 PR

---

## 8. 风险与开放问题（v0.3 修订）

### 8.1 已识别风险
| 风险 | 影响 | 缓解 |
|---|---|---|
| 未拿 Hermes spec 前盲启 S1 | **高** | S0 阻塞项：先拿到 Hermes 现有接口文档/代码再开 S1 |
| judgment 层无数据冷启动 | 高 | S1-S2 强制运行 ≥10 个真实任务积累数据，S3 才动 policy engine |
| 失败学习 (S5) 反馈环失控（policy 自我强化偏差） | 中 | learning 改写 policy 必须经人 review gate；保留 manual override |
| **新 skill 引入恶意/破坏性能力**（D6） | **高** | 强制签名 + 首次集成 PR 人审 + compat schema 校验 + sandbox 集成测试 |
| **batcher 累积过多变更，一次发版 risk 过大**（D6） | 中 | 单次 release 累积 skill 更新 ≤5；超出强制拆分发版 |
| LLM normalize 出错导致 capability 描述错误（D6） | 中 | proposer 必须把"LLM 抽取"与"原始 SKILL.md"双栏 diff 给人审 |
| daemon restart 窗口 in-flight 任务丢失（D5） | 中 | Sprint 1 必须实现 task checkpoint + Hermes Retry-After 协议 |
| **Hermes 升级破坏 osstack skill 加载**（D11/v0.4） | **高** | osstack 在 SKILL.md 显式声明 hermes_min_version；Hermes 大版本升级时跑兼容性测试 |
| **Unix socket 通讯失败/僵尸 daemon**（D11/v0.4） | 中 | Python bridge 加 healthcheck + retry + 启动时清理 stale socket |
| **Python wrapper 与 TS daemon 版本漂移**（D12/v0.4） | 中 | SKILL.md 显式声明 daemon_npm_version；不一致时 bridge 拒启动 |
| **PII redactor 误杀正常代码字段**（D18/v0.5） | 中 | redactor 默认 conservative；提供 `allowlist` 字段（如代码标识符 `userId`、`emailFormat`）；落审计 log 让人核 |
| **OTel 导出无人接 = 写盘膨胀**（D14/v0.5） | 中 | OTel SDK 用 BatchSpanProcessor + 默认 OTLP endpoint 检测；无可达 endpoint 时自动 disable 并告警，不静默积压 |
| **GBrain 升级破坏 page schema**（D20/v0.5） | 低 | 在 `core/kg/` 加 schema 版本探测；不兼容时跳过 KG 写入而不阻塞主任务 |
| **复用 hermes auth 的 key 失效**（D17/v0.5） | 中 | osstack 启动时跑 `hermes auth status` 校验；失败给出明确指引"`hermes login anthropic`" |
| CodeMachine fork 风险已规避 | — | v0.2 不再 fork，自建 workflow 引擎（S4+ 才需要），Claude Agent SDK 已覆盖大部分 |
| V1 shim 长期维护成本 | 中 | 在 6 个月后做退役评估；shim 只是别名，不复制逻辑 |
| Zellij 在常驻 daemon 下的兼容性 | 低 | runtime 是可选模块，daemon 不依赖 |

### 8.2 已通过 CEO Review 的决策（v0.2 锁定）
- ✅ **身份** = 项目经理 Agent（D1）
- ✅ **Sprint 顺序** = 分段建造（D2）
- ✅ **Hermes 状态** = 已存在，osstack 适配（D3）
- ✅ **V1 兼容** = 保留 shim（D4）

### 8.3 CEO + Eng Review 新发现

| # | 发现 | 必须在哪里落地 |
|---|---|---|
| F1 | **单点故障**：daemon 死掉 Hermes 任务全丢 | Sprint 1 配 launchctl KeepAlive + stale socket cleanup + `/health` 端点 |
| F2 | **耦合提前**：memory schema 是 S1 的事，不是 S3 | v0.2 已写入 — Eng Review 复核 schema 字段完整性 |
| F3 | **没指标 = 5 月后说不清值不值得** | Sprint 1 加 `osstack stats` 命令；指标定义先列出来 |
| F4 | **杀手开关缺失** | S5 学习层附带：30 天 policy < 30 次自动告警/退役 |
| **G1** | **SQLite disk full 静默任务丢失**（v0.6 Eng CRITICAL） | Sprint 1：每次 write 前 preflight 磁盘空间；< 100MB 拒写 + Hermes 通知 |
| **G2** | **PII redactor 正则可被 ReDoS 致 daemon hang**（v0.6 Eng CRITICAL） | Sprint 1：用 `re2` 库（线性正则）+ 单 redact 超 100ms 报警 |

### 8.4 Eng Review 已落地的工程默认（v0.6）

| # | 原开放问题 | Eng 落地 |
|---|---|---|
| 1 | memory schema 字段 | task_id, run_id, session_id, agent_id, capability_id, phase, outcome, started_at, completed_at, duration_ms, tokens_in, tokens_out, retry_count, human_intervention_count, pii_redacted_count, gbrain_page_id, hermes_session_id（zod schema 定义 in `core/state/schema.ts`） |
| 2 | policy DSL | **E2: TS 函数 + 优先级打分** |
| 3 | failure learning trigger | 阈值默认：连续 3 次同类任务 < 50% 成功率 → flag 升级人审；30 次记录后才允许自动调权 |
| 4 | SQLite WAL | **默认开启**：`journal_mode=WAL` + `synchronous=NORMAL` + 64MB cache；单 connection per daemon |
| 5 | Hermes stdin 协议格式 | **Length-prefixed framing**：4-byte BE 长度 + JSON payload（与 LSP/MCP 一致） |
| 6 | observability 起点 | **D14: 中等 OTel 导出**；Sprint 1 仅 pino，Sprint 5 加 OTel sdk-node + BatchSpanProcessor |
| 7 | capability schema 标准 | **E1: Zod**（导出 JSON Schema 供 Python wrapper 用） |
| 8 | 首次集成 PR 通道 | 默认本地 `osstack skills review` TUI + 可选 GitHub Actions 镜像 PR；未来 Hermes 远端 approval 通过 Hermes kanban |
| 9 | LLM normalize 用哪个模型 | 默认 Claude Haiku 4.5（成本低 + 结构化输出好）；fallback 到 DeepSeek-V3 |
| 10 | checkpoint 粒度 | **Step-level**：每个 lifecycle 阶段一个 checkpoint；event-level 太重，task-level 太粗

---

## 9. Definition of Done（V2.0 GA）

- [ ] `npm i -g @osstack/cli` 全局安装
- [ ] `osstack serve` 启动常驻进程，监听 Hermes 指令
- [ ] 6 个子 agent adapter 全部 `isAvailable()` 返回 true（在 Mac mini 上）
- [ ] Hermes 远程提交 "写一个 React 待办应用" → osstack 完整跑通 design → code → review → test
- [ ] checkpoint 续跑：kill -9 后 `osstack workflow resume` 能从断点继续
- [ ] V1 的 11 个命令全部有 V2 等价 skill 实现
- [ ] 测试覆盖率 ≥70%
- [ ] README + ARCHITECTURE.md + HERMES_PROTOCOL.md 三份核心文档完整

---

## 10. 下一步

CEO Review 完成（v0.2）。接下来：
1. **Plan Eng Review** — 锁死架构、错误处理、测试、部署、性能（待执行）
2. 与用户对齐：拿到 Hermes 现有 spec
3. 修订至 v1.0（Eng Review 后）
4. 启动 S0 脚手架

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR | 18 决策锁定 (D1-D8 + D11-D20) + 4 新发现 (F1-F4) + Hermes-skill 双形态 |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 3 工程决策 (E1-E3) + 2 CRITICAL GAP (G1-G2) 进 S1 + 10 开放问题全部落工程默认 |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | SKIP | 无 UI scope |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | OPTIONAL | 可选第三方独立审 |

**UNRESOLVED:** 无（CEO + Eng 所有决策已锁）
**VERDICT:** **CEO + ENG CLEARED v0.6 — ready to implement**

---

## 11. PartnerOS 垂直整合 — Milestone 1 完成（2026-05-24）

> 上游：[gilosbornhello/partneros-mvp](https://github.com/gilosbornhello/partneros-mvp) commit `4dbca76`
> 完整分析：[docs/external/partneros-analysis.md](external/partneros-analysis.md)
> 整合路径：**路径 A** — PartnerOS 作为 osstack 的垂直 skill 包族

### 11.1 已交付的包

| 包 | LOC | 测试 | 角色 |
|---|---|---|---|
| `@osstack/partneros-core` | ~700 | 27 ✓ | Intent FSM (11 状态)、Zod schema、Hermes 状态映射、Intent Markdown 渲染（纯函数）+ 文件写入器 |
| `@osstack/partneros-templates` | ~250 | 11 ✓ | 7 个行业 YAML 工作流模板（law × 2 / fund × 2 / family_office × 2 / advisory × 1）+ 推断器 |
| `@osstack/partneros-agents` | ~900 | 13 ✓ | 6 个 `PersonalityAgentAdapter`（Elon/Jobs/Qian/Linus/Turing/Bezos）实现 `@osstack/agents.AgentAdapter`；ROLE.md 提示词内核 + FNV-1a fingerprint；HermesEvent 流式输出 + AbortSignal 取消 |
| `@osstack/partneros-engine` | ~350 | 7 ✓ | 编排器：把 4 个包绑成完整 `process(text + template)` 循环；支持人工审批 + memory_facts 反馈环 |

### 11.2 已增强的现有包

| 包 | 变更 |
|---|---|
| `@osstack/core/capability` | 加 14 个新 CapabilityKind（`intent.*` / `client.*` / `matter.*` / `risk.*` / `artifact.*` / `memory.*` / `approval.request` / `verify.acceptance`）；router KIND_SET 同步 |
| `@osstack/core/state` | 加 `memory_facts` 表（migration #2）+ Zod `MemoryFactRow` + CRUD 模块（5 测试）；复用 disk-full preflight (G1) |

### 11.3 关键设计决策

| ID | 决策 | 理由 |
|---|---|---|
| **D21** | 6 个 agent 走 `runDirect()` 同步路径（不流 HermesEvent）做编排 | MVP 阶段 deterministic logic < 10ms；流式编排留给 LLM 接入时 |
| **D22** | Memory store 是接口而非具体 SQLite 实现 | 测试可用 in-memory；生产由 `@osstack/core/state/memory` 提供；不强制 daemon 启动 |
| **D23** | Intent Markdown 渲染器纯函数 + Node-only fs 写入器分离 | renderer 可在测试 / browser preview 复用，writer 是 Node 实现 |
| **D24** | 模板用 YAML 文件 + Zod 校验，目录按 industry 分桶 | 与 Symphony S-1 借鉴清单（OSSTACK.md YAML frontmatter）合流；目录与 YAML 内 industry 字段双重校验 |
| **D25** | PartnerOS 不直接用 osstack `runs` 表 | partneros-engine 自管 EngineRunReport；未来接 daemon 时再桥接 |

### 11.4 测试矩阵（端到端验证）

完整 happy path 测试（`partneros-engine/engine.test.ts`）覆盖：

- ✅ Fund LP follow-up → 6 个 agent 串行 → `awaiting_approval`
- ✅ Prompt injection → Turing block → `blocked`
- ✅ 每个 agent_run 携带 prompt fingerprint
- ✅ Memory feedback loop：第 1 轮 approve("Make it warmer") → 第 2 轮 Linus draft 自动温和
- ✅ 审批三态：approved → completed / rejected → rejected / revision → revision_requested
- ✅ 非法 approval（如 blocked 状态尝试 approve）→ FSM throw

**总计**：`partneros-*` 4 个包 58 测试 + 加固后的 core 37 测试 + cli 3 测试 = **98 tests passing**，所有包 typecheck clean。

### 11.5 还没做的（剩下的 7 项）

从 [partneros-analysis.md §五](external/partneros-analysis.md) 的 12 项清单看，已完成 1-5 + 11，剩下：

| # | 项 | 优先级 |
|---|---|---|
| 6 | workflow_templates 合并 OSSTACK.md frontmatter | 中（已有 YAML 方案，本质相通） |
| 7 | risk_check 工具变 osstack `Turing` adapter 内置能力 | 中（Turing 已经做 risk_check，但还不能被外部 capability 单独调） |
| 8 | revision_requested 状态加入 osstack Hermes FSM（已在 partneros FSM） | 低 |
| 9 | Approval Desk Web UI | 中（Telegram + Hermes 已能跑） |
| 10 | 多租户 `tenant_id` 列 | 低（等真有第二个用户） |
| 12 | PartnerOS Hermes skill 注册到 `~/.hermes/skills/...` | 中 |

### 11.6 D-21 ~ D-25 已纳入决策表

待 CEO 复审是否需要：(a) 把 PartnerOS 编排接到 osstack daemon hot loop；(b) 把 6 个 personality 升级到真 LLM-backed（@anthropic-ai/claude-agent-sdk）。两者都不破坏现有 deterministic 测试矩阵。

---

## 12. PartnerOS 垂直整合 — Milestone 3 完成（2026-05-25）

四项扩展全部落地。整 monorepo 现在跑 **154 单测 + 23 Hermes-skill smoke** 全绿。

### 12.1 新增 / 加强的包

| 包 | 状态 | 测试 | 关键能力 |
|---|---|---|---|
| `@osstack/partneros-agents` | 增强 | 30 ✓（+17） | 新增 `runRiskCheck()` 纯函数 + `RiskCheckAdapter`（cost_tier=low）作为 `risk.check` 独立可调能力；Turing 内部复用同一函数，行为字节级一致 |
| `@osstack/core/state` | 增强 | 40 ✓（+3） | Migration #3：`memory_facts` 和 4 张运行表加 `tenant_id` 列；`readFactsForSubject(..., { tenant_id })` API；NULL tenant 是默认 |
| `@osstack/partneros-core` | 增强 | 27 ✓ | Intent schema 加 `tenant_id` 字段（nullable）；intent markdown 渲染相应输出 |
| `@osstack/partneros-engine` | 增强 | 9 ✓（+2） | `process({ tenant_id })` + `approve()` 全链路 tenant 透传；engine 测试包含跨 tenant 隔离断言 |
| **`@osstack/partneros-hermes-skill`** | 新 | smoke 23 ✓ | SKILL.md（Hermes frontmatter）+ Python `run.py` / `approve.py` / `list-templates.py` + Node bridges + `install.sh`。Telegram → 6-agent run → approval 全跑通 |
| **`@osstack/partneros-approval-desk`** | 新 | 14 ✓ | Node `http` 服务器 + 单文件 HTML UI；`partneros-approval-desk` 二进制；REST API：`GET /api/intents`, `POST /api/intents/:id/decide`；Bearer-token 鉴权 |

### 12.2 关键设计决策（D26-D30）

| ID | 决策 | 理由 |
|---|---|---|
| **D26** | `risk.check` 拆为单独的 `RiskCheckAdapter`（cost_tier=low），Turing 复用同一纯函数 | 让 policy router 把 "只想风险审查" 的调用路由到便宜路径；Turing 仍是完整 verification pipeline |
| **D27** | `tenant_id` 全部 nullable，默认 NULL = "default tenant" | 单租户安装零修改向后兼容；多租户时显式 stamping，跨 tenant 读永远走索引 |
| **D28** | Hermes skill 走 Python wrapper + Node bridge 二段式 | 与现有 `~/.hermes/skills/*` 全 Python 入口风格一致；不重写 TS engine；隔离故障域 |
| **D29** | Approval Desk 用 `node:http` + 单文件 HTML，零运行时依赖 | 不引入 Next/Vite/React 编译链；< 800 行 TS + 内嵌 vanilla JS；产品化时再考虑 SPA |
| **D30** | Approval Desk 直接 mutate intent markdown 文件，不开新数据库 | partneros-engine MVP 的 source of truth 就是 .md；保持单一存储路径；未来 daemon 接入时换 SQLite |

### 12.3 端到端验证（实际运行过）

通过实际启动 `partneros-approval-desk` 监听 `127.0.0.1:4717`：

- ✅ `/healthz` 返回 `ok`
- ✅ `/api/intents` 列出 3 个真实 intent markdown（两个 blocked + 一个 completed）
- ✅ HTML 页面渲染 PartnerOS Approval Desk
- ✅ 通过 `bridge.mjs` 创建的真实 intent 自动出现在 desk 中

通过 Hermes skill smoke：

- ✅ SKILL.md frontmatter 解析、name/description/version/tags 都对
- ✅ happy path：`stdin JSON` → `awaiting_approval` + `intent_markdown_path` 写盘
- ✅ blocked path：prompt injection 文本 → `status=blocked, risk_level=high, triggered_rule_ids=[prompt_injection]`
- ✅ list templates：7 个 YAML 模板全部上报
- ✅ approve-bridge：FSM 合法 transition + .md 文件 in-place 重写

### 12.4 路径 A 状态总结

[partneros-analysis.md §五](external/partneros-analysis.md) 12 项清单 → 完成 11 / 12：

| # | 项 | 状态 |
|---|---|---|
| 1 | `@osstack/partneros-core` 包 | ✅ Milestone 1 |
| 2 | 扩展 capability kinds | ✅ Milestone 1 |
| 3 | 6 个 AgentAdapter | ✅ Milestone 1 |
| 4 | `memory_facts` 表 | ✅ Milestone 1 |
| 5 | Intent Markdown skill | ✅ Milestone 1 |
| 6 | workflow_templates YAML | ✅ Milestone 2 |
| 7 | risk_check 独立可调 | ✅ Milestone 3 |
| 8 | revision_requested 状态 | ✅ Milestone 1（FSM 已有） |
| 9 | Approval Desk Web UI | ✅ Milestone 3 |
| 10 | 多租户 tenant_id | ✅ Milestone 3 |
| 11 | 行业模板（law/fund/family_office/advisory） | ✅ Milestone 2 |
| 12 | PartnerOS Hermes skill | ✅ Milestone 3 |

**剩余可选增强（非阻塞）**：
- LLM-backed 6 个 personality（接 `@anthropic-ai/claude-agent-sdk`）
- partneros-engine 接入 osstack daemon hot loop（持久化 EngineRunReport 到 SQLite）
- Approval Desk 加 WebSocket 推送（目前是 30s 轮询）
