# Claude Fable 5.1 协作评审与决策记录

日期：2026-09-13。主题：真实可执行图进入 OSStack 的产品与技术方案。

共完成三轮 `claude-fable-5-1` 评审；CLI 元数据确认主评审模型，另含 CLI 的 Haiku 辅助调用。评审禁工具和嵌套 skill，通过保存的上下文传入固定源码、实验和设计。Claude 的意见由主研究核对，不作为外部事实来源。原始上下文、答复、模型元数据在 [证据目录](2026-09-13-executable-graph-evidence/README.md)。

## 第一轮：独立方案与反方

输入包含用户重新澄清的目标、OSStack 源码与开源候选事实，没有先要求接受 LangGraph。

Claude 支持在 monorepo 新增 graph 包，反对现阶段拆独立 osgraph；但提出自研小型 DAG 调度器，理由是外部引擎会带另一套 checkpoint/session，并且 OSStack 仍需动作幂等。同时指出实际 adapter 接口没有 cancel 方法、executor 缺外部 signal、缺 done 可能默认成功，以及 cycle 末才落 LOOP-STATE 的恢复缺口。

主研究回查源码，确认上述具体接缝；进一步发现 private runTask 成功时会自动 commit、ff-only merge 与 cleanup，不能直接成为候选实现节点。

## 第二轮：挑战自研结论并缩小首个切片

主研究提出六项反驳，带入 ADK 与 LangGraph 的 10 项实测：

| 分歧 | 挑战后的结论 |
|---|---|
| 两套状态机制必然冲突 | 撤回；分别界定图调度权威与动作/权限权威，并把 UI 状态作为投影 |
| ADK join 不看业务成功，因此应自研 | 两个引擎都需要业务结果校验；空输出边界需封装，不能据此证明自研更便宜 |
| 模块加载成本排除框架 | 改为按需独立 worker；不能只在 daemon 内 lazy import |
| 双 writer 并行实现再合并 | 首版改成单 writer，评审与测试并行，减少共享仓库冲突 |
| kill 后保证没有任何重复 agent 运行 | 撤回不可能的绝对承诺；confirmed 结果唯一，unknown 不盲重发，外部计费不作恰好一次保证 |
| graph 是一种有界 grant | 修正为 graph 是规格；resume 和 spec 均不自带权限，每动作启动重验当前授权 |

Claude 同意不以自研为默认路线，并提出本轮最重要的反例：旧子进程仍可写旧 worktree，fencing 只保护新动作与账本，不保护已经启动的文件系统副作用。最终方案加入独立工作区租约、旧代隔离、确认退出后再回收。

同时采纳：saver `putWrites` 与 `put` 同样需要 fencing；格式错误单独作为分支错误，不让 writer 修代码；图级评审不能与完整 Loop 内置评审重复；冻结成果必须形成可独立恢复的 commit/patch，而不只留下即将删除的目录。

## 第三轮：最终设计一致性

送入完整实施计划，并明确纠正第二轮的一个术语错误：**checkpoint 本身不是全可由 ledger 重建的投影**。它负责调度与图数据；ledger 负责动作与权限；只有用户展示状态是汇总投影。

此时已补做两项持久化实验：SQLite 跨进程恢复成功；SIGKILL 恰在动作后/checkpoint 前造成两次模拟外部动作。两者共同支持“复用检查点，但必须补动作账本”的结论。

Claude 的最终判断：**“无阻塞矛盾。作为待实施计划可接受，不代表运行实现已验收。”** 另给出五项补充，均已落实到实施计划：

1. logicalAttempt 只能由 daemon ledger 分配，worker 不得从 checkpoint 推算。
2. 格式修正与基础设施重试共用 `maxBranchAttempts`，独立于代码修复 epoch。
3. reconciliation 有带证据的裁定出口，与持久 interrupt 关联；cancelled 不可 resume 复活。
4. daemon 按 run 串行 generation 校验、checkpoint 写入和租约切换；不虚构跨库事务；幂等缓存绑定 generation。
5. graph、直接执行与受管 Loop 共用写者租约；图 v1 不自行推进 task status FSM，发布交付仍走现有治理。

主研究还把示例总动作上限调整为 64，避免示例仅按模型调用估算而遗漏冻结、工作区等受控动作；实际编译器仍须计算可达动作上界并对照授权与预算，示例数值不是性能最优值。

## 最终采纳与未完成边界

采纳：OSStack 内模块、LangGraph 单内核先行、独立 worker、受控 broker/saver、一次候选实现、同 revision 并行质量门、明确停止与对账、隔离旧工作区。

不采纳：马上独立 osgraph、以 checkpoint/权限共同成本为由直接自研、双 writer 首发、将现有 runTask 无修改包装、将 graph explain 测试算作执行图验收。

尚未完成：生产代码、受控 saver 与 ledger 的集成、真实 adapter 故障矩阵、最低 Node 20、CLI/daemon 性能回归以及真实任务收益测量。三轮评审使方案具备实施依据，没有替代这些工程验收。

交付文档：[研究报告](2026-09-13-executable-graph-research.md)、[实施计划](../design/2026-09-13-executable-graph-plan.md)、[更新 context](2026-09-13-executable-graph-context.md)。
