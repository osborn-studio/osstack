# Firstmate 抽取的运行模型：快速通道、执行器边界、迁移与自举

日期：2026-10-30（v2，按 Codex gpt-6.1-sol 交叉评审修订）。适用范围：Firstmate→OSStack 抽取线（`codex/firstmate-pure-baseline` 及其上叠分支）。本文是后续切片共同遵守的约束；外部 PR 验证器不在本期范围内，PR 由人工批复与合并。

## 0. 为什么需要这份约束

抽取 Firstmate 的目标是让 OSStack 更有用，而不是更重。四个已出现的成本要先收住：

1. 小改动也走完整 Mission/授权，开销大于改动本身。
2. 有向 OSStack 内部重写 agent 运行时的倾向；Firstmate 本身并不这样做。
3. 每个迁移要手改多处，且本线迁移号与 main 分叉。
4. 开发中的 OSStack 无法安全地管理自己的开发。

v1 的评审结论是“实施前需修订”：T0 缺少授权边界与写前约束、迁移收拢会破坏已运行分支迁移的 home、管理 home 并不自动受保护。v2 的修订见各节“v1 问题”。

## 1. 有界直接操作（E04 快速通道）

**原则：授权按风险分级，记录按事实保留；分级判定在写入之前，diff 检查只是第二道。**

| 档位 | 进入条件（全部满足） | 流程 |
|---|---|---|
| T0 直接操作 | 隶属一个已授权 Mission（只免逐步授权，不免归属）；在绑定的 worktree 内；只写**普通文本文件**的允许清单路径；不触及保护集合；单步与累计都在上限内 | 不逐步询问；写前登记意图，写后跑固定验证，写收据 |
| T1 轻量任务 | 超出 T0 上限，但在同一 Mission 已授权范围内，不触及保护集合 | 复用该 Mission 授权，不重复询问；写入与验证控制同 T0（代理或沙箱、受限验证），只是不受规模上限 |
| T2 完整流程 | 触及保护集合，或合并、发布、删除、凭证、跨仓库、远端 | 显式授权 + 同候选验证 |

**写入必须经过代理或强制沙箱（v2 评审）。** 在执行器拥有 shell 的情况下，路径分类器可以被绕过；`realpath` 检查也挡不住检查与写入之间的替换竞态。因此 T0 只能在两种方式之一下运行：写入由 OSStack 主机侧代理执行（原子、路径安全、基线不可变、收据由主机生成），或执行器运行在强制沙箱中（只挂载该 worktree 可写）。两者都不具备的执行器没有 T0，只能走 T1/T2。

**写前约束（v1 问题：只在写后检查）。** T0 的每次写入先过分类器：
- 只允许对**已跟踪或新建的普通文本文件**的内容写入；拒绝符号链接、硬链接、改名、模式变化、二进制、被忽略路径（如 `dist/`、数据库、`control-plane.json`）以及 worktree 外的任何路径。
- 路径解析后必须仍在 worktree 内（`realpath` 校验），拒绝 `..` 与链接逃逸。
- 观察模式与现有策略门禁照常生效（`packages/cli/src/policy-gate.ts`）。

**累计上限（v1 问题：多个小步可累积成大改动）。** 上限针对同一 Mission 内 T0 的**累计** diff（相对 Mission 起点，而非上一步），基线不能被执行者重置。累计越界后余下步骤自动转 T1；触及保护集合立即停止并升 T2，已写内容留在 worktree 等待决策。

**验证命令不能成为后门（v1 问题）。** 验证即使脚本未变，也会执行被修改的源码与测试，所以验证必须在实际的受限执行中运行（复用 `graph-contained-tests.ts` 的受限执行本身，而不只是其绑定方式）。此外，T0 不得运行在本 Mission 内被修改过的脚本或配置：一旦本 Mission 改动了 `package.json` scripts、测试运行配置或验证代码本身，验证即升 T2。T0 验证在受限环境中运行：不继承管理 home、socket 与凭证环境变量；复用现有受限验证的绑定思路（候选修订、命令、产物摘要，见 `packages/cli/src/graph-contained-tests.ts`）。

