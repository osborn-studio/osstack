# G25 第六阶段：持久 worker 退出证明与完整执行器清单

本阶段补齐已被父进程观察并持久记录的 Graph worker 退出证明，以及覆盖全部历史动作的执行器义务清单；在 GraphDelivery 完成、换代和取消的最终事务中重新核验。它不开放通用 supervisor 崩溃后自动接管。G00–G24 已完成，25/30；G25 仍为 in_progress。

## 实现

`verifyJournaledGraphWorkerExit` 绑定 scope、program identity、generation、owner、lease、launch、PID 和有序时间戳，读取 append-only launched/exited 记录。可接受一次 exit_unconfirmed 后真正观察到的 exited；没有持久 exited、字段矛盾、journalError、no-child 或仅结果成功都不能产生 stopped 证明。只读核验无信号或当前 PID 查询，PID 重用不能改变历史证明指向。Linux 启动身份和其他平台 unverifiable 身份都必须与当时实际子进程一致；这里证明的是父进程已观察到该直接子进程退出，不是所有后代终止。

`GraphRecoveryStore.inspectExecutors` 在原子读取事务内枚举 action/admission 的并集及历史 owner。已确认但仍 held、缺 admission、已释放但未终结的 action 都列入 requiredEffectKeys。`assertExecutorInventory` 必须在调用者最终事务中重算摘要，因此 admission release 即使未增加 run revision，也会使旧清单失效。清单是证明义务列表，本身没有释放或接管权限。

GraphDelivery 的 ready/failed 投影、repair takeover、quality resume 和 cancel 新增持久退出核验；终态、接管和取消前检查完整清单并在事务内重验。实际 runtime observedExit/actionsSettled、当前权限、现有工作区和发布规则仍保留。缺少退出日志的正常完成和修复路径转 reconciliation_required；取消保持 cancel_pending。准备动作虽被拒绝，如果没有持久准入/未启动凭据，也不能仅凭 failed 状态认定安全终结，现转入对账。

## 验证记录

源码提交 `138784c74caee698f0f8836cb5aa9ae9be47b869`。实际 OSStack Loop `G25-durable-worker-quiescence-2` 执行 1、跳过 0，交付回归 36 通过/1 失败（旧准入拒绝契约）；7 项 verifier 全通过。修正契约断言后，`G25-durable-worker-quiescence-recheck-1` 重跑 6 个文件 **37 项交付/公开入口/停止测试全部通过**，并用 retained-evidence verifier 核对最终源码、构建产物与 Kimi 审查覆盖；outcome=success。首轮 escalated 和更早一次主动中断历史保留。

固定 seed 250922/250923 的故障矩阵共 **512 次测试执行**，1071 个源文件及构建产物前后哈希一致，补验再次核对。其他通过项：全 workspace typecheck、协议 schema freshness、CLI 启动预算、git diff --check；新退出证明套件 **25 项**在设置 G25_EXIT_CHILD 后运行，真实独立 Node 进程重开 SQLite，返回相同绑定证明；真实 Linux contained GraphDelivery 套件 **11 项**通过。该套件的 6 项业务链使用实际 Linux 容器；其余 5 项覆盖退出日志失败/取消边界，使用相同容器配置但不都必然执行到 tests 容器。

真实 `KimiCodeAdapter` 使用 `kimi-code/k3`：首审要求修改；中间审查批准但仍提醒取消覆盖；最终生产源码/取消用例审查 `kimi-accepted` 与测试契约补充审查 `kimi-addendum` 均 approved、全部 judgments 通过。审查有非阻断提醒，见下节。输入、原始结构化结果、实际 runtime identity、Loop 结果与可复跑 harness 见 [证据](../implementation/graph-worker-quiescence-evidence/admission.json)。

这是本轮针对改动的验收，未重新执行上一阶段全库 3,368 项测试，也未将其充作本轮结果。测试使用独立 OSSTACK_HOME/TMPDIR；专用 Colima profile 已停止，零遗留测试容器，默认 context 不变，未访问 serving DB。

## 发现与修正

- 初始真实 DB 重开测试使用 runtime.close 前的旧 revision；改用持久最新 run 构造 fence。
- 新直接完成/repair 日志失败测试最初沿用了成功 fixture 的断言；独立故障断言纠正后，进一步修复产品把日志失败归普通失败的行为。
- Kimi 首轮要求补取消路径。本轮增加真实 child 退出时 clean/journal-failed/missing-admission 三种 cancel 场景，检查实际 status 与 recovery proof，而非只看返回 Promise。
- missing-admission 初始故障注入尝试删除 immutable admission，被 DB 触发器拒绝；改为仅跳过有限 writer 的 admission 写入，保留实际物理租约和停止路径，模拟兼容旧动作。
- 既有“准备准入被拒绝”测试期待 failed，与新完整清单契约冲突。更新为 reconciliation_required，并保留写者/评审次数、动作状态和零 join 断言。
- 首轮 Loop 在审查提出补测后主动中断，未声称成功。后续验收与失败历史均保留。

## 审查中保留的限定

Kimi 最终批准附带两条非阻断提醒：既有取消路径的 workspaceEvidenceRef 仍复用退出证明引用，没有新增独立工作区隔离证明；takeover 的 executorEvidenceRef 仍采用既有 join receipt，完整 inventory 虽已在最终事务重验，持久引用命名还未统一。两项均保留到全图恢复阶段，不据此声称工作区/所有外部执行器已获得独立停止证明。退出事件 UUID 字段的宽松形状校验是另一条低影响提示，事件仍限受信 host journal。

## 仍未准入

父进程在观察退出前崩溃，不能靠租约过期、PID 不存在或工作结果完成推断停止。opaque writer/reviewer、所有容器执行器与后代停止证明仍须分别提供；本阶段没有把单 action contained reopening 扩展成全图恢复服务，也没有新增业务 applied/not_applied 推断、通用 release/resume 或公开 RPC。

待完成：完整 inventory 分流和逐项物理证明、G15 业务 envelope 对账及精确资源释放、release ACK 丢失和跨代残留、artifact 锁管理恢复、F01–F12 剩余子窗口，然后 G26–G29 兼容、发行、性能和真实 LLM 内部试点。macOS Node 26 测试加 Linux 容器不构成 Node 20/22 或全 Linux 兼容准入；有限 writer/reviewer 测试适配器不是真实 LLM 试点。
