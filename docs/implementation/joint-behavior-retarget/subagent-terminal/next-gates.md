# 下一批执行门槛核验：J01 / J11 → J02b / J03 / J12

冻结检查基线：`8fed83136611948ee068801ab5cc1fd471f90078`。本次只读 Git 对象，未修改产品、PR 或账本；没有运行 Claude 或全仓测试。下文“现有证据”来自已提交历史记录，不能冒充本次重新执行。

## 判定

**J01.scoped 与 J11.scoped 目前都不能登记为 PASS。** 基础实现已合入，可以开展明确隔离的后续准备和契约开发，但尚缺与正式 case、候选及支持格绑定的验收记录。机器设计中两门槛仍是 `specified_not_run`；JA01/JA02/JA59、JA20/JA47 的 `oracle_spec` 均为 unassigned，缺独立主体、冻结时间和摘要。当前账本分别仍记 `not_executed_as_complete_milestone`。

PR 合并、历史 Sonnet PASS、包测试通过，分别提供交付、静态审查、实现回归证据；它们没有自动执行组件 gate，更没有完成整个 Firstmate/pstack 能力验收。不能把后续组件开发关闭成等待整个项目验收，也不能伪造 gate 来绕开依赖。先使组件门槛定义与实际切片一致，再按其证据执行。

## 实际 gate 与 case 映射

| 现有 gate ID | 前置 | 当前验收义务 | 可复用事实 | 缺口/判定 |
|---|---|---|---|---|
| `J01.scoped` | 无 | JA01 完成级别隔离、JA02 任务授权绑定、JA59 摘要/规范字节互操作 | #272/#273 结构契约、严格 JSON、Python/TS 向量 | 无正式已执行 gate/case 记录；JA01/JA02 要真实集成边界，不能用结构测试替代 |
| `J11.scoped` | `J01.scoped` | JA20 恢复存储依赖无环；JA47 恢复 receipt 字段完整 | 冻结的 schema 47→48 DDL/catalog/旧 Attention hold fixture、14 个恢复规格测试 | J01 前置未通过；case/oracle 绑定未执行；新 main 的组合证据需明确 |
| `J02.scoped` | `J01.scoped` | JA03 来源与实际采用依赖；JA04 路径与 v1/v2 兼容 | #281 只读来源检查器及 37 包测试 | J02a 明确 `dependency_resolution=not_performed`；没有分型注册或采用闭包资格 |
| `J03.scoped` | `J01.scoped` | JA05 实际 Session 回执旅程、JA06 dry-run 零副作用、JA44 控制动作幂等 | 现有 Session RPC、receipt/cleanup 测试可供夹具调用 | 尚无注册 driver/action-resource ledger；需 JP-03a/03b 分片 |
| `J12.bootstrap_preflight` | `J11.scoped` | JA52 的隔离账本单步迁移资格 | J11 内存 SQL/回滚测试只提供规格 | 文件 WAL/FULL 子进程 kill、旧写者 fence、普通 openDb 迁移前 hold guard 未实现/资格 |
| `J12.scoped` | `J11.scoped`, `J12.bootstrap_preflight` | JA21 精确未知义务、JA51 phase/decision/proof 后态、JA52 bootstrap | RecoveryReceipt/Envelope 的结构校验和 J11 SQL 防御检查 | 真实权限、原始状态/CAS、停止来源、文件持久化、operator recovery host 均待实现 |

后续完整恢复还有 `J12.full_recovery` → `J12.scoped` + `J17.recovery`；不能让 J12 本地组件等待完整 broker 再开始，也不能宣称其取代 broker。`legacy:DEBT02.recovery_contract`、`legacy:I04.recovery_home`、`legacy:I04.compat_recovery` 保持各自真实要求。

## J01：已有实现与最小补验

现有代码证据：#273 代码 `e3fd9a9ffccbe66ad0cdfee101e0864f1ca277db`；账本保存 6,160 passed / 5 skipped / 0 failed 与 Sonnet 5.5 PASS。证据路径：`docs/design/2026-10-27-joint-engineering/evidence/joint-execution/j01b-retarget/validation.md`、`audit-code-binding.json`。该 SHA 不是最新 main，不应把这些计数标成 8fed8313 的全仓实测。

可直接复用的测试源码：

