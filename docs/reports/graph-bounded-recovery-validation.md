# 受控 writer 跨 host 对账验收

日期：2026-09-20。实施分支 `codex/graph-runtime-foundation`。代码提交 `42a5f93e8e67163016cd15f8f6cf0f21ac60927c`。

本轮将公开 `graph.reconcile` 从“没有执行过动作”扩展到一个真实业务窗口：首轮受控 writer 已完成并证明停止，持久回执已写入，但账本结果或释放确认丢失。原 host 记录 worker 退出后退出，新 host 可以结算原动作、释放精确原锁并将取消意图投影为 cancelled。不会调用模型第二次，也不会自动继续到 freeze 或 ready。

这是 G25-C2 的有限恢复切片；父任务仍为 25/30。尚未解决“daemon 突然死亡，来不及记录 worker 退出”的窗口，也不解决 API 断线而没有可信终态的推理。

## 实现与证明

1. Broker 保留宿主实际验证的 `stopped` 标志，以及独立 `confirmStopped` 返回的 stopEvidenceRef。模型输出不能提供这个字段。只在 implement/repair 的证据中增加 stopEvidenceRef，保持 review/tests 原有严格 envelope 兼容。
2. Delivery 在受控首轮 writer 的停止和内容回执持久化后、账本确认前，发布按 effectKey 定位的不可覆盖恢复日志。日志绑定 action/executionRef、generation、worker owner、原始 delivery receipt、精确 RepoLockOwner 和独立候选指纹。
3. 指纹覆盖原始文件内容、权限和 Git 元数据，也包含忽略及未追踪文件；仅排除宿主 writer-locks 目录。限 32 MiB / 10000 项，不接受软链接、共享硬链接或特殊文件。超出范围时保留正常执行能力，但不宣称具备该恢复证明。日志和回执位于候选目录外的宿主私有目录。
4. 新 host 必须证明原 host PID 当前不存在，核验可信 worker 退出日志、已确认且释放的 workspace 前置动作、完整两动作历史、候选指纹及原锁身份。活着、暂停、PID 重用或观察权限不足的原 host 均不会被视为死亡。
5. 恢复仅支持精确的 v4 工程图程序身份、generation 1 / epoch 0、workspace + implement、独立 clone。业务结果从停止回执和动作契约重建，通过原 G15 结算接口提交；每次提交和释放前重新检查权限、库存、回执与文件。
6. 先持久化 applied 决定，再通过已有文件系统锁保护释放原 token，最后完成 admission 释放。若释放 ACK 丢失，新 host 可以确认这个已证明停止的旧动作已释放；发现后来取得的锁时拒绝删除它。

取消后保存的候选仍留在 `writer-0`，原仓库不变。它没有获得 ready/发布权限。恢复保留 G15 的保守计费下界：先前 unknown 的 observedTokens 若已提升到预留值，不会因后来获得较小 usage 而自动退还。

## 故障测试

新增独立 host 子进程夹具，使用真实受控 DeepSeek adapter、Graph worker、SQLite、Git clone、治理锁和公开 RPC。供应商 HTTP 响应是 fixture；本轮不是新的付费 API 试跑，真实 API 可用性沿用上一轮单独的 [DeepSeek 验收](graph-deepseek-live-validation.md)。

覆盖：账本提交前失败、提交成功但 ACK 失败、原 host 仍活着、API 断线、缺失 worker 退出记录、未来 template 版本、候选修改、日志修改/缺失、回执损坏、未追踪文件变化、软链接、权限撤销、G15 最终事务内撤权、并发对账、释放 ACK 丢失及后来取得的锁。成功案例断言模型只调用一次、动作数仍为 2、候选保留、原仓库不变、原锁释放、重复请求稳定且恢复决定仅各提交一次。

第一次新增字段使 review/tests 严格 envelope 拒绝未知字段，测试捕获后将 stopEvidenceRef 限定于 implement/repair。随后恢复测试发现 workspace 的停止标志在 Broker 返回时被丢弃，现已在验证宿主 handler 停止结果后保留。未放宽任何旧 envelope 的校验。

实际 OSStack Loop `G25-C2-bounded-recovery-1` 执行 1 次、跳过 0 次、结果 success：434 项相关测试通过（Core 75、Agents 83、CLI 135、Loop 141），全工作区构建及类型检查、schema freshness 与空白检查通过。程序版本修正后完整复跑恢复套件 16 项全部通过；其中 future-template 是额外新增用例，合计 435 个不同测试通过，不能将复跑次数当作新增覆盖。最终 CLI 重新构建通过。CLI 启动中位数 version 58 ms、help 178 ms，均在原预算内。

最终命令、测试数量、Loop 状态和审查原文保存在 [证据目录](../implementation/graph-bounded-recovery-evidence/admission.json)。未运行全仓 `pnpm test`，没有创建 PR、合并、推送或部署。

## Fable 审查

Claude CLI Fable 5.1 首先确认：停止回执到账本确认之间需要持久化恢复证据；原 host 死亡本身不能填补未观察到的 worker 退出日志。已明确保留后一个窗口，不伪造 stopped/orphaned 证明。

代码审查唯一要求修正的是程序版本绑定：未来模板沿用旧节点名时，不能套用旧版本硬编码结果。现已显式固定 engine/checkpoint/template 版本，并重算 compiler/registry/schema/program digest；不自动跟随将来的 template 升级。未来模板的完整子进程测试确认拒绝恢复。最终结论 **accept**，其要求的 future-template 测试和更广 Loop 验收均已通过；见证据目录中的复审原文。

## 剩余边界

- C2：无 worker 退出记录的突然崩溃需要另行验证 orphan worker 的能力边界或独立进程证明；不能靠 PID 查询、超时或租约过期冒充整个执行链停止。
- 更晚的 epoch、repair、review/tests、workspace 未确认窗口和不透明外部执行不在本次两动作恢复契约内。
- 恢复中间已有决定导致 revision 前进时，旧幂等 key 仅查询现状。调用者需读取最新 status，用当前 revision 和新 key 明确重试；不能让旧取消请求获得后来 generation 的权限。
- 候选指纹在 G15 最终事务内同步核验，可能持有 DB 写锁到读取完成；本轮没有完成 G28 共享数据库延迟验收。
- 原 G25-D 的 F01–F12 故障矩阵、G26-B 兼容、G27–G29 仍按计划验收。
