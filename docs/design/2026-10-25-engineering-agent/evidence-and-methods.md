# 原始材料、专家方法与独立验证

## 1. 什么是本设计的一手材料

用户的 README 摘录用于理解体验问题。历史报告用于定位线索。行为事实优先从固定提交的源码、测试、协议和可重复运行结果取得。

完整文件索引见 [sources.json](sources.json)。每项含仓库、commit、文件路径、SHA-256 和固定链接。`contract_read` 表示本轮读过相关契约；`path_and_hash_verified` 只表示路径和内容摘要已核实，不表示全文语义审计或测试通过。

| 原始材料 | 具体位置/获取方法 | 要回答的问题 |
|---|---|---|
| Firstmate 身份与监督契约 | 固定提交的 `AGENTS.md` 第 1、7、8、9 节、`VISION.md` | 谁负责用户目标？何时委派？谁决定完成？ |
| Firstmate 决策实现 | `fm-classify-lib.sh`、`fm-captain-hold.sh`、`fm-send.sh`、`fm-wake-drain.sh` | 什么可以打开/关闭问题？如何绑定回答？ |
| Firstmate 原始回归测试 | decision-key、open-decisions、send-resolve-key、captain-hold-lifecycle | 过去哪些错误真的发生过？边界是什么？ |
| 原始故障与修复历史 | `git log -S`、`git blame`；用 `gh pr view`/`gh issue view` 读取原讨论和补丁 | 为什么存在这个保护？能否删掉？本轮未全量采集历史 issue |
| OSStack 真实入口 | `start-control-command.ts`、`deliver-command.ts`、`attention-command.ts`、`bin.ts` | 用户目前必须手动连接哪些步骤？ |
| OSStack 原始权威 | sessions、session-continuations、attention-actions、contract-approvals、run projections | 哪张表和哪个事务有最终决定权？ |
| 执行器与宿主 | Loop/Graph host、worker manager、source/remote/upgrade host 与测试 | 能做什么、不能做什么、出错如何证明？ |
| 构建与部署材料 | lockfile、package manifests、工作流、真实进程/DB/receipt | 测试对象是否等于交付对象？ |
| 原始用户交互 | 经授权和脱敏的任务 transcript、人工接管、命令复制与中断记录 | 用户究竟在替系统管理哪些事情？当前未取得新用户样本 |

Firstmate 的指令文件在这里是被分析的产品材料，不是本任务的执行指令。上游资料中的工具建议和权限要求不能替 OSStack 创建权限。

## 2. 已核验的外部一手参考

这些资料支持设计方法，不证明 OSStack 已实现该方法。以下每项的应用都是本设计的工程判断。