**保护集合（v1 问题：遗漏执行与发布机制）。** 原则：分类器、其配置，以及任何能改变执行或验证结果的东西都受保护。初版：
- 迁移与 DDL：`packages/core/src/state/migrations.ts`、`*-ddl.ts`、`packages/core/src/state/db.ts`
- 策略与守卫：`.osstack/`、`packages/cli/src/policy-gate.ts`、`guarded-open-db.ts`、`control-plane-guard.ts`、分类器本身及其配置
- 构建与依赖：所有 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`tsconfig*.json`、`vitest.config.ts`、`tsup.config.*`、`biome.json`
- CI 与发布：`.github/`、`.changeset/config.json`、`scripts/`（发布、签名、公证、smoke 与验证脚本均在此）
- 兼容代码：`legacy-python/`

保护集合本身的变更属于 T2。

**收据与崩溃窗口（v1 问题：`engineering_events` 必须关联 Mission；只在完成时写收据有窗口）。** T0 隶属一个 Mission，因此收据写入该 Mission 的 `engineering_events`，不新增存储。写入前先记 `t0_intent`（worktree、HEAD、计划路径），完成后记 `t0_receipt`（`head_before, head_after, diff_digest, files, verify_command, verify_exit`）。有 intent 无 receipt 的 Mission 在恢复时显示为“改动状态未知”，进入 Attention 决策，而不是被视为未发生。

**与 Firstmate 的对应：** 上游 scout 只读、升为写需重新绑定，与“边界外即停”一致。不照搬 `+yolo` 等放宽默认（路线图 RD-04）。

**验收：** 符号链接、改名、被忽略路径、worktree 外写入在写前被拒；多个小步的累计越界被升档；修改验证脚本后验证被升 T2；保护集合内的一行改动是 T2；崩溃后有 intent 无 receipt 的 Mission 进入决策。

## 2. 执行器边界：不造 agent 运行时

Firstmate 通过 harness adapter 驱动 Claude Code、Codex、Pi、Grok 等，自己只负责派发、隔离、监督、记账与保全。OSStack 采用同一边界：

| 归 OSStack | 归执行器 |
|---|---|
| 任务账本、授权、等待与决策、worktree 生命周期、验证证据、交付等级 | 会话、上下文、工具循环、沙箱、子代理、计划模式 |

- 适配器契约收敛到四个动作：`start`、`send`、`observe`、`stop`，外加能力声明（resume、可停止、沙箱级别、并发上限、版本）。现有 `packages/agents/src/adapters` 逐个对照收敛；本节的上游对照尚需按固定版本核实，未核实前不作为事实引用。
- 判断规则：执行器原生具备的能力，OSStack 只读取其结果，不重写；缺失的能力明确报告“不支持”。
- 工程纪律提示（最小改动、影响面、完成需证据）作为执行器侧提示包按需加载，不进 OSStack 数据模型。

## 3. 迁移：降低手工成本，但不改写已应用的迁移

**现状（实测，本分支止于迁移 48）。** 加迁移 48 需改：
- `migrations.ts`（导入 DDL 模块并登记）；
- `packages/cli/src/upgrade-native-port.ts:122` 的升级限定区间 33–48 与按版本追加的期望表；
- `packages/cli/src/attention-read-model.ts:234` 的读取限定区间 24–48；
- 若干测试的 `user_version` 断言；
- 四个 graph worker 测试复制的模块清单（`graph-runs/actions/invocations/apply.test.ts`）。

**v1 问题与修订：**

1. **不做“一个审查标记”驱动所有门禁。** 升级安全与读模型兼容是两份独立合同，保持**两个独立、连续的限定区间**，各自随审查推进；升级门禁的 hold 检查与意外表拒绝保持不变。可以派生的只有机械部分：
   - 期望表从迁移 SQL 推导（`db.ts` 已有 `tableIntroductions`），升级门禁复用它，不再手写按版本追加的表名。
   - graph worker 测试改用一个共享的转译辅助函数，按 `migrations.ts` 的导入自动收集 DDL 模块，不再手写清单。
   - 测试中的“当前版本”断言统一引用 `CURRENT_SCHEMA_VERSION`，只保留确实要钉死具体版本的断言。
   预期结果：新增一个迁移需改 DDL 模块、`migrations.ts` 登记、以及两个限定区间（各一行，且需各自审查）。
