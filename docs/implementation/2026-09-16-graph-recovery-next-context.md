# G25 接续：从 no-child 接管到已启动执行器的独立恢复

**G00–G24 已完成，25/30；G25 in_progress，G26–G29 未开始。** 本批报告：[首次启动失败恢复验收](../reports/graph-unstarted-recovery-validation.md)。

## 工作区和模型

- 实施分支 `codex/graph-runtime-foundation`，路径 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`。
- 原 checkout `/Volumes/AIMATE_WORK/Developer/CodeX/osstack` 只镜像本任务文档；保留 AGENTS.md 等用户改动，不在原 checkout stage/commit。
- 用户最新指令 **use kimi k3 instead of claude opus 5 for auditing**，覆盖此前 Opus 偏好。使用真实 `KimiCodeAdapter({model:'kimi-code/k3', reviewAgentFile: .../kimi-review-agent.md})`；profile tools=[]，不让审查者修改源码。核查最终事件 review.runtime_identity 中实际 reported model，不把配置或 readiness 当审查通过。
- 真实 OSStack Loop 验收：独立 home/state、新 taskId、sources=[]、显式 inputTasks、skipCompletedTasks=false；检查 executed/skipped/outcome。开发 CLI 不得连接默认或保留控制面 DB。不得自动 merge/push/部署。

## 本批变化

新增 host-only `recoverUnstartedWorker`，只允许第一代、持久且不矛盾的 no-child 回执，加整个 run 从无 action/admission/checkpoint/request 的证明，通过 G15 同步事务复核后接管。没有 executor 停止/信号/资源释放能力。原 deadline 不刷新。core 不再接受缺少 durable launch 的 not_started。

真实子进程覆盖注册失败后的 killed/alive 旧 host、public submit 提交到 deferred construction 的 killed/alive 窗口、consumed-before-spawn 与 spawn-before-identity 窗口。后两者都拒绝接管；public replay/cancel 保留原 run且零效果。验证矩阵已经加入这两个新测试文件。

源码 `e94dfda29c2659a3c5720a6a6b4323c5189ac48a`。实际 OSStack Loop `G25-unstarted-recovery-acceptance-1`：executed=1、skipped=0、outcome=success。全库22个包、3,289测试全部通过，7项verifier全部通过。故障矩阵：112 loop, 65 core, 221 cli, 4 cli repeat，共402次测试执行；seed 250916/250917；源码与实际dist构建产物哈希均未变化。 实际 Kimi K3 源码审查 approved，无阻断问题；详见 [机器验收](graph-unstarted-recovery-evidence/admission.json)与[审查裁决](graph-unstarted-recovery-evidence/review-adjudication.md)。

## 下一步

1. 为一个实际可控制的 executor 定义并实现跨 supervisor 重建的身份、隔离与独立停止证明，再经 G15 验证受管恢复。不能把本批 executor absence 推广为 executor stopped。opaque adapter 不具备证明能力时继续 unknown/held。
2. 更强 macOS 身份或受控隔离后端，并在实际 Linux 环境运行；机器上 Docker/Colima 命令存在不等于有运行环境，本批未启动或安装 VM。
3. artifact 残留锁管理恢复：精确绑定 owner、candidate、动作/对账结果，不按锁年龄直接清除。
4. 补齐 F01–F12 子窗口以及同一场景的函数重入、已确认效果、logical join 三种计数。当前 coverage 只是关联测试集合。
5. 满足上述条件后才能完成 G25，再推进兼容 G26、发行 G27、性能 G28、真实试点 G29。

公开 RPC 在缺少 live supervisor 时的一般 resume 拒绝保持原样；不能为了“可恢复”允许换 attempt/key 绕过未知动作。
