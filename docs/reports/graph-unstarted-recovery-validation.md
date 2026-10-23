# G25 第二阶段：首次启动失败后的受管接管

日期：2026-09-16。**限定范围：第一代 worker 有持久 no-child 回执，且整个 run 从未准入执行器或产生调度状态。G25 保持 in_progress，25/30；不是任意崩溃恢复或生产发布准入。** 最终源码和验收结果见下方证据。

## 实现范围

`GraphRuntime.recoverUnstartedWorker(request, authorize)` 是 host-only 管理入口，复用 G15 `GraphReconciler`。新接管要求 generation=1、原始截止时间未到、替代租约不超过原始截止时间；进程日志必须有已消耗启动意图、恰好一个持久 spawn_failed 回执，且没有已启动身份。整个 run 的 action、admission、checkpoint、pending writes、checkpoint request 表必须为空。

G15 在事务提交前重新检查权限、身份、修订号和上述全部前提。通过后持久记录接管决策，切到下一代；新 host 再通过既有 worker 启动接口执行。没有信号发送、资源释放、artifact 删除，也没有公开 RPC 自动 resume。调用者必须是可信 host，提供当前同步授权；请求字段不能替代权限检查。

同时加固 core：即使可信调用者提交 not_started，如果没有持久启动意图及对应 no-child 事件，也拒绝。历史数据缺乏证据时保持 held，不能通过补造回执或租约过期升级为可恢复。

## 实际故障覆盖

- 独立 host 读同一持久 DB，原 host 被杀死或继续存活，两种情况都能从真实注册失败回执接管；新 worker 执行一次，旧 host 重试被拒绝。
- 消耗启动权后、spawn 前暂停或崩溃，以及实际 spawn 后、身份入库前崩溃，都缺乏 no-child 证明，保持 held，不能启动替代效果。
- 实际公开 submit 已提交 reservation、deferred driver 尚未构造：杀死或暂停原 host，新进程同 key 重放得到原 run；撤销 execute 权限后仍可按 cancel 权限取消。旧 host 继续后不构造执行器，独立进程再次读取仍为 cancelled；actions=0、launches=0、invocations=0。
- 撤权、异步授权、提交事务内撤权/出现 pending writes、并发接管、错 owner/program、超出原期限以及既存动作/调度状态均拒绝。

21 个新增测试（15 个 helper 场景、6 个真实子进程场景）加上 core 无持久证据的回归，纳入全库和固定 seed 矩阵。SIGSTOP/SIGKILL 只在测试夹具针对已知测试进程使用；产品恢复入口没有按数字 PID 发信号的接口。

## Kimi K3 审查

依用户最新要求，审查模型切换为 `kimi-code/k3`，通过现有 OSStack KimiCodeAdapter 的 no-tool 源码审查入口运行。设计审查提出的持久 launch 缺失漏洞已修复并保留 red/green 证据；补齐旧 host 存活和真实崩溃窗口。最终审查输入包含完整 worker manager，明确其原有 register 后、spawn 前再次检查权限，避免因设计材料遗漏而误判。

最终源码审查 **approved / No blockers**，两项 judgments 通过；runtime_identity 报告 provider=kimi、model_id=kimi-code/k3、evidence_source=reported。五表检查下沉建议是非阻断 warning；本批在 production verifier 内完成事务复核，未将首次启动专用规则扩大给所有恢复类型。原始响应和逐条裁决见 [审查裁决](../implementation/graph-unstarted-recovery-evidence/review-adjudication.md)。

## 验收结果

源码 `e94dfda29c2659a3c5720a6a6b4323c5189ac48a`。实际 OSStack Loop `G25-unstarted-recovery-acceptance-1`：executed=1、skipped=0、outcome=success。全库22个包、3,289测试全部通过，7项verifier全部通过。故障矩阵：112 loop, 65 core, 221 cli, 4 cli repeat，共402次测试执行；seed 250916/250917；源码与实际dist构建产物哈希均未变化。

verifier 包含全库类型检查、schema freshness、Saver 内核实验、Functional C2 实验、CLI 启动预算、固定 seed 故障矩阵、diff whitespace。CLI 启动中位数 --version 28ms / --help 77ms，分别低于150ms /500ms预算，各测5次。实验仍保留 StateGraph 反例，probe passed 不等于完整生产准入。平台仅 darwin / Node v26.5.0。

证据：[机器验收](../implementation/graph-unstarted-recovery-evidence/admission.json)、[完整Loop结果](../implementation/graph-unstarted-recovery-evidence/acceptance-result.json)、[矩阵与源码/产物哈希](../implementation/graph-unstarted-recovery-evidence/matrix.json)。

## 剩余工作

本批证明的是**执行器从未准入**，不证明曾启动的执行器已经停止。仍需实现新 supervisor 对运行过的 opaque adapter/脱离进程组后代的独立停止证明与受管恢复、更强 macOS 身份及真实 Linux 验证、artifact 残留锁管理恢复，以及完整 F01–F12 子窗口下的函数重入/confirmed 效果/logical join 三类计数。G26–G29 未开始。
