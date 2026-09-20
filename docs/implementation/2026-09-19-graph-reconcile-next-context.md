# G25 公开取消对账与下一步

后续已实现 G25-B1 受控后端，最新状态见 [2026-09-20 接续上下文](2026-09-20-graph-bounded-backend-next-context.md)。以下保留当时 C1 交接记录。

日期：2026-09-19。实施分支 `codex/graph-runtime-foundation`，工作区 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`。

本轮 G25-C1 将已有 G15 no-child 证明接到真实 `graph.reconcile` RPC 与 `osstack graph reconcile --request cancel.json`，并验证 daemon/CLI 路由。使用现有 CancelGraphRequest，操作含义限定为取消对账；没有把客户端 outcome、PID 或证据字符串作为权限。新图准入关闭、执行期限已过、内置 agent 不支持新图，都不妨碍具备 cancel grant 的旧 run 对账。

## 已交付边界

- 真实 worker 注册失败形成持久 spawn_failed/no-child 记录，新 host 从独立 SQLite 连接读取，跨全部历史 generation 验证没有动作、admission、checkpoint 调度证据；经 G15 最终事务确认取消。
- 旧 host 仍存在时也不推断其死亡；消费过的启动权和每代独立 no-child 证据才是依据。同 host 的 live cancel 信号链仍保留。
- 并发相同取消 key 只形成一条恢复决策。丢失应答重试继续使用原请求。
- 原取消请求只在 `cancel_pending && revision == expectedRevision + 1` 时继续核验；后来 revision/generation 的旧 key 只查询。新的核验须读取当前 revision、提交新取消 key。
- 未知外部动作、缺失 journal、无证据的代际、已存在 checkpoint 维持 cancel_pending/holds；不派生新 writer、不对 opaque 效果进行盲重发。
- 服务关闭等待正在进行的对账访问结束，再允许关闭数据库。

## 下一轮必须推进真实执行后端

下一主任务是 **G25-B：一个真实受支持的 writer/reviewer 组合及其明确停止边界**。先核验已有内置 CLI、工具权限和隔离设施的真实能力，复用 agent/Loop/仓库租约；不能只添加 `confirmStopped: true`，也不能把进程组不存在等同任意后代或远端效果结束。限定哪些副作用确实被监督并可证明停止；scope 不受支持时继续准入前拒绝。通过真实临时仓库修改、独立验证、取消和失败场景；文本审查调用不算 Graph 试点。

后续 **G25-C2** 才扩展已产生外部动作的对账：独立执行器/工作区证明、可信业务结果、G15 精确释放，不能把当前 no-child 分支扩张成通用安全保证。**G25-D** 将原 F01–F12 和 artifact 锁等验收逐项绑定业务测试。G26-B 继续兼容、旧 checkpoint 拒绝和备份恢复未知动作保留；其父验收依赖 G25。

25/30 父卡计数不变，G25/G26 实施中。本轮完成 C1，不表示 C2、真实后端或完整 G25 已验收。禁止重新把新一轮主任务退回内部 diagnostic helper 的泛化。

## 验证与审查

本轮继续用真实 Claude CLI `claude-fable-5-1` 审查；验证、模型原始返回、构建与 Loop 结果见[验收报告](../reports/graph-public-reconcile-validation.md)。所有命令使用专用 OSSTACK_HOME，不打开服务中的控制面 DB。用户原 AGENTS.md 保持原样；只有基线匹配的自有计划/指南与新报告镜像回原工作区。
