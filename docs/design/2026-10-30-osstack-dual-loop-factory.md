# OSStack v3：双循环软件工厂的内循环——技术产品设计

日期：2026-10-30。状态：v2，已按 Codex（gpt-6.1-sol）审计与挑战修订（见 §10）。
上位文档：[2026-10-26 Firstmate 升级路线图](2026-10-26-firstmate-upgrade/README.md)（24 个 FM 能力、R/C/E/I/X 工作包、S0–S6 切片）、[上游增量](2026-10-30-firstmate-upstream-delta/README.md)、[运行模型](2026-10-30-firstmate-upstream-delta/operating-model.md)。本文不重复它们，只给出目标、取舍、当前状态和接下来的落地顺序。

## 1. 目标

把 OSStack 改造成高度自动化软件工厂的**内循环**：给它一个工程目标，它能在本机受控地调查、派发执行器、隔离实施、验证、交付到 PR，并在用户离开时持续监督、等待有归属、决策能闭环、中断可恢复。将来再与一个独立的**外循环**（PR 层的外部验证系统）对接，形成双循环。

三条约束贯穿全文：

1. **抽取 Firstmate 的能力，不复制它的形态。** 用户结果、权威、恢复和保全语义是兼容目标；海事术语、tmux 布局、Markdown 私有状态不是。
2. **保留 OSStack 已有的强项**（§3），并修掉已发现的不合理处（§4）。
3. **合并权在人。** PR 由用户人工批复与合并；任何循环都不获得合并 main 的权限。

## 2. 双循环的分工与接口

| | 内循环（本文范围） | 外循环（后期，另行建设） |
|---|---|---|
| 职责 | 把事做出来、做对：编排、隔离、监督、恢复、本地验证、交付到 PR | 独立确认做对了：PR 层验证、工程纪律检查、风险评估 |
| 位置 | 用户机器，有工作区写权限 | GitHub PR 层，只读或只写 check/评论 |
| 权威 | OSStack 的 typed authority 与账本 | 不持有权威，只产出证据 |
| 合并 | 不合并 main | 不合并 main |

**接口契约（内循环现在就按此产出，外循环将来按此消费）：**

- 内循环开 PR 时附带机器可读的**交付证据**：仓库与 PR 编号、head 与 base SHA、证据 schema 版本、验证命令与结果、迁移变化、受保护路径变化、关联 Mission ID、证据摘要。PR 描述是可变文本，只作展示；权威副本存在内循环账本，按 head SHA 绑定。
- 外循环的结论只有同时满足以下条件才被读取：来自登记的生产者身份（check run 的 app/账号）；绑定当前 head 与 base SHA；schema 版本已知；在有效期内；按（PR、head、生产者、结论 ID）去重，新推送使旧结论失效。不满足即忽略并记录。
- 结论是**提议**，不是指令：可以提出修复工作，但派发前重新校验 Mission 范围与当前授权；**绝不执行结论中携带的命令**；不能触发合并、发布或授权变化（路线图 RD-03）。
- **往返上限**：同一 PR、同一 Mission 的“要求修改 → 修复”最多 2 轮。计数持久化在内循环账本中，原子消费，重启后可重放；新建替代 Mission 继承原计数；超过即转为用户决策项。
- 本期只定义契约与证据格式；外循环的实现、上线与权限不在本期。

## 3. 保留的强项

