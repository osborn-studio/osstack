# G25 第八阶段：完整 worker 代际清单与连续未启动恢复

源码 `096a03f0db825d508a2004477fbc55f548005698`。已补齐无动作中间 lease 的覆盖，并将连续启动前失败恢复接入真实 G15。**G00–G24 完成，25/30；G25 仍在实施中。**

## 实现

- `GraphRecoveryStore.inspectExecutors` 新增完整 `workers` 清单，按 generation 排序，覆盖未产生 action/admission 的历史代；拒绝数量、连续性、当前 owner 不一致。代次、owner、取得/到期时间进入 digest，`assertExecutorInventory` 在最终事务内检测无 run revision 变化的清单漂移。它本身不是停止证明。
- `verifyJournaledGraphWorkerNotStarted` 同步核验 scope/program/历史 owner、已消耗 launch、唯一严格 `spawn_failed` 事件及 acquire→intent→confirmed→observed→now 顺序；拒绝 journalError、额外事件、同代动作/admission/checkpoint request。不查询 PID、不发送信号，未观察启动窗口始终 unknown。
- `sweepGraphQuiescence` 核验清单中每一代，明确区分 stopped、not_started、unproven。任何代未证明则不访问 Docker。诊断报告仍为 `recoveryAuthorized=false`，不能转换为 G15 授权。
- `recoverUnstartedGraphWorker` 现在允许连续 no-child 代次；每一历史代必须独立验证 no-child，整个 run 的 action/admission/checkpoint/write/request 必须为空。当前授权由 reconciler 复验，G15 `BEGIN IMMEDIATE` 内重新核验完整 inventory、每代证明及全 run 无执行义务。实际启动过的 worker 不允许走此路径。入口仍是受信宿主内部方法，未新增公开 RPC 的自动重试。
- 没有数据库迁移、公共 RPC/schema 或 model API 变化；复用原有 G15 私有 attestation、lease/fence 与启动次数约束。

## 验证

真实 OSStack Loop `G25-worker-coverage-2`：执行 1、跳过 0、success，执行阶段 **112 项** focused 测试、5 项 verifier 通过。涵盖真实 OS spawn ENOENT、注册失败、子进程运行与退出；关闭旧 SQLite/宿主并以新连接及新 broker/checkpointer/runtime 验证连续两次 no-child 后第三代运行。历史 intent-only、已退出但确实启动过、事务内矛盾事件、撤权都拒绝接管。

固定 seed 250925/250926 矩阵 **556 次执行**，源码与构建产物哈希前后一致；workspace typecheck、schema freshness、CLI startup budget、diff whitespace 均通过。此轮 contained tests 使用受控 fake daemon，未重新运行 Linux Docker、全库测试或 Node 20/22 兼容验收，不沿用旧源码的真实 Docker 通过结论。

Kimi K3 (`kimi-code/k3`，实际 KimiCodeAdapter/no-tool profile) 审查 approved，4 项 judgments 通过；审查与验收 source hash 对齐。模型身份来自 adapter 运行报告。首次审查提醒确认新增真实 spawn 测试，现已通过；并指出 sweep 在双重证明均失败时只展示 exit-proof 错误，未展示 no-child 错误，仅影响诊断细节。修正类型夹具后重新提交完整代码供 Kimi 审查，原始输出和复审结果均保留。复审的 lease-expiry 注释意见经复核未采纳：租约过期不能充当证明，但不应阻止独立 no-child 凭据在过期后核验。详见证据目录 review-adjudication.md。

首轮 CLI focused 为 109 通过/2 失败：实际启动过的 worker 同时留下 checkpoint，新的全 run 无执行义务检查先触发，导致两条测试仍期待旧错误码。修正为接受两种安全拒绝原因并保留首次日志；重新验证 20 项恢复专项通过，之后新增真实 spawn ENOENT 正例，第一轮 Loop 的 112 项专项及 556 次矩阵均通过，但 workspace typecheck 拦下两个缺少必填 `pid: undefined` 的测试事件。保留 first-loop 全量证据，补齐两个测试字段、类型检查通过后，以新任务 ID 重跑完整 Loop 和 Kimi 审查；最终验收通过。没有修改生产逻辑或放宽恢复条件。

[机器准入、日志和复跑脚本](../implementation/graph-worker-coverage-evidence/admission.json)。显式隔离 OSSTACK_HOME/TMPDIR，未访问 serving DB，未启动/修改任何 Colima profile；未 merge/push/deploy。

## 尚待完成

非容器 host actions 与 opaque adapter 的持久停止凭据、未登记后代覆盖和独立 workspace 隔离证明；可信 descriptor/manifest 构建注册；已执行业务结果的 G15 对账、精确释放与重放；GraphDelivery cancel 的 workspace 引用及 takeover executor 引用；artifact 锁恢复。之后进入 G26–G29。