- `packages/protocol/src/joint-json.test.ts`：严格原始 JSON 与 canonical 边界。
- `joint-reference.test.ts`：独立 Python/TS 向量、闭合摘要域、Python -O 下错误向量拒绝。
- `joint-admission.test.ts`：recipe-role/aggregate、binding→proposal/recipe、错误 repository/profile、exact-kind decoder、恢复 proof context。这里的名称含 admission，但实际是纯 helper/结构约束，并未调用真实 adapter。
- `joint-foundation.test.ts`：10 种 material body 缺字段拒绝、oracle/gate 结构、恢复 phase/decision 与 broker 身份；结构上合法的 GateEvidence 样本不是真实 gate 结果。

JA01 需要记录 Session 已观察回复、task 无 checks/review，在真实完成入口请求 `implementation_verified` 后拒绝，并杀死 `observed_turn → task done` 变异。JA02 需要 proposal 仓库 A、授权仓库 B 经真实 method admission 拒绝，观测原 adapter 调用为零，并杀死移除 repo/scope 比对的变异。当前 `trialBudgetIssues` 的 repository 拒绝是辅助证据，不是这条真实入口旅程；不能只借旧 host 的拒绝测试覆盖新入口（verification-spec §2 已明确）。

**设计粒度冲突需要先解决：** J01 outputs 是 opt-in 协议模块，JA01/JA02 却要求后续 runtime 接线；J02/J03/J11 又要求 J01.scoped。强行把整条运行时验收当作基础契约开工门槛，会造成实现调度上的循环等待。现有图本身无环，这里是验收职责和组件粒度冲突，不是声称 JSON 图已成环。

最小处理建议是单独的门槛分层修订 PR，接受独立审计：

1. 新增 **提案 ID** `J01.contracts`（当前文件不存在此 ID），只消费明确的 version/strict parser/digest/identity/role/recovery schema 组件验收。
2. J02/J03/J11 等纯契约消费者按审计确认的组件范围依赖它；原 `J01.scoped` / JA01 / JA02 真实集成义务完整保留，绑定到交付真实 method-admission/完成判定的后续切片，并让发布 gate 仍真实消费。
3. 不将 JA01/JA02 改名为 schema-only 后冒充通过，不删除原 case 或 legacy/full release obligation；同步 work packages、execution gates、acceptance 映射及其验证器。
4. 若集成主入口选择不拆 gate，则要明确额外实现真实运行边界后再放行 J01.scoped；不能仅靠测试名称或已合并状态放行。

对实际新验收，先登记独立作者/实现者/保管人/安全复核人，冻结 oracle 摘要，再创建新候选和执行记录。可以从已有代码开始新验收候选；不要求 oracle 早于项目第一行代码。不得把当前事后调查回填成过去的预冻结记录。

## J11：可核对的证据和不足

代码 `7ea45584ce0de01860571100beb5daed4ff83f31`；历史全仓 6,174 passed / 5 skipped / 0 failed，14 个恢复规格测试，Sonnet 5.5 第 6 轮 PASS。证据位于 `evidence/joint-execution/successors-retarget/recovery/{test-summary,audit-code-binding}.json`。

本次只读 hash 核对结果保存为 `next-gates-evidence.json`：

- 15 个审计输入中 14 个在 main 8fed8313 逐字节一致；`packages/protocol/src/joint-json.ts` 已变化，因此不能把旧审计声明成最新组合的全文件完全一致。
- `db.ts`、`migrations.ts`、`schema.ts` 与 manifest 基线 `69859eecfcc84af9d6eff755ed41243ca5f51f95` 逐字节一致。说明迁移源没有因这两次合并变化，不等于无需新候选绑定。
- manifest 精确 pin schema 47→48、DDL、fixture、source/target catalog。未来 method-state/engineering-goal 模板单独 pin，未分配正式迁移号；broker shape 由 `J17.schema_spec` 冻结。不要把模板摘要当未来迁移资格。
- `operator-recovery-spec.test.ts` 已覆盖旧行与完整 catalog 不变、内存事务回滚、旧 migration runner 拒绝48、immutable/revision/request collision、SQL phase/home guards、proof envelope 6 项上下文、精确 MigrationSpec 元组和 subject digest。它不含真实 operator 授权与真实停止来源认证。

