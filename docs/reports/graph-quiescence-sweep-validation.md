# G25 第七阶段：全量动作停止检查与精确容器清理

已实现 host-only `sweepGraphQuiescence`，源码提交 `355af3747870947a7b9ea628368e63249fb42c09`。它遍历完整历史 action/admission 清单，先核验当前代及动作所属代的持久直接 worker 退出，再按可信注册逐个检查 contained tests。**这是诊断/清理流程，不是恢复授权。G00–G24 完成，25/30；G25 仍 in_progress。**

## 行为与边界

- `inspect` 只核验；`stop_contained` 仅在当前 stop grant 有效、动作仍 held、完整 journal/manifest/容器身份一致时，调用既有精确停止接口。没有重新执行、标签搜索或批量删除。
- 所有 action 都出现在报告里。缺 admission、opaque/未注册执行器保持 unproven；settled/released 不作为物理停止证据。注册重复或指向其他动作在 Docker 调用前被拒绝。
- 原 `reopenGraphContainedTests` 默认 held 行为保持。新增 `read_only` 允许检查已释放动作的独立停止凭据，但始终拒绝 stop。清单中的 released 动作只能走此模式。
- 在执行器调用前后及其内部权限检查点，重新核验当前 run grant、完整 inventory 和 worker journal。权限、revision、无 revision 变化的 admission release、矛盾 worker 事件都会阻止后续操作。输入和可信回调先捕获，调用者后续修改不改变本次执行。
- 报告携带 inventory digest、逐代 worker 证据、逐动作结果及摘要引用。`allInventoriedExecutorsStopped` 仅描述清单内动作；`recoveryAuthorized=false`、`workspaceStatus=unproven`、`workerDescendantsStatus=unproven` 恒定。报告对象不能替代 G15 verifier，也没有最终事务 attestation 能力。

## 实际验收

真实 OSStack Loop `G25-quiescence-sweep-1`：执行 1、跳过 0、outcome=success，5 项 verifier 全通过。执行阶段使用专用 Linux Docker daemon 的 **20 项 sweep 专项测试**，同文件另 32 项未选中，未将 skipped 计为通过。包含两个独立容器/不同物理回执、孤儿容器精确删除、released 只读、缺回执不推断停止、当前/历史代绑定、异步边界撤权与清单变化。一个实际新 Node 进程重开 SQLite、重新连接 daemon 后生成与原进程完全相同的报告。

固定 seed 250924/250925 故障矩阵共 **532 次执行**，1072 个源文件及构建产物前后哈希一致；当前新 helper 的 52 项测试包含其中。其他通过项为 workspace typecheck、schema freshness、CLI startup budget 和 diff whitespace。这里没有重新声称全库测试、Node 20/22 或全 Linux 原生支持。

真实 `KimiCodeAdapter` + no-tool review profile 使用 `kimi-code/k3`，approved、5 条 judgments 全通过。输入与输出 source hash 和验收源码一致。唯一非阻断信息：代际集合来自当前 run 加动作所属代，不额外枚举没有动作/admission 的中间 lease；未登记后代仍明确 unproven。接入全图恢复时必须补齐这个范围。

首次新增测试的跨代 fault injection 因漏填数据库要求的 stopped_worker_json 而失败（47 通过/1 失败）；修正 fixture，写入真实前代退出证明后通过。失败日志保留。最终 Loop 首次完整验收通过，没有改写失败记录或重跑已通过全库测试。

[机器证据与复跑 harness](../implementation/graph-quiescence-sweep-evidence/admission.json)。使用独立 OSSTACK_HOME/TMPDIR，测试未访问 serving DB。专用 Colima profile 已停止，零遗留测试容器，默认 context 不变。

## 下一段实现

1. 为非容器动作定义实际 host/adapter 停止或持久 no-start 凭据，工作区独立隔离证明也必须可核验。不要提供一个接收 model 布尔值/字符串的通用 verifier。
2. 从可信 descriptor、candidate manifest 与 ledger 构建注册，补齐无动作中间代/未登记后代范围。将诊断结果转成 G15 所需的受信宿主 attestation，需要同步最终重验闭包；现有报告不能直接充当 proof。
3. 用完整可信结果 envelope 核验业务 applied/not_applied/unknown，之后按 G15 完成精确资源与 DB admission release、失联 ACK 重验、跨代义务及接管。容器被删除不表示业务成功。
4. 补 artifact 锁管理恢复与其余 F01–F12 子窗口，再做 G26–G29 共存、发行、性能与真实内部 LLM 试点。此前取消 workspace 引用复用和 takeover 引用一致性问题仍保留。