| 能力 | 位置 | 在内循环中的角色 |
|---|---|---|
| Loop Engineering（发现、执行、验证、反馈、预算、worktree 隔离） | `packages/loop` | 主要执行引擎之一 |
| Graph 运行时与受限验证 | `packages/graph`、`graph-contained-*` | 第二执行引擎与受限验证底座 |
| Guarded delivery / guarded git | `packages/github`、`packages/cli/src/guarded-git*` | 交付到 PR 的权威通路 |
| Attention（决定、投递、姿态、监督、提醒、回归简报） | `packages/core/src/state/attention-*`、`packages/cli/src/supervision-service.ts` | 持续监督与决策闭环的核心 |
| Engineering store（Mission、事件、派发许可、会话采纳） | `packages/core/src/state/engineering-*` | 任务账本 |
| 控制面守卫、scratch 纪律、性能预算 | `control-plane-guard.ts`、`scratch.ts`、AGENTS.md | 自举与安全底线 |
| neat / probe / knowledge hygiene | 各自包 | 保留，不在本期改造范围 |

## 4. 要修复的不合理处（已实测）

| ID | 问题 | 证据 | 处理 |
|---|---|---|---|
| D1 | 每个迁移需手改约 10 处（迁移登记、两个 schema 限定区间、期望表、测试断言、4 个 worker 模块清单） | 迁移 48、49 的实际改动 | 运行模型 §3：派生机械部分，两个限定区间保持独立审查 |
| D2 | CLI 测试隔离未清除 `OSSTACK_SOCKET`，可连到真实 daemon | `test-setup-hermetic-home.ts`、`paths.ts:23` | 测试 setup 清除；子进程统一清洗环境 |
| D3 | 被追踪的 `packages/knowledge/dist` 与源码不同步（main 的 `dist/index.js` 缺少 context-budget 导出） | main 16 个被追踪文件 | 停止追踪 dist；保证消费者（包入口、`build-knowledge-cloud-publish-catalog.mjs`）前有构建步骤；`prepack` 只检查不构建，需补构建 |
| D4 | 发布相关 workflow 仍用 `macos-14`（2026-11-02 下线） | `release.yml`、`macos-release-candidate.yml` | 换 `macos-15` |
| D5 | 监督服务被接管后 daemon 无反应；空闲旧服务最长 30 秒才停；扫描错误被吞掉 | supervision-parity 文档 | daemon 健康检查读取 `takenOver`；错误计数进入 `osstack stats` |
| D6 | 执行器自行提交并留下干净工作区时，清理会删分支，提交只剩 reflog | main `worktree.ts:93`、`:128` | 清理前比较分支与起点，有新提交即保留 |
| D7 | Loop 成功后调用 `mergeWorktree`，快进**当前检出分支**；这与“合并权在人”冲突 | main `loop-engine.ts:1230`、`worktree.ts:111` | 工厂模式禁止本地落地路径，只允许受控 PR 交付；本地落地保留为显式 opt-in，且固定目标分支与已接受提交。**在扩大无人值守执行之前完成** |
| D8 | 仓库约 230 个远端分支、290 个本地分支，大量已合并或已废弃 | `git branch -r` | §7 分支治理 |
| D9 | `docs/implementation` 与 `docs/design` 在 main 上新增约 99 万行文本 | `git diff --stat ce543535 origin/main` | 先分类：可执行输入（如 CI 读取的 `skills-check-map-maintenance/map.json`）、维护中的文档（README 链接）、大体积生成证据。只迁出第三类；迁出不缩小历史，属于整洁度改进，优先级低 |
| D10 | 两个测试在 Node 26 上因 `stripTypeScriptTypes({mode:"transform"})` 失败 | github `delivery.test`、cli `guarded-git-runtime.test` | 改用当前 Node 支持的方式，或在测试中明确版本条件 |
| D11 | pstack 方法包进入了 main 的核心：`method-context`、`osstack-methods-skill/`、方法导出/特性图/健康/旅程脚本及其 CI 步骤、bug-fix 编译；`protocol/joint` 中混有通用合同（`SourcePin`、`SourceSnapshot`、规范摘要）与方法合同。joint 合同早于 #288 | `git grep` main；`skill-registry/src/source-snapshot.ts:8` | §6 L1：先划边界再拆 |

## 5. 内循环能力路线与当前状态