本次补做 124 节点 DAG 只读检查：原图无环；注入 `J11.scoped requires J12.scoped` 后检测到 `J12.scoped → J11.scoped → J12.scoped`。输出 `next-gates-dag-check.json`。这只是 JA20 负例方向的调查结果；没有预冻结独立 oracle，不能直接把 JA20 标 passed。

最小补验切片：

- 将 JA20 的允许依赖及坏反向边冻结为可重放输入，明确 home spec / later business schema / broker spec 的分别生产方。不要把不存在的 broker SQL 当已测试。
- 将 JA47 的 receipt 必需字段删除矩阵列成显式期望表：effect/subject、owner、generation、schema/DDL/fixture/build、proof refs/proof identity、decision 与 revision。不同 subject variant（effect/Attention/legacy/broker）按各自 null/缺省规则独立验证；仅测试 SQL列或少数篡改值不足以说明“逐字段缺失全部拒绝”。
- 在新冻结候选重跑协议相关测试 + 14 个恢复规格测试 + Python 独立向量/DDL/catalog校验 + DAG负变体；记录 exact candidate/schema/profile/tool/log/hash。
- O03 在 unknowns.json 仍 open，blocks J11.complete/J12.merge。需以冻结实际main、schema元组和证据显式解决或按 bootstrap/future migrations 拆分，不能改状态却无证据。O06 仍 open，实施前需记录 fresh baseline/#271 接口影响核对；设计冻结文件不代表主入口最新运行账本没有进一步证据，应合并真实新增事实。

## 建议进入 OSStack next queue 的最小任务

| 次序 | 工作项 | 写集合/输出 | 可并行性 | 放行条件 |
|---|---|---|---|---|
| 1 | GATE-01 契约组件门槛与原集成义务映射 | 联合 gate/case/work-package 文档与验证器 | 独立于 #276/#278 产品代码 | 上述粒度冲突有审计决议；保留原 release 消费边 |
| 2A | J01 组件独立验收 | oracle/候选/字段与digest证据 | 可与 J11 oracle 准备并行 | 新冻结组件门槛正式 PASS；不伪称 JA01/JA02 |
| 2B | J11 scoped 收口 | JA20/JA47 显式输入/负例/证据，schema队列记录 | 初始只读准备可并行；声明 pass 需对应基础 gate | exact 元组与前置/独立 oracle 可核验 |
| 3A | J02b-a 来源消费与依赖模型 | typed registry + inspection→SourcePin 转换规格，采用依赖图闭包/防环/字节绑定测试 | 与 J03 独立路径并行 | 基础组件 gate；R02 若接入待 #276 合并及重新核对 |
| 3B | JP-03a Session driver | doctor/setup/drive/observe/cleanup 注册动作与归属/幂等 ledger | 与 J02b-a 并行 | 基础组件 gate；#278/#279 的所需 cleanup/terminal 前置稳定后验证组合；dry-run绝不建Session |
| 3C | J12-a bootstrap 恢复入口 | state-owner独占 control_plane_schema；专用恢复打开、普通迁移前hold守卫、固定单步DDL、文件WAL/FULL kill夹具 | 与 J02b/J03不同文件可并行，但 schema 写者串行 | J11.scoped；新迁移 tuple；完成 J12.bootstrap_preflight 后才能主张 bootstrap资格 |
| 4 | J12-b 精确恢复裁决 | operator auth/current scope、source/owner/binding generations、request CAS、原记录证明、hold/budget/wait后态 | 接 J12-a | JA21/JA51；home 与 broker 范围明确，不提前声称 full_recovery |

J02b-a 和 JP-03a 的规格、oracle、无副作用离线夹具准备可以现在启动；其依赖门槛和运行时接线/验收不能跳过。J12 的 file-backed 故障协议和白名单规格可以准备，但正式 schema 修改应待 state-owner 队列和 J11 gate 明确。此处是调度建议，不是私自修改现有依赖或签发 gate。

完整生产资格、价值提升、live provider、默认启用均不在本次事实中。

## 主干推进后的增量复核

主入口通知 main 前进至 `28d116f3f8c15f64bebb314308adf320d8380b2b`。本次只读 `git diff --name-only 8fed8313..28d116f3` 核对 `packages/protocol`、恢复 fixtures/test、联合设计目录和 operator-recovery-schema.md，结果为空；因此上述具体组件/机器门槛缺口未被这次合并改变。它不表示 #276 的审计补修复已合入，也不替代每个新候选的正式验证。