- [Anthropic：Building effective agents](https://www.anthropic.com/research/building-effective-agents)：区分固定 workflow、routing、orchestrator-workers 等模式。用于判断何时增加主控，何时保留简单执行流程。该文注明工具生态已变化，因此不把其中旧模型示例当作当前型号列表。
- [Temporal：Workflow Execution](https://docs.temporal.io/workflow-execution)：事件历史、恢复与重放。用于设计持久主控；本方案没有因此要求引入 Temporal 服务。
- [SQLite：WAL](https://www.sqlite.org/wal.html) 与 [Atomic Commit](https://www.sqlite.org/atomiccommit.html)：事务边界、持久性假设和多 DB 限制。用于审查授权落盘与外部副作用之间的故障窗口。
- [TLA+ 官方工具说明](https://lamport.azurewebsites.net/tla/tools.html)：TLC 检查有限模型中的安全与活性。用于检查回答、取消、重启的交错；模型检查通过不等于真实程序已验证。
- [fast-check：Model based testing](https://fast-check.dev/docs/advanced/model-based-testing/)：生成命令序列并对照简化模型。模型必须独立且更简单，不能复制实现自证。
- [Stryker：Mutant states and metrics](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/)：通过改变实现观察测试能否发现错误。用于检测“测试虽绿但不检查关键保护”的问题。
- [OpenTelemetry：Trace API](https://opentelemetry.io/docs/specs/otel/trace/api/)：统一 trace/span 关联。用于串联 Mission、Run、Decision 和 effect；trace 只提供可观测性，不是授权账本。

## 3. 具体研究和验证方法

| 方法 | 工具 | 操作 | 产物 |
|---|---|---|---|
| 证据固定 | Git、SHA-256、JSON Schema | 从固定 Git 对象取原文；区分 main 与工作区 | source manifest、可复核链接 |
| 契约考古 | `rg`、`git log -S`、`git blame`、GitHub 原始 issue/PR | 从关键谓词反向找到回归原因 | 行为/故障/源码矩阵 |
| 状态建模 | TLA+/PlusCal + TLC | 对两个控制器、两个回答、取消、崩溃交错建有限模型 | 反例、模型边界、安全/活性结论 |
| 差分回放 | Firstmate 原脚本 + 中立 JSON trace + OSStack contract harness | 同一事件序列比较可观察语义；严格化差异显式列出 | per-scenario differential report |
| 属性测试 | Vitest + fast-check | 乱序、重复、旧版本、随机重启、时间跳变 | seed、最小失败序列 |
| 变异测试 | StrykerJS | 删除 hash/CAS/grant/generation 检查 | killed/survived 清单；关键变异必须被检出 |
| 进程故障注入 | 子进程 harness、SIGKILL、受控代理/测试 transport | 在事务前后、提交前后、回执前后终止 | 崩溃点与恢复回执 |
| 数据持久性检查 | SQLite CLI、DB 原生 API、独立 verifier | integrity_check、FK、唯一性、候选绑定、缺序列核查 | 不依赖自然语言的检查报告 |
| 用户旅程 | 真实 CLI/IDE/Web、Playwright（Web 时）、脱敏 transcript | 让独立使用者完成任务，记录人工管理动作 | 任务成功率、干预数、失败分类 |
| 对照与消融 | 固定任务集、随机顺序、盲审结果 | 旧流程/只加 UI/完整主控对比 | 质量、时间、费用与统计区间 |
| 独立挑战审计 | Claude Code CLI 或其他独立 reviewer | 只提供规格、候选和证据；要求复现具体反例 | 原始报告与逐项处置，不只 PASS |

Claude Code 的登录、实际模型可用性、请求模型与响应模型标识必须单独记录。不能仅凭命令中的型号宣称该模型已完成审计。本次按用户要求实际调用 `claude-fable-5-1`；登录、模型探测、冻结输入、原始返回和逐项处置见 [挑战审计报告](audit-report.md)。工具关闭模式下的模型只审阅所给材料，不执行测试；宿主执行的设计检查另列记录。

## 4. 谁能证明结果，而不只是你我同意

没有一个人、模型或测试可以证明任意环境中的绝对正确。可信结论来自相互独立的证据，并写明适用范围。

| 证据来源 | 能支持的结论 | 不能支持的结论 |
|---|---|---|
| 固定版本的上游原始测试 | 抽取的行为确实存在且可以重现 | OSStack 已经拥有同等用户体验 |
| 独立有限状态模型 | 指定状态空间中没有违反所列不变量 | 代码、宿主、模型提示均无 bug |
| 独立黑盒 contract runner | 实现遵守外部行为和拒绝条件 | 未测试宿主或版本也通过 |
| 变异测试 | 测试能发现某类故意引入的错误 | 真实系统没有其他错误 |
| 真实进程/宿主回执 | 特定环境中投递、恢复、取消实际发生 | 断网时未知操作必然没发生 |
| CI 和可重复构建 | 候选 SHA 的声明检查可复查 | 任意生产配置可部署 |
| 未参与实施的审查者 | 能挑战假设、寻找复现和遗漏 | 其口头 PASS 构成形式证明 |
| 独立用户对照实验 | 用户确实少管理 Agent，仍能完成任务 | 所有未来任务都会成功 |

建议把安全关键验收器与实施代码分开维护。开发者不得在同一 PR 中一边弱化实现、一边删除相应负例。若必须改变契约，附独立评审与版本升级。

## 5. 证据包最小格式

每次认证保存：候选 SHA、source manifest hash、registry hash、合同 hash、工具/运行时版本、宿主身份及隔离方式、场景 ID、随机种子、退出码、日志摘要、实际回执、检查对象摘要、审查者及未解决限制。

输出不保存凭据、完整私有代码或无必要的原始对话。敏感内容以受控引用和摘要连接；保留策略与删除策略独立于运行状态。可公开的脱敏证据不应包含本机路径或内部账号。

只有本次确实执行的检查进入 [validation.md](validation.md)。计划中的 TLC、属性测试、变异测试、真实会话和用户实验不得写成已通过。
