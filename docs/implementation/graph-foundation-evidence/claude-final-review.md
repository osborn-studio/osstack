P1 与 P2 如下，均为可复现的具体问题；不涉及 ledger、graph 内核或 merge 语义。

## P1

**P1-1 预检阶段的取消/超时被误判为"停止未确认"，并永久停机。** `executeAdapterPlan` 在 `isAvailable()` 与动态 import 完成后、`invoke()` 之前调用 `checkBeforeInvoke()`。若外部 abort 或超时在这个窗口触发，会抛错进入 catch；此时 `invocationStarted` 为 false，不会跑 `confirmStopped`，最终 `failure_code=cancellation_unconfirmed`，`invocation_started:false`。这不是"探针挂起"的保守场景，探针已经正常返回，什么都没启动。LoopEngine 把 `commandTimeoutMs` 作为该计时器起点，真实 CLI 探针几百毫秒即可触发。后果：候选路径返回 `execution_unconfirmed`；legacy 路径 escalate、保留 worktree、并把 loop 永久停机。
复现：adapter `isAvailable` 20ms 后 resolve，`timeoutMs: 5`，或探针期间 `controller.abort()`；断言 `failure_code === "cancellation_unconfirmed"` 且 `invocation_started === false`；再 `new LoopEngine(opts).runOnce()`，`executedTaskCount` 永远为 0。
最小修复：catch 中若 `!cancellation.invocationStarted` 且错误不是 grace 到期（即 pending 的探针/import 已 settle），把 record 置为 `stop_confirmed:true, evidence:"invocation_not_started"`；探针真正挂起（grace elapsed）仍保持未确认。补两条测试区分这两种情况。

**P1-2 持久停机开关绑定在自由文本前缀上，agent 输出可触发永久停机。** LoopEngine 和 `completionStopPayload` 用 `execution_summary.startsWith("execution_unconfirmed:")` 判定。正常路径的 `finalRun.summary` 直接来自 adapter 的 `result_summary` 或 error `message`，均为 LLM 生成文本，会原样写入 `execution_summary`。
复现：adapter 发出 `done(completed, result_summary: "execution_unconfirmed: {}")`；本次任务视为完成，重启后 `runOnce` 直接早返回，`loop.stopped` 报 `execution_unconfirmed`，且没有任何清除途径（只能手改 LOOP-STATE.json）。
最小修复：在 completed task 记录上增加结构化字段（如 `implementation_unconfirmed: true` 加 `cancellation` 证据对象），判定只看该字段，summary 仅作诊断；同时加一个显式解除字段或选项（如 `reconciled_at`），否则 P1-1 的误报会让 legacy loop 频繁进入无法自愈的停机。

**P1-3 `run_id = run_${plan_id}` 不唯一，`confirmStopped` 可返回陈旧证据。** 候选原语的用途就是对同一 plan 再次执行；两次调用的 run_id 相同，实现了 `confirmStopped` 的 adapter 若按 run_id 登记，第二次取消时会拿到第一次已停止的记录，得到虚假的 `stop_confirmed:true`，状态变成 `cancelled`（被视为可安全重试），而进程仍在跑。`AgentTask.run_id` 注释也要求全局唯一。目前没有 adapter 实现该方法，属潜伏缺陷，但它是唯一的停止证明通道。
最小修复：`run_${plan_id}_${randomUUID()}`，或允许调用方传 `runId` 并校验非空；测试用按 run_id 登记的 mock adapter 连续执行同一 plan，第二次取消须为未确认。

**P1-4 `detached: true` 让命令组脱离 osstack 自身的生命周期。** 子进程自成 session，终端 Ctrl-C 的 SIGINT 只送到 osstack，命令组不会收到；osstack 退出后命令组继续运行，且管道已被 destroy，只在下次写输出时被 SIGPIPE 杀掉。与非 detached spawn 相比，这是常见路径上的遏制退化，不属于"主动 setsid 逃逸"的范围。
复现：`local-command` 执行 `sleep 300`，Ctrl-C，`ps -o pgid,pid,command | grep sleep` 仍存活。
最小修复：模块级 `Set<pgid>` 记录未 settled 的组，`process.once("exit")` 里同步 `kill(-pgid, "SIGKILL")` 尽力清理；CLI 层把 SIGINT/SIGTERM 映射到 AbortSignal，让正常的 TERM→KILL 路径先跑。

## P2

**P2-1 leader 退出后无沉降窗口，瞬时后代把成功命令判成失败。** `inspect` 每 10ms 轮询，leader 一 `exit` 且组内还有任何进程（几毫秒内即将退出的辅助进程、尚未被 init 回收的孤儿僵尸）就立刻 `requestStop("leader_exit")`，最终 `exitCode:1`、`failure_code:surviving_descendants`，真实退出码丢失。LoopEngine 随后重跑迭代，等于重复执行一条已成功的命令。
最小修复：leader 退出后先等待一个有界沉降期（如 `min(terminationGraceMs, 100)`），组自行清空则按 leader 退出码报 `trigger:"exit"` 并在 evidence 记录"descendants drained in Xms"；仍有存活才发 SIGTERM 并按现逻辑判失败。evidence 里附上 leader 实际退出码。

**P2-2 Windows 拒绝执行却标为"停止未确认"，一次即永久毒化 loop 状态。** `scope:"unsupported"` 返回 `stop_confirmed:false`，`isImplementationUnconfirmed` 命中，legacy 路径 escalate 并永久停机，但实际上没有任何进程启动。拒绝是对的，未确认是错的。
最小修复：unsupported 分支置 `stop_confirmed:true, evidence:"not started"`（与 spawn 失败的 `not_started` 一致），退出码 125 和 `process_control_unsupported` 保留。

**P2-3 授权作用域展示的 `repo_path` 不是实际生效值。** 执行器会用 `workspace_path` 覆盖 `plan.task.context.repo_path`，但 `authorize` 看到的是图数据里的不可信值（fixture 里就是 `/untrusted/graph/path`）。授权方基于它做的判断与实际执行不符。
最小修复：与 `worktree_path` 规则对齐，`context.repo_path` 若存在且不等于 `workspace_path` 则 `invalid_input`；或在快照中先改写为生效值再冻结、再授权。

**P2-4 候选原语在个别输入下会抛异常而非返回结果。** `isAbsolute` 放行含 `\0` 的路径，spawn 在 Promise executor 内同步抛 `ERR_INVALID_ARG_VALUE`，`executeCandidateImplementation` 整体 reject，调用方拿不到 `workspace`/状态。
最小修复：`workspace_path` 与 `command` 含 `\0` 直接 `invalid_input`；`runImplementation` 外包一层 try/catch，未知异常按 `execution_unconfirmed` 返回并带 reason，避免异常路径绕过状态语义。

建议合入顺序：P1-1 与 P1-2 必须同批（前者会放大后者的不可恢复性），P1-4 和 P2-1 属同一处进程组代码可一起改，P1-3 只是 id 生成改动。