| 切片 | 用户得到什么 | 已完成（PR） | 余下 |
|---|---|---|---|
| S0 来源与账本 | 分清已实现与已验证 | 行为合同与注册表（main 已有）、上游增量登记 | 能力映射与 fixture 的自动校验 |
| S1 影子主控 | 有理由的计划，暂不派发 | — | C03/C06 主控纯状态机与结构化计划 |
| S2 单仓库本地交付 | 给目标后自动完成受限工程结果 | 已实现未合入：交付保全（#321） | D6/D7；一条受限的单执行器 Mission 路径；E04 快速通道（运行模型 §1）；E01/E02 |
| S3 多执行器与并行 | 自动选 Loop/Graph，整合独立工作 | — | E05 资格后评分路由、E06 串行集成与重测 |
| S4 持续监督与记忆 | 离开、返回、改口不丢事 | 已实现未合入：逾期提醒（#318）、回归简报（#322）、接管即停（#320） | D5；X06 Calm 展示；I01 增量简报 |
| S5 远端与对外交付 | 委派远端、PR 追踪、承诺回执 | — | I03 交付等级证明；外循环接口（§2） |
| S6 升级与组合启用 | 更新后保留任务 | 升级门禁覆盖 48/49 | I04 演练、X08 工具检查 |

表中“已实现未合入”指代码与测试已完成、PR 为 draft、尚未进入 main。

**接下来的顺序（安全优先）：**
1. 测试隔离与 runner（D2、D4）。
2. 保住不在 main 中的补回提交，并修落地权限（D6、D7）。
3. 移植 Firstmate 小切片到 main（§6 L2）。
4. 一条受限的单执行器 Mission 路径（S2 核心，复用实际的受限执行，而非仅借用其绑定思路）。
5. 监督与恢复补齐（D5、S4 余项）。
6. 带认证的 PR 反馈接入（§2，外循环就绪后）。
7. 路由与并行（S1、S3）。
迁移人体工学（D1）、分支整理（D8）、文档整理（D9）、dist（D3）与 pstack 拆分（L1）独立推进，不阻塞以上安全项。

## 6. 落地到 main 的方案

现状：main 停在迁移 47，含 pstack 方法包。Firstmate 线从 `ce543535` 起：#317 已关闭未合并；#318、#319、#320、#321、#322 为 draft，是两组并列叠放（#320/#322 叠在 #318 上，#319/#321 叠在已关闭的 #317 分支上），迁移到 49。

**L2（先做）：Firstmate 切片按清单移植到 main，每个切片一个面向 main 的 PR。** 不合并整条线。落地清单：
1. **补回保全**：`ae27f078`（Codex 可写目录）、`e6d679e4`（diff 精确路径）及其 changeset `4afa5118`——这三项 main 中没有。#319 的其余补回（#291 smoke、#288 证据保留）main 已有，不再需要。
2. **逾期提醒**（迁移 48）：#318 的功能提交与修复提交。
3. **监督接管即停**：#320。
4. **回归简报**（迁移 49）：#322 的 `5c8e9653`、`e3d3d440`。`upgrade-native.test.ts` 在 #318 上已被 `66d0b967` 拆分，`5c8e9653` 改的是拆分前的写法，需手工解决该文件；`6fb4db1b` 与 `66d0b967` 重复，不取。
5. **交付保全**：#321（同时修 D7 的一部分）。
每个 PR：显式挑选提交（不含重复与补回），重新生成 inventory，跑完整质量门（§8）。三方合并预检显示 1、2、3、5 对 main 无文本冲突；4 依赖 2。对应 main PR 合并后关闭原 draft PR 并删分支。

