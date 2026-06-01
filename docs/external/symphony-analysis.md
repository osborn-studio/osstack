# OpenAI Symphony — 借鉴分析（长期跟踪）

> 上游：[openai/symphony](https://github.com/openai/symphony)
> 首次发布：2026-04-27
> 本分析版本：v1（基于上游 commit `bbef623`，2026-05-13）
> 跟踪状态：通过 `osstack skills` 注册，每周 cron `osstack skills check`

---

## 一、Symphony 是什么

Symphony 是 OpenAI 在 2026-04-27 开源的**编码 agent 编排规范**（不是产品）。两层：

- **`SPEC.md`**（2169 行）— 语言无关的规范文档，本体
- **Elixir 参考实现** — `elixir/` 子目录，依赖 OTP/BEAM 做并发与监督

核心模型：**把 Linear（或任意 issue tracker）当成 coding agent 的派单状态机**。每个 open ticket 一个 Codex agent，一个独立 workspace，跑到事完了为止。Symphony 是 scheduler + reader，**不主动改 ticket**——ticket 的状态迁移、PR 链接、评论由 agent 自己用工具写。

> 仓库标签为「low-key engineering preview for testing in trusted environments」。OpenAI 不打算把它当独立产品维护。

社区热度（拉取时）：⭐ 24.1K · 🍴 2.3K · 主要贡献者 Drew Hintz。

---

## 二、为什么 osstack 要研究它

Symphony 和 osstack 在**调度层的设计空间完全重合**：

| 同 | 异 |
|---|---|
| 编排多个 coding agent | Symphony 只支持 Codex；osstack 已支持 Claude Code + Codex，可扩展 |
| 持久化任务流 | Symphony 依赖 tracker（Linear）；osstack 用 SQLite + Hermes kanban |
| 每任务独立 workspace | Symphony 强制；osstack 支持 git worktree 但不强制 |
| State machine 驱动 | Symphony 显式给 11 个 Run 状态；osstack 现在只有 outcome 字段 |
| Workspace hooks（before/after） | Symphony 4 个 hook 点；osstack 还没 |
| 配置文件在 repo 里 | Symphony 用 `WORKFLOW.md`（YAML frontmatter + prompt）；osstack 用 env 变量 |

osstack 比 Symphony **多**：policy engine（多 agent 投票打分）、PII redactor、Hermes 集成、knowledge graph adapter、跨设备入口。
osstack 比 Symphony **少**：成熟的 state machine、tracker 抽象、workspace 隔离强制、stall 检测、hot reload。

---

## 三、可借鉴清单（按优先级排序）

### 🔴 HIGH — 应该尽快吸收

#### S-1. `WORKFLOW.md` in-repo 契约（YAML frontmatter + prompt 体）

Symphony 把"项目级配置 + agent prompt 模板"放在 repo 根的 `WORKFLOW.md`。这样：
- 项目用什么 agent、用什么模型、用什么 sandbox 模式、polling 频率——全部跟代码一起 version
- prompt 模板（含 Liquid 变量 `{{ issue.identifier }}`）也在 repo 里
- 升级配置不重启进程（hot reload，见下）

**osstack 怎么用**：扩展现有 `AGENTS.md` 加 YAML frontmatter，或新增 `OSSTACK.md`。daemon 启动 + 文件 watch 加载。

示例：
```yaml
---
osstack:
  default_kind: code.write
  max_concurrent: 5
  pii_redact_strict: true
  agents:
    code.write: codex-cli      # 项目级 policy override
    code.test: claude-code
  workspace:
    isolate: git-worktree
hooks:
  after_create: |
    pnpm install
  before_run: |
    pnpm typecheck
---
你正在贡献 osstack。约定：
- TS strict mode + zod schemas
- 测试在 packages/*/src/**.test.ts
- ...
```

实现成本：3-5 天（文件 watcher + YAML 解析 + 模板渲染 + 配合现有 PolicyEngine）。

#### S-2. Run Attempt Lifecycle 显式状态（11 个 phase）

Symphony 把单个 run 的执行分成 11 个明确阶段：

```
PreparingWorkspace → BuildingPrompt → LaunchingAgentProcess
→ InitializingSession → StreamingTurn → Finishing
→ {Succeeded | Failed | TimedOut | Stalled | CanceledByReconciliation}
```

每个阶段独立可观测、可重试、可告警。osstack 现在只有最终 `outcome` 字段，中间过程不可见。

**osstack 怎么用**：在 `runs` 表加 `phase` 字段（已有 lifecycle phase 但是粗粒度），细化为这 11 个 attempt 阶段；adapter 在每个阶段开始时 emit `progress` 事件。

实现成本：1-2 天。值在于以后 `osstack stats` 能告诉你"超时都卡在 LaunchingAgentProcess"——可执行的诊断信息。

#### S-3. Reconciliation Loop

Symphony 每个 poll tick：
1. 验证配置（如果失败，跳过本轮 dispatch，但 reconciliation 继续）
2. 重新对照 tracker 实时状态 → 停止那些 ticket 已经不活的 run
3. 取新候选
4. dispatch 直到 slot 耗尽

osstack daemon 现在是**响应式**的——有指令才动。没有自检/自愈循环。

**osstack 怎么用**：daemon 加个 60 秒 tick，做：
- 扫 active runs，对比 daemon 内存中的 `activeRuns` 与 SQLite `runs` 表，清孤儿
- 失败次数超阈值的 run 触发 handoff（已经有 killswitch 逻辑，扩展即可）
- 重启后从 SQLite 恢复"看似还在跑但已经孤儿"的 run，标记为 `CanceledByReconciliation`

实现成本：2-3 天。这一步把 daemon 从"无脑代理"升级成"有内务管理的服务"。

---

### 🟡 MEDIUM — 战术性吸收

#### S-4. 多 turn 复用同一 session（不是 spawn-per-turn）

Symphony 让一个 agent worker **连续跑多个 turn**，在同一个 Codex thread 里：
- 第一个 turn 用完整 prompt
- 后续 turn 只发"继续干"的 continuation guidance
- 直到 `max_turns`（默认 20）或 issue 不再 active

省 token、省冷启动。

**osstack 怎么用**：扩展 `AgentTask` 加 `max_turns` 字段；adapter 在每个 turn 完成后检查"任务真的完了吗"，没完就再 turn。Claude Agent SDK 的 `resume: sessionId` 正好支持这种模式（我们 S1 文档已经提过）。

实现成本：3 天（每个 adapter 单独改）。

#### S-5. Stall Detection（事件不活跃检测）

`codex.stall_timeout_ms`（默认 5 分钟）— orchestrator 监控事件流，如果 N 分钟没收到新 event，杀掉 agent + retry。

osstack 现在没有这个保护——如果 Claude SDK 因为某种原因卡住（不报错也不出 event），daemon 会无限等。

**osstack 怎么用**：daemon 在 `appendEvent` 时记录 last-event-time per run；reconciliation tick 时对比，超时则 abort + retry。

实现成本：1 天。和 S-3 配合做最方便。

#### S-6. Workspace 强制隔离 + Hooks

Symphony 4 个 workspace hook：
```
after_create   # 新 workspace 第一次创建（如：git clone）
before_run     # 每次 turn 开始前（如：pnpm install）
after_run      # 每次 turn 结束后（如：pnpm test）
before_remove  # workspace 被清理前（如：归档 artifacts）
```

加上 `hooks.timeout_ms`（默认 60s）防 hook 卡死。

osstack 的 `@osstack/plugins` 已经预留了 `workspace` 槽位（D11 设计阶段定的 7 槽位之一），但没实装。

**osstack 怎么用**：实装 `WorkspacePlugin` 接口，签名借鉴 Symphony 这 4 个 hook。让 OSSTACK.md（S-1）能配置 hook 内容。

实现成本：2-3 天（接口 + 默认 git-worktree 实现 + 跟现有 task.submit 集成）。

---

### 🟢 LOW — 知道有这事但不急

| 项 | Symphony 怎么做 | osstack 何时考虑 |
|---|---|---|
| Tracker 抽象 | `Tracker` 接口 + Linear adapter；3 个必需操作（fetch_candidates / fetch_by_states / fetch_state_by_ids） | 我们用 Hermes kanban 已经够；将来如果要接 GitHub Issues / Jira / Linear，照搬这个接口 |
| Hot reload | 文件 watcher + 失败保持 last known good | 与 S-1 配套做 |
| 错误类别枚举 | 12 个 normalized error category（codex_not_found / response_timeout / turn_timeout / port_exit / ...） | 我们已有 `OsstackError/AgentError`，按这个清单扩 |
| 状态分桶并发限制 | `agent.max_concurrent_agents_by_state` map（例：In-Progress 限 5、Review 限 2） | 工作量大、收益小，等真有需求 |
| Client-side tool 扩展 | `linear_graphql` tool 让 agent 通过 Symphony 的 auth 反查 Linear | 我们的等价物：Hermes MCP server，已经存在 |
| Phoenix LiveView dashboard | 内置 web UI on :4000 | 不做 — Hermes WebUI 已经管这块 |
| SSH worker | 跨机器分发 agent | 暂不做 — D16 已经把跨设备协同推给 Hermes |

---

## 四、不借鉴的部分（明确）

- **Linear API binding**：osstack 不绑 Linear。Hermes kanban 是默认。
- **Phoenix dashboard**：复杂、和 Hermes WebUI 重复。
- **Elixir BEAM 并发**：Node async/await + Unix socket 在我们的负载下绰绰有余。
- **SSH worker**：跨机器调度的复杂性远超个人项目所需。
- **Symphony 的 prompt 设计**：高度 Linear-shaped；我们的 prompt 模板更通用。

---

## 五、Skill-Registry 跟踪

Symphony 已经通过 osstack 自己的 skill-registry 注册：

```yaml
# ~/.osstack/skills.config.yaml
sources:
  - id: openai-symphony
    name: OpenAI Symphony (Codex orchestration spec + Elixir reference)
    origin: https://github.com/openai/symphony.git
    ref: main
    blessed_sha: bbef623...
    notes: 借鉴方向：S-1 WORKFLOW.md / S-2 phase lifecycle / S-3 reconciliation / S-4 multi-turn / S-5 stall / S-6 hooks
```

跟踪策略：

```bash
# 手动检查（任何时候）
osstack skills check                    # 全量看哪些源 drift 了
osstack skills check | grep symphony    # 只看 symphony

# 自动检查（推荐 Hermes cron 每周一次）
hermes cron add --schedule "0 9 * * 1" --name osstack-symphony-watch -- \
  bash -c 'osstack skills check 2>&1 | grep -E "(symphony|drift)" | head -5'
```

当 symphony drift 报告出现时：

1. `git -C /Users/osborn/Developer/_external-refs/symphony pull`
2. 看 changelog / 新 commits（`git log blessed..HEAD --oneline`）
3. 如果 SPEC.md 有变化，更新本分析文档
4. `osstack skills bless openai-symphony` 锁新版本

---

## 六、未来的 commit-watch protocol

每次本分析文档被 review/refresh 时，记录在下面这个表里。便于看出 Symphony 演进节奏，决定我们要不要跟。

| 日期 | 上游 commit | Symphony 关键变化 | osstack 是否吸收 |
|---|---|---|---|
| 2026-05-18 | `bbef623` | 初版分析（PR description lint workflow） | 7 项候选已列出，未实施 |
| 2026-05-20 | `2c18518` | **`#66` Surface input-blocked sessions** — orchestrator + dashboard 增加"等待用户输入"可见性（+750/-71 行，主要在 `orchestrator.ex` + `dashboard_live.ex` + `presenter.ex`）。SPEC.md 未变。 | 与我们 S2 的 approval/clarify 框架同方向。等 V2.1 实施 S-2 phase lifecycle 时一并对齐 UI 暴露 |
| _(下次更新)_ | _(SHA)_ | _(待填)_ | _(待填)_ |

---

## 七、推荐的实施顺序

如果决定吸收，按这个顺序最省力（每步都有可独立交付的价值）：

1. **S-2 phase lifecycle**（1-2 天）→ 立即提升 `osstack stats` 诊断力
2. **S-5 stall detection**（1 天）→ 立刻去掉 daemon 永远 hang 的风险
3. **S-3 reconciliation loop**（2-3 天）→ 自愈能力质变
4. **S-6 workspace hooks**（2-3 天）→ 用户可自定义 git/pnpm/test 流
5. **S-1 OSSTACK.md 配置**（3-5 天）→ 项目级 policy override（最大产品级飞跃）
6. **S-4 multi-turn session**（3 天）→ token 省 + 体验提升

总计 ~12-17 天 human time，CC+gstack 压缩到 3-5 天。

可以放进 V2.1（GA 后第一个迭代）。

---

## 八、参考

- 上游仓库：<https://github.com/openai/symphony>
- 规范：<https://github.com/openai/symphony/blob/main/SPEC.md>
- OpenAI 发布博客：<https://openai.com/index/open-source-codex-orchestration-symphony/>
- 本地 clone：`/Users/osborn/Developer/_external-refs/symphony/`
- osstack 计划同步：[docs/V2_REFACTOR_PLAN.md](../V2_REFACTOR_PLAN.md)
