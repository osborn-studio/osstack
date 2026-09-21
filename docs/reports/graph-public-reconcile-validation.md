# G25-C1：公开取消对账

日期：2026-09-19。源码提交：`1893d09a845c0e2abdbd3eb392a184b0c89ee0e0`。本轮交付 `graph.reconcile` RPC 和 `osstack graph reconcile --request cancel.json`，复用已有 G15 no-child 恢复证明。完整 G25、真实内置 agent 后端和一般外部效果对账尚未完成。

## 可用行为

- 使用严格的 **CancelGraphRequest**，不是新的客户端证明协议；与 `graph.cancel` 共用取消意图的幂等键、scope 和业务摘要。只需要当前 cancel grant，不新增执行权限。
- 先记录取消意图，再核验。live supervisor 仍走实际取消信号链。无 supervisor 时不能推断 worker 死亡；只有全历史 generation 的持久 no-child 证据和全 run 无动作/admission/checkpoint 调度证据，才能经 G15 确认取消。
- 已经准入外部动作、持久 journal 缺失、无证据的代际、checkpoint 调度痕迹都不能走该证明。保留 `cancel_pending`、`delivery_unknown` 和现有资源占用；不创建替代 writer，不盲重放。
- 支持独立 SQLite 连接的新 host、新准入已关闭、adapter 不支持新图、执行期限及租约已过的取消核验。期限过期不算停止证明，也不阻止合法取消。
- 旧 key 仅在未变化的取消意图 revision 下重做核验。之后状态/代际变化只能查询原 key，重新核验需要当前 revision 和新 key。并发相同 key 只形成一次决策。
- 请求已持久受理后，核验冲突返回当前状态而不谎报拒绝。撤权仍阻止后续对账；G15 最终事务成功后才过期的授权不追溯否定成功应答。
- graceful close 等待未完成 RPC 对账访问，之后才能关闭 SQLite。

## Claude Fable 5.1 的挑战与处理

本轮实际调用 Claude CLI `--model claude-fable-5-1`，初审与复审均禁用工具、MCP、slash commands，不给模型执行或编辑权限。原始结果保留模型 usage；辅助 Haiku 记录不冒充主审查模型。

初审提出 **accept with required follow-ups**，不是无条件通过。主要问题是取消意图已经落库后，另一个 cancel 请求推进 revision，旧 proof snapshot 导致 RPC 返回拒绝；另一问题是 G15 提交后授权过期可能把成功取消改报拒绝。两者均修复，并新增确定性竞态与提交后过期测试。help 明确写 no-child evidence。

补验包括实际 live writer 取消、两个不同 key 的竞争、普通 cancel 在 pending 下重试不自动对账、模拟 host 在 generation 0 取消意图落库后丢失、未认证 daemon 调用、执行期限与 lease 均已过期。关于直接篡改 DB 改 generation 却不改 revision 的建议不作为合法迁移：GraphRunStore 的 generation 变更带 revision 前进。当前 proof 仍检查所有实际代际；不声称能对抗任意破坏可信 DB 的管理员。

第一轮扩大回归还发现上轮未覆盖的关闭测试夹具缺少 confirmStopped，导致在准入处提前结束。修正为会抛错的停止确认占位方法，确保任何真实 agent 调用仍使测试失败；没有放宽生产准入。

Fable 最终复审结论为 **accept**，原始意见完整保存。其保留的非阻塞限制：多 host 共享 DB 时 generation 0 的同步取消投影仍可能遇到 revision 竞争，返回冲突后须查询/重试；本轮没有宣称此既有分支的跨 host 应答始终一致。

最终模型原文与验证结果见[验收记录](../implementation/graph-public-reconcile-evidence/admission.json)。

## 证据与局限

使用显式隔离 OSSTACK_HOME，临时真实 Git 仓库、真实 daemon socket、真实 GraphRuntime 的注册失败及持久 no-child journal。新 host 测试打开同一持久 DB 的另一 SQLite 连接，不复用旧 service 的进程内控制对象。成功取消由实际 G15 决策落库验证；未知 agent 测试实际执行一次 writer 后拒绝停止确认，hold 保留。

开发过程中初始三个负面测试试图修改受 immutable trigger/约束保护的数据，测试准备失败；改为注入真实 journal 写失败、建立合法列结构的未观察代际以及推进测试时钟。之后才用于核验生产行为。保留首次 Loop 的关闭夹具失败及后续通过记录。

最终实际 OSStack Loop 执行 1、跳过 0，success；9 个相关测试文件 **109 项通过**，全仓类型、schema、whitespace 检查通过。CLI 启动中位数 version 29ms / help 80ms（预算 150/500ms）。

本轮仅改 5 个生产 TypeScript 文件，不增数据库迁移、依赖或协议版本。相关测试、全仓 typecheck、schema freshness、CLI 启动预算和 whitespace 检查均通过后才准入此切片；不把该结果称为完整全仓测试或完整 F01–F12 故障验收。

## 后续

**下一主任务：G25-B 真实受支持执行后端。** 随后补 G25-C2 已产生外部动作的独立停止/工作区/业务结果对账与精确释放，再关闭 G25-D 原始故障矩阵。详见[下一轮上下文](../implementation/2026-09-19-graph-reconcile-next-context.md)。父卡仍为 25/30；G25 和 G26 实施中，C1 完成不等于 G25 完成。