**L1（独立推进，不阻塞 L2）：pstack 方法包移出核心，先划边界再拆。** 原则：pstack 在 OSStack 核心之外，以外部工具或可选提示包存在。审计结论：
- `execution-context` 是通用基础设施（提示与知识预算、合同绑定、取消、来源校验、回执），被 `deliver --execution-context`、受控交付、Graph 交付与验证使用——**保留**，只移除其中可选的方法钩子。
- `protocol/joint` 混有通用合同（`SourcePin`、`SourceSnapshot`、规范摘要，被 skill-registry 的来源检查与采纳使用）与方法合同；`bug-fix-compiler` 依赖 joint 合同；包导出了 `./joint`、`./joint-json` 子路径。需先把通用合同迁到中性模块并迁移消费者，再处理方法合同与导出（对外导出的移除按语义化版本处理）。
- 移除方法包时必须连同其构建与 CI 消费者一起处理：`packages/cli/tsup.config.ts` 中的 method-context 入口、`scripts/prepare-bug-fix-method.mjs`、方法导出/特性图/健康/准备/旅程检查与证据投影的 CI 步骤、相关 package 脚本、schema 生成检查与 fixtures。
L1 拆为两个 PR：L1a 迁移通用合同（无行为变化）；L1b 移除方法包及其构建/CI 消费者。每个 PR 先列出完整引用清单，再证明构建、类型、测试与 CLI 启动预算不回退。

**L3：迁移编号以 main 为准。** 运行模型 §3.2 适用。注意：现有表谱系检查只比较表名，不比较列、触发器或迁移内容，同号同表的不兼容历史可能通过；改号时需显式的分支/schema 身份，或经测试的转换/重建策略。

## 7. 分支治理

- 已合并进 main 的远端分支：删除（本地同名分支与对应 worktree 一并清理）。
- 未合并分支按类别处理：有开放 PR 的保留；pstack/joint 相关、已被新线取代的 Firstmate 旧分支（10-24 至 10-27）在 L1/L2 完成后删除；更早的 8 月实验分支先列清单，由用户确认后删除。不从分支名推断废弃，逐个核对其提交是否已被包含或取代，清单固定时间戳与引用。
- `changeset-release/main` 由发布流程管理，不删。
- 规则写入 AGENTS.md：功能分支在 PR 合并或关闭后删除；worktree 用完即移除（与现有 worktree 放置规则一致）。

## 8. 质量门与验证

每个面向 main 的 PR 都满足：`pnpm build`、`pnpm typecheck:check`、`pnpm lint`（0 错误）、inventory 新鲜度、受影响包测试、CLI 启动预算；涉及迁移的 PR 额外覆盖升级门禁与读模型区间；每个 PR 在开出前由 Codex（gpt-6.1-sol）评审，Claude 逐条核实后修复或记录驳回理由，结果写入 PR 描述。

## 9. 不做的事

- 不在本期建设外循环或给任何自动化合并权限。
- 不在 OSStack 内重写 agent 运行时（运行模型 §2）。
- 不照搬 Firstmate 的放宽权限默认值、远端 secondmate 与公开渠道（保持后期、默认禁用）。
- 不为兼容而保留已决定移出核心的 pstack 接线。

## 10. 交叉评审记录

v1 由 Codex（gpt-6.1-sol，medium，只读）审计：11 个 P1、3 个 P2，结论“批准前需修订：Firstmate 移植可行；L1 边界、执行权威与反馈契约尚不安全”。Claude 核对后采纳全部 P1：`execution-context` 为通用基础设施；`protocol/joint` 混有通用合同；L1 遗漏构建与 CI 消费者；L2 需显式挑选提交并处理 `upgrade-native.test.ts`；`ae27f078`、`e6d679e4`、`4afa5118` 不在 main 中；#317 已关闭、其余为 draft 且是两组叠放；反馈契约需身份、SHA、新鲜度、去重与持久往返计数；Loop 本地落地路径（D7）与“合并权在人”冲突，须先于无人值守执行修复；T0 需真正的写入代理或强制沙箱；表谱系检查不足以拒绝分支 home；D9 需分类后迁出。顺序按其建议改为安全优先（§5）。