2. **不收拢已应用的迁移（v1 问题：收拢会让已跑 48 的 home 跳过新迁移、已跑 49 的 home 被拒绝）。** `db.ts` 跳过 `id ≤ user_version` 的迁移、拒绝高于最大版本的 home，并在迁移前校验表谱系。因此：
   - 迁移 ID 一旦被任何非临时 home 应用，即视为不可变。
   - 分支期间的迁移只在临时测试 home 中运行；任何用开发版创建的持久 home 视为分支 home，不承诺升级到 main。
   - 合入 main 时若需改号，必须同时提供：分支 home 的识别与隔离（现有 `GRAPH_EXPERIMENTAL_SCHEMA_CONFLICT` 谱系检查只比较表名，不比较列、触发器或迁移内容，同号同表的不兼容历史可能通过，因此需要显式的分支/schema 身份），以及经测试的转换路径或明确的“重建 home”说明；不能只证明新建 schema 等价。
3. **加表门槛不变。** 需要约束、唯一性或按列查询的实体才建表；可归属到 Mission 的附加事实写入 `engineering_events`。

**验收：** 删去某迁移的 DDL 导入时 worker 测试失败；升级与读模型区间各自独立审查；对已跑分支迁移的 home，合入版本的行为（拒绝或转换）有测试覆盖。

## 4. 自举：用稳定版管理开发版

**v1 问题：设置 `OSSTACK_HOME` 并不会让该 home 受保护；测试也并非完全隔离。** 修订：

1. **管理者：** 已安装的发布版 `osstack`，管理 home 例如 `$HOME/.osstack-dev-control`。**启用前必须配置保护**：写入 `control-plane-reserved.json` 预留标记、为已安装二进制声明允许服务该 home 的角色文件、绑定 socket 端点（`packages/cli/src/control-plane-guard.ts`）。未完成这三步不得使用。
2. **被管理者：** 开发 checkout 与 worktree 只是被管理的仓库；开发版 CLI 因预留标记而被现有守卫拒绝访问管理 home。注意守卫不是沙箱：测试代码直接打开 SQLite 不受其约束，因此管理 home 不放在任何 worktree 或 scratch 根之下。
3. **补测试隔离缺口（本线顺带修复）：** CLI 测试的隔离 setup（`packages/cli/src/test-setup-hermetic-home.ts`）只重置 `OSSTACK_HOME`，有意不动 `OSSTACK_SOCKET`；而 `OSSTACK_SOCKET` 会覆盖 home 推导出的 socket（`packages/cli/src/paths.ts:23`）。若 shell 中设置了它，测试会连向真实 daemon。修复：测试 setup 同时清除 `OSSTACK_SOCKET` 等指向真实 home 的变量；子进程启动统一使用清洗后的环境。core 测试 setup 同样检查。
4. **管理者只读产物：** git 状态、CI 结果、测试输出；不加载开发版代码。
5. **恢复要有记录与演练：** 在途任务以 Mission 记录（worktree、分支、预期产出、待决事项）；“中断后新会话可恢复”需要专门的中断/重启测试，而不是选定一个 home 就成立。
6. **升舱：** 切片合入并发布后，管理者才升级；升级本身是 I04 的真实演练。

**验收：** 未完成预留配置的管理 home 拒绝启用；开发版 CLI 访问管理 home 被拒；设置 `OSSTACK_SOCKET` 时测试仍连不到真实 daemon；模拟中断后新会话能列出全部在途 Mission。

## 5. 实施顺序

| 步骤 | 内容 | 说明 |
|---|---|---|
| OM-1 | 测试隔离缺口修复（§4.3） | 小、独立、立即降低风险 |
| OM-2 | 迁移机械部分派生（§3.1） | 降低之后每个切片成本 |
| OM-3 | 管理 home 预留配置与在途任务登记（§4） | 依赖已发布版本 |
| OM-4 | T0 写前分类器、累计上限、受限验证与 intent/receipt（§1） | 先窄后宽：初版只允许普通文本文件 |
| OM-5 | 适配器契约收敛（§2） | 与切片并行，逐个适配器 |
| OM-6 | 合入 main 前的迁移编号决定（§3.2） | 不改写已应用迁移 |

## 附：交叉评审记录

v1 由 Codex（gpt-6.1-sol，medium，只读）评审：9 个 P1、2 个 P2，结论“实施前需修订”。Claude 逐条核对代码后，以下判断成立并已修订：T0 授权边界与累计上限、写前约束、验证命令后门、保护集合遗漏、`engineering_events` 需关联 Mission 与崩溃窗口、门禁区间应分别限定、收拢迁移对已运行 home 不安全、管理 home 需显式预留、`OSSTACK_SOCKET` 测试隔离缺口。另修正事实：本分支止于迁移 48（49 在回归简报分支上）。
