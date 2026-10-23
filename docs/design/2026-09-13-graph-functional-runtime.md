# OSStack 可执行图：Functional API 内核决定

日期：2026-09-13。状态：C2 限定准入通过，允许进入 M1；生产运行时尚未实现。范围：替换图的编译目标，不增加产品或第二套调度权威。

## 决定

在固定 LangGraph 1.4.15 上，采用公开 `entrypoint` / `task` 作为 OSStack 静态工程图的编译目标。保留受限 GraphSpec、节点注册表、明确输入输出、并行汇合、条件路由、有限 epoch/分支次数和停止规则；用户不能上传任意函数。现有 StateGraph 的部分写入恢复缺陷保持拒绝准入，不通过修改私有实现修补。

v1 准入固定 `durability: sync`。G13 必须在持久整批写入后返回 daemon acknowledgment，G14 禁止切换 async/exit。C2 的 async 行仅是同步文件夹具的补充观察，不证明延迟 RPC 的刷盘语义。

图规格仍是声明式的。编译器将已校验、最多三个 epoch 的静态拓扑转成固定顺序的 task 调用，使用结果驱动确定性路由。并行任务按编译顺序创建，再等待同一组 Promise 完成；不能按网络完成先后决定任务注册顺序。图展示和 explain 从 OSStack 规格及执行证据产生，不依赖引擎生成可视化。

## 选择原因与边界

StateGraph 的状态结果和边通知可能分开产生。异常时保留部分结果，恢复却可能跳过缺少边通知的节点。同步持久化不能修复这一语义。直接 updateState 还可能重复 reducer 或使另一分支失去触发。

Functional API 允许重放编排函数，同时复用任务的持久返回值。公开源码把任务结果写入单个 RETURN，工作流结束值在一批写入中提交；这减少了上述状态/边分割窗口。具体准入仅以 C2 的独立进程实验为证，不由源码推断或 API 名称担保。

官方 [Functional API 文档](https://docs.langchain.com/oss/javascript/langgraph/functional-api) 提供 entrypoint/task、错误恢复和 interrupt 用法。OSStack 的确定性编译、权限和持久动作账本是我们自己的约束，不是官方 API 自动提供的能力。

## 单一调度权威

- LangGraph checkpoint 控制程序重放与 task 返回值复用；不再额外构建独立节点调度 FSM。
- Daemon ledger 控制外部动作 intent、confirmed、unknown、权限和资源。任务重入时必须先走 broker；已确认动作返回原结果，未知动作阻断并对账。
- 编排函数不得直接执行 I/O、读随机数/时钟、请求模型或写文件；这些必须进入具有稳定逻辑身份的注册 task/broker 动作。诊断事件也须避免重放形成重复业务效果。
- task 的内部调用次序/缓存 key 不是业务 effect identity。业务身份仍使用 scope/run/spec/epoch/node/slot/ledger 分配的 attempt；不含 worker generation。
- 缓存的 RETURN 可以避免再次进入节点函数。外部效果完成但 RETURN 尚未提交时，恢复可能重入节点函数查询账本；这不等于重复执行外部效果，也不宣称物理恰好一次。

## 恢复前必须绑定的程序身份

G08 保存，G13/G14 在每次恢复/接管时校验：`executionModel=langgraph-functional-v1`、engine/checkpoint 版本、模板/注册表/compiler/schema 版本、规范化 spec/input digest 与 compiledProgramDigest。摘要须覆盖固定 task 顺序、名称、输入映射、分支/epoch/重试展开。实测绕过身份门后，改变 join 参数会复用旧结果，改变 task 顺序会重入已完成函数。因此不得用引擎缓存替代程序身份校验；Functional 路径不允许通过 updateState 改写旧输入。运行中升级这些字段拒绝自动恢复；迁移需要新的明确协议，不能随最新代码重解释旧 checkpoint。

同一程序的分支决定只依赖已固定输入、已持久 task 结果和作用域绑定的显式 resume 数据。不可按任意时间、进程环境、动态插件顺序或竞态结果改变调用顺序。节点 task 不嵌套启动未注册的自由流程。

## 取消、超时与进程退出

`invoke` 因 abort 拒绝，不能证明用户任务或外部 adapter 已停止。C2 的不响应取消反例保留。G14/G15 必须停止新动作准入，传播取消，等待退出证据；必要时终止 worker 并确认退出，再处理租约/资源。

Worker 退出不自动证明它已经启动的独立 agent/命令进程退出。那些由 daemon broker/既有 Loop 的取消协议负责；无法确认时保留 unknown/cancel_pending，隔离工作区，不立即转交写者租约。新 generation 的 checkpoint/action 路径都必须拒绝旧写入。

## 后续卡片调整

| 任务 | 必需落地 |
|---|---|
| G08 | 程序身份字段、不可变摘要、worker generation 与恢复不匹配拒绝 |
| G11/G12 | 稳定 effect identity、重入查询 confirmed、unknown 拒绝重发及动作级权限检查 |
| G13 | 公开 Saver 完整方法、原子整批写入、真实 codec、task RETURN/error/resume 保真及 fencing |
| G14/G15 | 独立 worker、取消后确认退出、旧代拒绝、外部 adapter 对账 |
| G17 | 两节点真实 daemon→worker→broker 恢复链，用生产接口重跑 C2 故障位置 |
| G18 | 有界静态规格编译到 Functional API；稳定 task 调用顺序及程序摘要 |
| G19/G20 | 固定候选 SHA、并行结果显式输入 join、有限失败路由和代码修复 epoch |
| G25/G27 | 进程故障矩阵、程序身份错配、引擎版本/平台与发行形式回归 |

C2 的文件 ledger 和公共方法 journal 是测试夹具，不是提前实现的生产账本或 Saver。C2 通过仅允许继续 M1 集成，不开放生产图运行；真实生产恢复仍须通过 G17/G25 等验收。若 Functional API 实验无法满足这些边界，保留有限静态调度器作为待验证替代，不同时维护两个生产内核。

最终证据见 [C2 验收报告](../implementation/2026-09-13-graph-c2-completion.md)和[机器准入记录](../implementation/graph-c2-evidence/admission.json)。
